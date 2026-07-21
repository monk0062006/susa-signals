import type { NextFunction, Request, Response } from 'express';
import type { Metrics } from './observability.js';

/**
 * Per-project token buckets.
 *
 * The central decision here is that traffic classes get **separate budgets**.
 * Analytics events and replay chunks outnumber bug reports by orders of
 * magnitude, so a single shared limit means a chatty analytics integration
 * silently starves the reports — the one payload a human typed and cannot
 * reproduce. Dropping a page-view is free; dropping a bug report is not.
 *
 * Token bucket rather than a fixed window, because a fixed window lets a client
 * send a full window's traffic at 59.9s and again at 60.1s, producing double the
 * intended rate at exactly the wrong moment.
 */

export interface BucketConfig {
  /** Sustained rate. */
  perSecond: number;
  /** Headroom for legitimate bursts — an app resuming with a queued backlog. */
  burst: number;
}

export interface RateLimitConfig {
  reports: BucketConfig;
  events: BucketConfig;
  replay: BucketConfig;
  uploads: BucketConfig;
}

/**
 * Chosen to be generous for real integrations and still bounded. Reports are
 * lowest because a human produces them; events highest because a batch carries
 * up to 500 of them.
 */
export const DEFAULT_LIMITS: RateLimitConfig = {
  reports: { perSecond: 5, burst: 50 },
  events: { perSecond: 50, burst: 500 },
  replay: { perSecond: 20, burst: 200 },
  uploads: { perSecond: 10, burst: 100 },
};

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly config: BucketConfig,
    private readonly now: () => number,
  ) {
    this.tokens = config.burst;
    this.lastRefill = now();
  }

  /** Returns false when the caller should be throttled. */
  tryConsume(cost = 1): boolean {
    const current = this.now();
    const elapsedSeconds = (current - this.lastRefill) / 1000;

    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.config.burst, this.tokens + elapsedSeconds * this.config.perSecond);
      this.lastRefill = current;
    }

    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Seconds until `cost` tokens are available, for Retry-After. */
  retryAfterSeconds(cost = 1): number {
    if (this.tokens >= cost) return 0;
    return Math.ceil((cost - this.tokens) / this.config.perSecond);
  }

  idleSince(): number {
    return this.lastRefill;
  }
}

export type TrafficClass = keyof RateLimitConfig;

/**
 * In-memory limiter.
 *
 * Per-instance by design: a shared store would mean Redis, and this core is
 * meant to mount inside an existing product without dragging in infrastructure.
 * Behind N instances the effective limit is N times the configured one — for a
 * throttle whose job is stopping runaway clients rather than precise quota
 * enforcement, that is an acceptable trade, but it is a real caveat and belongs
 * in the README rather than in a comment nobody reads.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private lastSweep = 0;

  constructor(
    private readonly config: RateLimitConfig = DEFAULT_LIMITS,
    private readonly now: () => number = () => Date.now(),
    private readonly metrics?: Metrics,
  ) {}

  check(projectId: string, traffic: TrafficClass, cost = 1): { allowed: boolean; retryAfter: number } {
    this.sweepIfDue();

    const key = `${traffic}:${projectId}`;
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = new TokenBucket(this.config[traffic], this.now);
      this.buckets.set(key, bucket);
    }

    const allowed = bucket.tryConsume(cost);
    if (!allowed) this.metrics?.increment(`ratelimit.rejected.${traffic}`);

    return { allowed, retryAfter: allowed ? 0 : bucket.retryAfterSeconds(cost) };
  }

  /**
   * Drops buckets untouched for an hour.
   *
   * Without this, a service seeing many short-lived project ids accumulates a
   * bucket per id forever — a slow memory leak that only shows up in production.
   */
  private sweepIfDue(): void {
    const current = this.now();
    if (current - this.lastSweep < 60_000) return;
    this.lastSweep = current;

    const cutoff = current - 3_600_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.idleSince() < cutoff) this.buckets.delete(key);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}

/**
 * Express middleware.
 *
 * `cost` lets a 500-event batch consume 500 tokens rather than one, so the
 * limit reflects work done rather than requests made — otherwise a client
 * batches around the throttle for free.
 */
export function rateLimit(
  limiter: RateLimiter,
  traffic: TrafficClass,
  cost: (req: Request) => number = () => 1,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const projectId = req.header('x-project-id');
    // Unidentified callers are rejected by the handler's own validation; do not
    // spend a bucket on them.
    if (!projectId) {
      next();
      return;
    }

    const { allowed, retryAfter } = limiter.check(projectId, traffic, cost(req));

    if (!allowed) {
      res.setHeader('retry-after', String(retryAfter));
      req.log?.warn('rate limited', { traffic, projectId, retryAfter });
      // 429 is retryable, so the SDK's queue holds the payload and backs off
      // rather than discarding it as a permanent rejection.
      res.status(429).json({ error: 'Rate limit exceeded', retryAfter });
      return;
    }

    next();
  };
}
