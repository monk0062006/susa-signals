import type { ConsentManager } from './consent.js';
import { uuid } from './id.js';
import type { DeviceContext, Reporter } from './types.js';

/**
 * Product analytics.
 *
 * Deliberately does NOT use the durable outbox that carries bug reports and
 * research responses. Those are irreplaceable — a person typed them — so they
 * persist before every network call and retry for days. Analytics events are
 * the opposite: individually worthless, valuable only in aggregate, and
 * produced hundreds of times more often. Putting them through the same queue
 * would exhaust the device's storage quota and evict the reports that queue
 * exists to protect.
 *
 * So events batch in memory, flush on a timer or when the batch fills, and are
 * dropped on overflow. Losing a page-view is a rounding error; losing a bug
 * report is a lost customer conversation.
 */

export interface AnalyticsEvent {
  /** Client-generated, so retried batches can be deduped server-side. */
  id: string;
  name: string;
  properties?: Record<string, string | number | boolean | null>;
  /** Stable id for the person, when the host app has identified them. */
  userId?: string;
  /** Groups events from one app session; distinct from a replay session. */
  sessionId: string;
  timestamp: number;
}

export interface AnalyticsTransport {
  sendEvents(events: AnalyticsEvent[], device: DeviceContext): Promise<void>;
}

export interface AnalyticsOptions {
  /** Events per batch. Reached-size triggers an immediate flush. */
  batchSize?: number;
  /** Flush cadence in ms, for traffic too slow to fill a batch. */
  flushIntervalMs?: number;
  /**
   * Ceiling on the in-memory buffer. Beyond this the OLDEST events are dropped:
   * during an outage, recent behaviour is more useful than stale behaviour.
   */
  maxBuffered?: number;
}

const DEFAULTS = {
  batchSize: 25,
  flushIntervalMs: 15_000,
  maxBuffered: 500,
} as const;

export class Analytics {
  private buffer: AnalyticsEvent[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private userId: string | undefined;
  private readonly sessionId = uuid();
  private readonly options: Required<AnalyticsOptions>;
  private started = false;

  constructor(
    private readonly transport: AnalyticsTransport,
    private readonly consent: ConsentManager,
    private readonly device: () => Promise<DeviceContext>,
    options: AnalyticsOptions = {},
    private readonly log: (message: string) => void = () => {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Begins periodic flushing. Safe to call more than once. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
  }

  /**
   * Records an event.
   *
   * Consent is checked at flush rather than here so the gate cannot be bypassed
   * by a grant arriving between buffering and sending — and so a revocation
   * discards everything still buffered.
   */
  track(name: string, properties?: AnalyticsEvent['properties']): void {
    if (!name) return;

    const event: AnalyticsEvent = {
      id: uuid(),
      name: name.slice(0, 200),
      sessionId: this.sessionId,
      timestamp: Date.now(),
    };
    if (properties) event.properties = properties;
    if (this.userId) event.userId = this.userId;

    this.buffer.push(event);

    // Drop oldest, not newest: during an outage the recent past explains what
    // the user is doing now far better than the distant past.
    while (this.buffer.length > this.options.maxBuffered) this.buffer.shift();

    if (this.buffer.length >= this.options.batchSize) void this.flush();
  }

  /** Associates subsequent events with a person. */
  identify(user: Reporter | string): void {
    this.userId = typeof user === 'string' ? user : (user.externalId ?? user.email);
  }

  /**
   * Sends whatever is buffered.
   *
   * Never throws: analytics failing must not surface into the host app, and a
   * failed batch is discarded rather than retried — retrying would grow the
   * buffer during exactly the outage that caused the failure.
   */
  async flush(): Promise<{ sent: number }> {
    if (this.buffer.length === 0) return { sent: 0 };

    // The gate. Without an analytics grant, buffered events are discarded, not
    // held — holding them would mean transmitting later on a consent that was
    // never given for the moment they were captured.
    if (!(await this.consent.has('analytics'))) {
      const discarded = this.buffer.length;
      this.buffer = [];
      this.log(`analytics: discarded ${discarded} event(s), no consent`);
      return { sent: 0 };
    }

    // Swap before awaiting so events tracked during the request land in the
    // next batch rather than being lost or double-sent.
    const batch = this.buffer;
    this.buffer = [];

    try {
      await this.transport.sendEvents(batch, await this.device());
      return { sent: batch.length };
    } catch (err) {
      this.log(`analytics: dropped ${batch.length} event(s): ${
        err instanceof Error ? err.message : 'error'
      }`);
      return { sent: 0 };
    }
  }

  /** Stops the timer and flushes once. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.started = false;
    await this.flush();
  }

  /** Discards buffered events without sending. Used when consent is withdrawn. */
  discard(): void {
    const dropped = this.buffer.length;
    this.buffer = [];
    if (dropped > 0) this.log(`analytics: discarded ${dropped} buffered event(s)`);
  }

  /** Exposed for tests and diagnostics. */
  buffered(): number {
    return this.buffer.length;
  }

  getSessionId(): string {
    return this.sessionId;
  }
}
