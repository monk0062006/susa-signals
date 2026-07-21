import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_LIMITS, RateLimiter } from '../src/ratelimit.js';

/**
 * Throttling behaviour, driven by an injected clock so the suite is
 * deterministic rather than dependent on wall time.
 */
describe('rate limiting', () => {
  function limiter(now: () => number) {
    return new RateLimiter(DEFAULT_LIMITS, now);
  }

  it('allows traffic up to the burst then throttles', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    // Burst for reports is 50.
    for (let i = 0; i < 50; i++) {
      assert.equal(rl.check('proj', 'reports').allowed, true, `request ${i} should be allowed`);
    }
    assert.equal(rl.check('proj', 'reports').allowed, false);
  });

  it('refills over time rather than resetting on a window boundary', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    for (let i = 0; i < 50; i++) rl.check('proj', 'reports');
    assert.equal(rl.check('proj', 'reports').allowed, false);

    // reports refill at 5/s, so one second buys five.
    clock += 1000;
    for (let i = 0; i < 5; i++) {
      assert.equal(rl.check('proj', 'reports').allowed, true);
    }
    assert.equal(rl.check('proj', 'reports').allowed, false);
  });

  it('keeps traffic classes on separate budgets', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    // Exhaust the events budget entirely.
    for (let i = 0; i < 500; i++) rl.check('proj', 'events');
    assert.equal(rl.check('proj', 'events').allowed, false);

    // A bug report must still get through. This is the whole point: a chatty
    // analytics integration must never starve the one payload a human typed.
    assert.equal(rl.check('proj', 'reports').allowed, true);
    assert.equal(rl.check('proj', 'replay').allowed, true);
  });

  it('isolates projects from one another', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    for (let i = 0; i < 50; i++) rl.check('noisy', 'reports');
    assert.equal(rl.check('noisy', 'reports').allowed, false);

    // One tenant exhausting its budget must not affect another.
    assert.equal(rl.check('quiet', 'reports').allowed, true);
  });

  it('charges a batch by its size so batching cannot dodge the limit', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    // events burst is 500; one batch of 500 consumes it all.
    assert.equal(rl.check('proj', 'events', 500).allowed, true);
    assert.equal(rl.check('proj', 'events', 1).allowed, false);
  });

  it('reports a retry-after that actually covers the deficit', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    for (let i = 0; i < 50; i++) rl.check('proj', 'reports');
    const { allowed, retryAfter } = rl.check('proj', 'reports');

    assert.equal(allowed, false);
    assert.ok(retryAfter >= 1, `retryAfter was ${retryAfter}`);

    // Waiting the advertised time must genuinely admit the request, or clients
    // hammer the endpoint in a loop.
    clock += retryAfter * 1000;
    assert.equal(rl.check('proj', 'reports').allowed, true);
  });

  it('evicts idle buckets so project churn does not leak memory', () => {
    let clock = 0;
    const rl = limiter(() => clock);

    for (let i = 0; i < 100; i++) rl.check(`ephemeral-${i}`, 'events');
    assert.equal(rl.size(), 100);

    // Two hours later, all idle.
    clock += 7_200_000;
    rl.check('someone-new', 'events');

    assert.ok(rl.size() < 100, `expected eviction, still holding ${rl.size()}`);
  });
});
