import type { ReplayChunk, Submission } from './types.js';

export interface IngestClientOptions {
  /** Base URL of the ingest API, e.g. https://ingest.example.com */
  endpoint: string;
  projectId: string;
  /** Injected so native bridges and tests can supply their own transport. */
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. The queue owns retries; this only bounds one call. */
  timeoutMs?: number;
  /**
   * SPEC-174: base64url-encoded HMAC signing secret. When set, every request is
   * signed (`x-susa-signature` + `x-susa-timestamp`) over
   * `v1\n<ts>\n<METHOD>\n<path>\n<sha256(body)>`, so a project in `required` mode
   * accepts it and rejects unsigned writes. A secret shipped in a browser bundle
   * is extractable — this raises the bar, it is not a substitute for the
   * server-side corroboration guard. For a real secret, mint short-lived tokens
   * on your backend instead.
   */
  ingestSecret?: string;
  /** WebCrypto provider. Defaults to globalThis.crypto (browsers, Node 16+). */
  cryptoImpl?: CryptoLike;
  /** Clock in unix seconds; injectable for tests. */
  now?: () => number;
}

// Minimal structural view of the WebCrypto surface this file uses, so the core
// package does not need the DOM lib (it also runs under Node / native bridges).
interface SubtleLike {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: Uint8Array,
    algorithm: { name: string; hash: string },
    extractable: boolean,
    keyUsages: string[],
  ): Promise<unknown>;
  sign(algorithm: string, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
interface CryptoLike {
  subtle: SubtleLike;
}

function base64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
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
  private readonly secretBytes?: Uint8Array;
  private readonly crypto: CryptoLike | undefined;
  private readonly now: () => number;
  private hmacKey?: Promise<unknown>;

  constructor(options: IngestClientOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.projectId = options.projectId;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.crypto = options.cryptoImpl ?? (globalThis as { crypto?: CryptoLike }).crypto;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));

    if (options.ingestSecret) {
      if (!this.crypto?.subtle) {
        throw new Error('ingestSecret is set but WebCrypto (crypto.subtle) is unavailable');
      }
      this.secretBytes = base64urlToBytes(options.ingestSecret);
    }

    const f = options.fetchImpl ?? globalThis.fetch;
    if (!f) {
      throw new Error('No fetch implementation available; pass options.fetchImpl');
    }
    // Unbound fetch throws "Illegal invocation" in browsers.
    this.fetchImpl = f.bind(globalThis);
  }

  /**
   * SPEC-174 signature headers for one request, or {} when no secret is set.
   * The canonical string and hex encoding match the server (signing.py) and the
   * Android/iOS signers byte-for-byte — pinned by a shared known-answer vector.
   */
  private async signHeaders(
    method: string,
    path: string,
    body: string,
  ): Promise<Record<string, string>> {
    if (!this.secretBytes || !this.crypto?.subtle) return {};
    const enc = new TextEncoder();
    const bodyHash = toHex(new Uint8Array(await this.crypto.subtle.digest('SHA-256', enc.encode(body))));
    const ts = String(this.now());
    const canonical = `v1\n${ts}\n${method}\n${path}\n${bodyHash}`;
    if (!this.hmacKey) {
      this.hmacKey = this.crypto.subtle.importKey(
        'raw', this.secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
      );
    }
    const sig = toHex(new Uint8Array(
      await this.crypto.subtle.sign('HMAC', await this.hmacKey, enc.encode(canonical)),
    ));
    return { 'x-susa-timestamp': ts, 'x-susa-signature': `v1=${sig}` };
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

  /**
   * Ships a batch of analytics events.
   *
   * One request per batch rather than per event: analytics volume is orders of
   * magnitude above reports, and a request per event would swamp both the
   * device's radio and the ingest service.
   */
  async sendEvents(body: string): Promise<void> {
    await this.post('/v1/events', body, {});
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
      const signHeaders = await this.signHeaders('POST', path, body);
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-project-id': this.projectId,
          ...extraHeaders,
          ...signHeaders,
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
