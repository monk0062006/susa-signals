import type { ReplayChunk, Submission } from './types.js';

export interface IngestClientOptions {
  /** Base URL of the ingest API, e.g. https://ingest.example.com */
  endpoint: string;
  projectId: string;
  /** Injected so native bridges and tests can supply their own transport. */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. The queue owns retries; this only bounds one call. */
  timeoutMs?: number;
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** Whether a retry could plausibly succeed. 4xx is not retryable. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

export class IngestClient {
  private readonly endpoint: string;
  private readonly projectId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: IngestClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.projectId = options.projectId;
    this.timeoutMs = options.timeoutMs ?? 15_000;

    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) {
      throw new Error('No fetch implementation available; pass options.fetchImpl');
    }
    // Unbound fetch throws "Illegal invocation" in browsers.
    this.fetchImpl = f.bind(globalThis);
  }

  async submit(submission: Submission): Promise<void> {
    await this.post('/v1/reports', JSON.stringify(submission), {
      // Lets the server dedupe submissions replayed by the offline queue.
      'idempotency-key': submission.id,
    });
  }

  /**
   * Ships one slice of a recorded session.
   *
   * Uses `keepalive` so the final chunk still goes out while the page is being
   * torn down — otherwise every session would lose its ending, which is exactly
   * the part a researcher wants (where did the user give up?). The 64KB browser
   * limit on keepalive bodies is why the recorder caps chunk size.
   */
  async sendReplayChunk(chunk: ReplayChunk): Promise<void> {
    await this.post('/v1/replay/chunks', JSON.stringify(chunk), {}, chunk.final);
  }

  private async post(
    path: string,
    body: string,
    extraHeaders: Record<string, string>,
    keepalive = false,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-project-id': this.projectId,
          ...extraHeaders,
        },
        body,
        signal: controller.signal,
      };
      if (keepalive) init.keepalive = true;

      const res = await this.fetchImpl(`${this.endpoint}${path}`, init);

      if (!res.ok) {
        // 408/429 are client-status but genuinely transient.
        const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
        throw new IngestError(`Ingest failed with ${res.status}`, res.status, retryable);
      }
    } catch (err) {
      if (err instanceof IngestError) throw err;
      // Network failure or abort: no response reached us, so a retry is worth it.
      throw new IngestError(
        err instanceof Error ? err.message : 'Network error',
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
