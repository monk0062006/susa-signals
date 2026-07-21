import type { LogEntry, LogLevel, NetworkEntry } from '@susa/signals-core';

const MAX_LOGS = 100;
const MAX_REQUESTS = 50;

/** Bounded ring buffer — an SDK that grows without limit in a long-lived tab is a leak. */
class RingBuffer<T> {
  private items: T[] = [];
  constructor(private readonly limit: number) {}

  push(item: T): void {
    this.items.push(item);
    if (this.items.length > this.limit) this.items.shift();
  }

  snapshot(): T[] {
    return [...this.items];
  }
}

/**
 * Captures console and network activity leading up to a bug report.
 *
 * Both hooks wrap globals, which is intrusive, so two rules hold throughout:
 * the original is always called, and a throw inside our bookkeeping can never
 * escape into the host app. A feedback SDK that breaks the page it observes is
 * worse than no SDK.
 */
export class WebInstrumentation {
  private readonly logs = new RingBuffer<LogEntry>(MAX_LOGS);
  private readonly requests = new RingBuffer<NetworkEntry>(MAX_REQUESTS);
  private installed = false;
  private restore: Array<() => void> = [];

  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.hookConsole();
    this.hookFetch();
  }

  /** Restores every patched global. Required for SPA teardown and tests. */
  uninstall(): void {
    for (const undo of this.restore.reverse()) undo();
    this.restore = [];
    this.installed = false;
  }

  getLogs(): LogEntry[] {
    return this.logs.snapshot();
  }

  getRequests(): NetworkEntry[] {
    return this.requests.snapshot();
  }

  private hookConsole(): void {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

    for (const level of levels) {
      const original = console[level] as ((...args: unknown[]) => void) | undefined;
      if (typeof original !== 'function') continue;

      console[level] = (...args: unknown[]): void => {
        try {
          this.logs.push({
            level,
            message: args.map(stringify).join(' '),
            timestamp: Date.now(),
          });
        } catch {
          // Never let capture break logging.
        }
        original.apply(console, args);
      };

      this.restore.push(() => {
        console[level] = original;
      });
    }
  }

  private hookFetch(): void {
    const original = globalThis.fetch;
    if (typeof original !== 'function') return;

    globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const started = Date.now();
      const method = init?.method ?? 'GET';
      const url = requestUrl(input);

      try {
        const res = await original.call(globalThis, input, init);
        this.record({ method, url, status: res.status, started });
        return res;
      } catch (err) {
        // Record the failure too — a request that never completed is often
        // precisely the bug being reported.
        this.record({ method, url, started });
        throw err;
      }
    };

    this.restore.push(() => {
      globalThis.fetch = original;
    });
  }

  private record(args: { method: string; url: string; status?: number; started: number }): void {
    try {
      const entry: NetworkEntry = {
        method: args.method,
        url: args.url,
        durationMs: Date.now() - args.started,
        timestamp: args.started,
      };
      if (args.status !== undefined) entry.status = args.status;
      this.requests.push(entry);
    } catch {
      // Bookkeeping must never surface to the caller.
    }
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular structures are common in framework objects.
    return String(value);
  }
}
