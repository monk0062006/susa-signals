import {
  type ConsentManager,
  type IngestClient,
  type ReplayChunk,
  uuid,
} from '@markerio-usa/core';
/**
 * rrweb is the single largest dependency in this SDK, and session replay is
 * opt-in twice over: the host app must enable it AND the user must have granted
 * consent. Loading it eagerly makes every visitor of every customer's site
 * download a recorder that, for most of them, will never run.
 *
 * Imported dynamically so it is code-split and fetched only once recording
 * actually starts — which is after the consent gate, not before.
 */
type RecordFn = typeof import('rrweb').record;

let rrwebPromise: Promise<RecordFn> | undefined;

function loadRecorder(): Promise<RecordFn> {
  rrwebPromise ??= import('rrweb').then((mod) => mod.record);
  return rrwebPromise;
}

/**
 * Chunk ceiling. `fetch(keepalive: true)` — the only way to get the final chunk
 * out during page teardown — is capped at 64KB by the browser. Staying under it
 * is what stops every session from losing its ending.
 */
const MAX_CHUNK_BYTES = 48 * 1024;
const FLUSH_INTERVAL_MS = 5_000;

/**
 * Hard ceiling on a single session. Without it, a tab left open overnight
 * streams unbounded data at both the user's bandwidth and your storage bill.
 */
const MAX_SESSION_EVENTS = 20_000;

export interface ReplayOptions {
  /**
   * Extra CSS selectors whose text is replaced with asterisks. Applied on top of
   * the built-in defaults, never instead of them.
   */
  maskTextSelectors?: string[];
  /** Selectors excluded from the recording entirely (element becomes a placeholder). */
  blockSelectors?: string[];
  /**
   * Record <canvas> contents. Off by default: it is expensive and canvases
   * frequently contain exactly the customer data that should not be recorded.
   */
  recordCanvas?: boolean;
}

/**
 * Selectors masked unless the host app opts out.
 *
 * The default is "mask it" rather than "record it". A recorder that captures
 * everything until someone remembers to exclude the password field will
 * eventually ship a password to your servers — the failure is silent, permanent,
 * and discovered by a customer. Inverting the default makes the failure mode
 * "we recorded less than we could have", which is recoverable.
 */
const DEFAULT_MASK_SELECTORS = [
  '[data-private]',
  '[data-sensitive]',
  '.markerio-mask',
  // Common field names across form libraries.
  'input[type="password"]',
  'input[name*="card" i]',
  'input[name*="cvv" i]',
  'input[name*="ssn" i]',
  'input[autocomplete*="cc-" i]',
];

export class ReplayRecorder {
  private stopFn: (() => void) | undefined;
  private buffer: unknown[] = [];
  private bufferedBytes = 0;
  private seq = 0;
  private eventCount = 0;
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sessionId: string | undefined;
  private stopped = false;

  constructor(
    private readonly client: IngestClient,
    private readonly consent: ConsentManager,
    private readonly projectId: string,
    private readonly options: ReplayOptions = {},
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** The id linking this session to any report filed during it. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Starts recording, or does nothing if consent is absent.
   *
   * Returns the session id on success and undefined otherwise, so callers can
   * tell "recording" from "silently not recording" — a distinction that matters
   * when a researcher is waiting on data that will never arrive.
   */
  async start(): Promise<string | undefined> {
    if (this.stopFn) return this.sessionId;

    // The gate. Never record without an explicit, current grant.
    if (!(await this.consent.has('session_replay'))) {
      this.log('replay not started: no session_replay consent');
      return undefined;
    }

    // Fetched only after the consent gate above has passed.
    const record = await loadRecorder();

    this.sessionId = uuid();
    this.startedAt = Date.now();
    this.stopped = false;

    const maskSelectors = [...DEFAULT_MASK_SELECTORS, ...(this.options.maskTextSelectors ?? [])];

    const recordOptions: Parameters<typeof record>[0] = {
      emit: (event: unknown) => this.onEvent(event),
      // Every input is masked unless explicitly unmasked. See DEFAULT_MASK_SELECTORS.
      maskAllInputs: true,
      maskTextSelector: maskSelectors.join(','),
      recordCanvas: this.options.recordCanvas ?? false,
      // Throttle high-frequency signals; full-fidelity mouse data is not worth
      // the payload for research use.
      sampling: { mousemove: 50, scroll: 150, input: 'last' },
    };
    // Assigned conditionally: exactOptionalPropertyTypes rejects an explicit
    // undefined, and rrweb treats an absent selector differently from an empty one.
    const blockSelector = this.options.blockSelectors?.join(',');
    if (blockSelector) recordOptions.blockSelector = blockSelector;

    this.stopFn = record(recordOptions);

    this.timer = setInterval(() => void this.flush(false), FLUSH_INTERVAL_MS);

    // `visibilitychange` rather than `unload`: unload does not fire reliably on
    // mobile Safari, which is precisely where sessions end by app-switching.
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    this.log(`replay started (session ${this.sessionId})`);
    return this.sessionId;
  }

  /** Stops recording and flushes the tail as the final chunk. */
  async stop(): Promise<void> {
    if (!this.stopFn) return;
    this.stopped = true;

    this.stopFn();
    this.stopFn = undefined;

    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    await this.flush(true);
    this.log('replay stopped');
  }

  /**
   * Stops recording and discards anything not yet sent. Called when consent is
   * withdrawn — at which point buffered data must not be transmitted.
   */
  async abandon(): Promise<void> {
    this.stopped = true;
    this.stopFn?.();
    this.stopFn = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);

    this.buffer = [];
    this.bufferedBytes = 0;
    this.log('replay abandoned; buffered events discarded');
  }

  private onVisibilityChange = (): void => {
    // Hidden may be the last callback we get before the tab is discarded.
    if (document.visibilityState === 'hidden') void this.flush(false);
  };

  private onEvent(event: unknown): void {
    if (this.stopped) return;

    this.eventCount++;
    if (this.eventCount > MAX_SESSION_EVENTS) {
      this.log('replay hit session event cap; stopping');
      void this.stop();
      return;
    }

    this.buffer.push(event);
    // Approximate rather than exact: serializing every event twice to measure it
    // would cost more than the precision is worth.
    this.bufferedBytes += estimateSize(event);

    if (this.bufferedBytes >= MAX_CHUNK_BYTES) void this.flush(false);
  }

  private async flush(final: boolean): Promise<void> {
    if (!this.sessionId) return;
    if (this.buffer.length === 0 && !final) return;

    const events = this.buffer;
    // Swap the buffer before awaiting, so events emitted during the request
    // land in the next chunk instead of being lost or double-sent.
    this.buffer = [];
    this.bufferedBytes = 0;

    const chunk: ReplayChunk = {
      sessionId: this.sessionId,
      projectId: this.projectId,
      seq: this.seq++,
      events,
      startedAt: this.startedAt,
      endedAt: Date.now(),
      final,
    };

    try {
      await this.client.sendReplayChunk(chunk);
    } catch (err) {
      // Replay is explicitly best-effort: dropped rather than retried. Persisting
      // it would compete with the report queue for storage, and a gap in a replay
      // is far cheaper than losing a report the user actually wrote.
      this.log(`replay chunk ${chunk.seq} dropped: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
}

/** Cheap byte estimate: UTF-16 string length is a close enough proxy. */
function estimateSize(event: unknown): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 512;
  }
}
