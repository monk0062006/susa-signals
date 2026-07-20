import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { Events, parseEventBatch, type EventInput } from '../src/db/events.js';
import { Retention } from '../src/db/retention.js';
import { setupSchema, testPool, truncateAll } from './helpers.js';

let pool: Pool;
let events: Events;
let retention: Retention;

before(async () => {
  pool = testPool();
  await setupSchema(pool);
  events = new Events(pool);
  retention = new Retention(pool);
});

beforeEach(async () => {
  await truncateAll(pool);
  await pool.query('TRUNCATE feedback.events CASCADE');
});

after(async () => {
  await pool.end();
});

const SESSION = randomUUID();

function event(name: string, overrides: Partial<EventInput> = {}): EventInput {
  return {
    id: randomUUID(),
    name,
    sessionId: SESSION,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('event ingest', () => {
  it('stores a batch and reads it back', async () => {
    const { inserted } = await events.insertBatch(
      'proj_test',
      [event('page_view', { properties: { path: '/billing' } }), event('plan_selected')],
      { platform: 'web' },
    );

    assert.equal(inserted, 2);

    const recent = await events.recent('proj_test');
    assert.equal(recent.length, 2);
    assert.ok(recent.some((e) => e.name === 'page_view'));
  });

  it('creates the project on first event', async () => {
    await events.insertBatch('brand_new', [event('first')], {});

    const { rows } = await pool.query('SELECT id FROM feedback.projects WHERE id = $1', ['brand_new']);
    assert.equal(rows.length, 1);
  });

  it('is idempotent when a batch is redelivered', async () => {
    const batch = [event('clicked'), event('clicked')];

    const first = await events.insertBatch('proj_test', batch, {});
    // The SDK cannot know which half of a timed-out request landed, so it may
    // resend the whole batch.
    const second = await events.insertBatch('proj_test', batch, {});

    assert.equal(first.inserted, 2);
    assert.equal(second.inserted, 0);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM feedback.events');
    assert.equal(rows[0].n, 2);
  });

  it('scopes reads to the project', async () => {
    await events.insertBatch('project_a', [event('a_only')], {});
    await events.insertBatch('project_b', [event('b_only')], {});

    const a = await events.recent('project_a');
    assert.equal(a.length, 1);
    assert.equal(a[0]?.name, 'a_only');
  });

  it('rejects an oversized batch rather than truncating silently', async () => {
    const huge = Array.from({ length: 501 }, () => event('spam'));
    await assert.rejects(() => events.insertBatch('proj_test', huge, {}));
  });
});

describe('event validation', () => {
  it('drops malformed events but keeps the good ones', () => {
    const { events: parsed } = parseEventBatch({
      events: [
        { id: randomUUID(), name: 'good', sessionId: SESSION, timestamp: 1 },
        { id: 'not-a-uuid', name: 'bad id', sessionId: SESSION },
        { id: randomUUID(), name: '', sessionId: SESSION },
        { id: randomUUID(), name: 'no session' },
        'not an object',
      ],
      device: { platform: 'web' },
    });

    // One partly-malformed batch must not cost the whole batch.
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.name, 'good');
  });

  it('truncates absurd event names instead of storing them', () => {
    const { events: parsed } = parseEventBatch({
      events: [{ id: randomUUID(), name: 'x'.repeat(5000), sessionId: SESSION }],
    });

    assert.ok((parsed[0]?.name.length ?? 0) <= 200);
  });

  it('rejects a non-array events field', () => {
    assert.throws(() => parseEventBatch({ events: 'nope' }));
  });
});

describe('aggregation', () => {
  it('counts events and distinct users separately', async () => {
    // One looping script and 500 real people produce the same row count and
    // mean entirely different things.
    await events.insertBatch('proj_test', [
      event('clicked', { userId: 'user_1' }),
      event('clicked', { userId: 'user_1' }),
      event('clicked', { userId: 'user_1' }),
      event('clicked', { userId: 'user_2' }),
    ], {});

    const counts = await events.counts('proj_test');
    const clicked = counts.find((c) => c.name === 'clicked');

    assert.equal(clicked?.count, 4);
    assert.equal(clicked?.users, 2);
  });

  it('buckets a timeseries and can filter by event name', async () => {
    await events.insertBatch('proj_test', [
      event('page_view'),
      event('page_view'),
      event('purchase'),
    ], {});

    const all = await events.timeseries('proj_test', { days: 7 });
    assert.equal(all.reduce((sum, p) => sum + p.count, 0), 3);

    const purchases = await events.timeseries('proj_test', { name: 'purchase', days: 7 });
    assert.equal(purchases.reduce((sum, p) => sum + p.count, 0), 1);
  });

  it('returns an empty series for a project with no events', async () => {
    assert.deepEqual(await events.timeseries('empty_project'), []);
    assert.deepEqual(await events.counts('empty_project'), []);
  });
});

describe('erasure', () => {
  it('deletes a subject events alongside their submissions', async () => {
    await events.insertBatch('proj_test', [
      event('viewed', { userId: 'dana@example.com' }),
      event('viewed', { userId: 'dana@example.com' }),
      event('viewed', { userId: 'someone@else.com' }),
    ], {});

    const result = await retention.eraseSubject('proj_test', { email: 'dana@example.com' });

    // Events are usually the largest row count of the three; leaving them would
    // make an erasure request quietly incomplete.
    assert.equal(result.eventsDeleted, 2);

    const remaining = await events.recent('proj_test');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.userId, 'someone@else.com');
  });

  it('matches the subject case-insensitively', async () => {
    await events.insertBatch('proj_test', [event('viewed', { userId: 'Dana@Example.com' })], {});

    const result = await retention.eraseSubject('proj_test', { email: 'dana@example.com' });
    assert.equal(result.eventsDeleted, 1);
  });

  it('does not cross project boundaries', async () => {
    await events.insertBatch('project_a', [event('viewed', { userId: 'dana@example.com' })], {});
    await events.insertBatch('project_b', [event('viewed', { userId: 'dana@example.com' })], {});

    await retention.eraseSubject('project_a', { email: 'dana@example.com' });

    assert.equal((await events.recent('project_a')).length, 0);
    assert.equal((await events.recent('project_b')).length, 1);
  });
});
