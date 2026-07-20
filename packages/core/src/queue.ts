import type { IngestClient } from './client.js';
import { IngestError } from './client.js';
import type { KeyValueStore } from './platform.js';
import type { Submission } from './types.js';

const STORAGE_KEY = 'markerio.queue.v1';
const MAX_QUEUED = 20;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
/** Ceiling so a long-queued item still retries a few times a day. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

interface QueuedReport {
  report: Submission;
  attempts: number;
  /** Epoch ms before which this item must not be retried. */
  nextAttemptAt: number;
}

/**
 * Durable outbox for user-initiated submissions.
 *
 * The whole point of this SDK is capturing bugs, and bugs cluster in exactly the
 * conditions that break uploads — flaky staging networks, VPNs, a backend that is
 * itself the thing being reported. So a submission is persisted before any network
 * call and only removed once the server has acknowledged it.
 *
 * Retries are scheduled per item with exponential backoff rather than counted per
 * flush. Without that, filing several reports during one outage burns every queued
 * item's attempt budget within seconds — the queue would discard reports minutes
 * into an outage it was built to survive for days. This mirrors the Android
 * implementation exactly; the two must not drift.
 *
 * Replay chunks never enter this queue: they are orders of magnitude larger and
 * would evict the hand-written reports this exists to protect.
 */
export class ReportQueue {
  constructor(
    private readonly storage: KeyValueStore,
    private readonly client: IngestClient,
    /** Injectable for tests. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Persist immediately, then attempt delivery. Never throws on network failure. */
  async enqueue(report: Submission): Promise<void> {
    const queue = await this.read();
    queue.push({ report, attempts: 0, nextAttemptAt: 0 });

    // Drop oldest on overflow: a stale report is worth less than the fresh one
    // the user just took the trouble to write.
    while (queue.length > MAX_QUEUED) queue.shift();

    await this.write(queue);
    await this.flush();
  }

  /** Attempt delivery of everything due. Safe to call on app start. */
  async flush(): Promise<{ sent: number; remaining: number }> {
    const queue = await this.read();
    if (queue.length === 0) return { sent: 0, remaining: 0 };

    const currentTime = this.now();
    const remaining: QueuedReport[] = [];
    let sent = 0;

    for (const item of queue) {
      // Not yet due. Skipping is what stops rapid flushes from consuming the
      // retry budget of items that have not had a fair chance to succeed.
      if (currentTime < item.nextAttemptAt) {
        remaining.push(item);
        continue;
      }

      try {
        await this.client.submit(item.report);
        sent++;
      } catch (err) {
        item.attempts++;

        const permanent = err instanceof IngestError && !err.retryable;
        // Drop permanently-rejected reports and ones we have given up on, so a
        // single poison report cannot block the queue behind it forever.
        if (!permanent && item.attempts < MAX_ATTEMPTS) {
          item.nextAttemptAt = currentTime + backoffFor(item.attempts);
          remaining.push(item);
        }
      }
    }

    await this.write(remaining);
    return { sent, remaining: remaining.length };
  }

  async size(): Promise<number> {
    return (await this.read()).length;
  }

  private async read(): Promise<QueuedReport[]> {
    try {
      const raw = await this.storage.get(STORAGE_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];

      // Tolerate items written by an older SDK that predates backoff scheduling.
      return (parsed as QueuedReport[]).map((item) => ({
        ...item,
        nextAttemptAt: typeof item.nextAttemptAt === 'number' ? item.nextAttemptAt : 0,
      }));
    } catch {
      // Corrupt storage must not brick the SDK; start clean.
      return [];
    }
  }

  private async write(queue: QueuedReport[]): Promise<void> {
    try {
      await this.storage.set(STORAGE_KEY, JSON.stringify(queue));
    } catch {
      // Quota exceeded or private-mode storage. Delivery still works in-memory;
      // only cross-reload durability is lost, which is not worth crashing over.
    }
  }
}

/** 30s, 1m, 2m, 4m … capped at 6h. */
function backoffFor(attempts: number): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 20);
  return Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);
}
