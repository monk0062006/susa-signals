import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { Repository } from '../src/db/repository.js';
import { bugReport, replayChunk, setupSchema, testPool, truncateAll } from './helpers.js';

let pool: Pool;
let repo: Repository;

before(async () => {
  pool = testPool();
  await setupSchema(pool);
  repo = new Repository(pool);
});

beforeEach(async () => {
  await truncateAll(pool);
});

after(async () => {
  await pool.end();
});

describe('submissions', () => {
  it('stores and reads back a submission', async () => {
    const submission = bugReport({
      payload: {
        type: 'bug_report',
        kind: 'bug',
        title: 'Checkout fails',
        description: 'Pay button does nothing',
        annotations: [],
      },
      reporter: { email: 'dana@example.com', fullName: 'Dana W' },
      customData: { plan: 'enterprise' },
    });

    assert.equal(await repo.saveSubmission(submission), true);

    const stored = await repo.getSubmission('proj_test', submission.id);
    assert.ok(stored);
    assert.equal(stored.payload.title, 'Checkout fails');
    assert.equal(stored.reporter?.email, 'dana@example.com');
    assert.deepEqual(stored.customData, { plan: 'enterprise' });
  });

  it('creates the project on first write', async () => {
    await repo.saveSubmission(bugReport({ projectId: 'brand_new_project' }));

    const { rows } = await pool.query('SELECT id FROM feedback.projects WHERE id = $1', [
      'brand_new_project',
    ]);
    assert.equal(rows.length, 1);
  });

  it('dedupes a replayed submission instead of storing it twice', async () => {
    const submission = bugReport();

    assert.equal(await repo.saveSubmission(submission), true);
    // The offline queue replays on every app start; this is the normal case.
    assert.equal(await repo.saveSubmission(submission), false);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM feedback.submissions');
    assert.equal(rows[0].n, 1);
  });

  it('dedupes under concurrent delivery of the same id', async () => {
    const submission = bugReport();

    // Two devices, or a retry racing the original. Exactly one must win, and
    // neither may throw a unique-violation at the caller.
    const results = await Promise.all([
      repo.saveSubmission(submission),
      repo.saveSubmission(submission),
      repo.saveSubmission(submission),
    ]);

    assert.equal(results.filter(Boolean).length, 1);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM feedback.submissions');
    assert.equal(rows[0].n, 1);
  });

  it('scopes reads to the project', async () => {
    const submission = bugReport({ projectId: 'project_a' });
    await repo.saveSubmission(submission);

    // A submission id is a UUID, but guessability is not the control — scoping is.
    assert.equal(await repo.getSubmission('project_b', submission.id), null);
    assert.ok(await repo.getSubmission('project_a', submission.id));
  });

  it('omits absent optional fields rather than emitting nulls', async () => {
    const submission = bugReport();
    await repo.saveSubmission(submission);

    const stored = await repo.getSubmission('proj_test', submission.id);
    assert.ok(stored);
    // `"reporter": null` on the wire would force every consumer to handle a
    // third state beyond present/absent.
    assert.equal('reporter' in stored, false);
    assert.equal('sessionId' in stored, false);
  });
});

describe('pagination', () => {
  it('walks pages without skipping or repeating rows', async () => {
    for (let i = 0; i < 25; i++) {
      await repo.saveSubmission(
        bugReport({
          payload: { type: 'bug_report', kind: 'bug', title: `Report ${i}`, annotations: [] },
        }),
      );
    }

    const first = await repo.listSubmissions('proj_test', { limit: 10 });
    assert.equal(first.items.length, 10);
    assert.ok(first.nextCursor);

    const second = await repo.listSubmissions('proj_test', {
      limit: 10,
      cursor: first.nextCursor,
    });
    const third = await repo.listSubmissions('proj_test', {
      limit: 10,
      cursor: second.nextCursor,
    });

    assert.equal(third.items.length, 5);
    assert.equal(third.nextCursor, null);

    const ids = [...first.items, ...second.items, ...third.items].map((s) => s.id);
    assert.equal(new Set(ids).size, 25, 'every row appears exactly once across pages');
  });

  it('treats a malformed cursor as the start rather than erroring', async () => {
    await repo.saveSubmission(bugReport());

    const page = await repo.listSubmissions('proj_test', { cursor: 'not-a-real-cursor' });
    assert.equal(page.items.length, 1);
  });

  it('returns newest first', async () => {
    const older = bugReport({
      payload: { type: 'bug_report', kind: 'bug', title: 'older', annotations: [] },
    });
    await repo.saveSubmission(older);
    const newer = bugReport({
      payload: { type: 'bug_report', kind: 'bug', title: 'newer', annotations: [] },
    });
    await repo.saveSubmission(newer);

    const page = await repo.listSubmissions('proj_test');
    assert.equal(page.items[0]?.payload.title, 'newer');
  });
});

describe('attachments', () => {
  it('links an uploaded attachment to its submission', async () => {
    const attachmentId = randomUUID();
    const bytes = Buffer.from('fake-png-bytes');

    await repo.saveAttachment({
      id: attachmentId,
      projectId: 'proj_test',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes,
      width: 100,
      height: 50,
    });

    const submission = bugReport({ attachments: [{ id: attachmentId }] });
    await repo.saveSubmission(submission);

    const stored = await repo.getSubmission('proj_test', submission.id);
    assert.equal(stored?.attachments.length, 1);
    assert.equal(stored?.attachments[0]?.byteSize, bytes.byteLength);
    assert.equal(stored?.attachments[0]?.width, 100);
  });

  it('round-trips binary content without corruption', async () => {
    const id = randomUUID();
    // Includes a NUL and high bytes: the values that break naive text handling.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]);

    await repo.saveAttachment({
      id,
      projectId: 'proj_test',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes,
    });

    const read = await repo.readAttachment('proj_test', id);
    assert.deepEqual(read?.bytes, bytes);
  });

  it('will not attach another project’s blob', async () => {
    const attachmentId = randomUUID();
    await repo.saveAttachment({
      id: attachmentId,
      projectId: 'project_a',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes: Buffer.from('x'),
    });

    // project_b references an id it does not own.
    const submission = bugReport({ projectId: 'project_b', attachments: [{ id: attachmentId }] });
    await repo.saveSubmission(submission);

    const stored = await repo.getSubmission('project_b', submission.id);
    assert.equal(stored?.attachments.length, 0);
  });

  it('deletes attachments when their submission is deleted', async () => {
    const attachmentId = randomUUID();
    await repo.saveAttachment({
      id: attachmentId,
      projectId: 'proj_test',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes: Buffer.from('x'),
    });

    const submission = bugReport({ attachments: [{ id: attachmentId }] });
    await repo.saveSubmission(submission);

    await pool.query('DELETE FROM feedback.submissions WHERE id = $1', [submission.id]);

    // Cascade, not orphaned rows: an unreachable screenshot is still stored PII.
    assert.equal(await repo.readAttachment('proj_test', attachmentId), null);
  });
});

describe('replay', () => {
  it('reassembles chunks in seq order regardless of arrival order', async () => {
    const sessionId = randomUUID();

    // Deliberately out of order — this is normal over a flaky network.
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 2, events: [{ n: 'third' }] }));
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 0, events: [{ n: 'first' }] }));
    await repo.appendReplayChunk(
      replayChunk({ sessionId, seq: 1, events: [{ n: 'second' }], final: true }),
    );

    const session = await repo.readReplaySession('proj_test', sessionId);
    assert.deepEqual(
      session?.events.map((e) => (e as { n: string }).n),
      ['first', 'second', 'third'],
    );
    assert.equal(session?.chunks, 3);
    assert.equal(session?.final, true);
  });

  it('ignores a redelivered chunk without double-counting', async () => {
    const sessionId = randomUUID();
    const chunk = replayChunk({ sessionId, seq: 0, events: [{ a: 1 }, { b: 2 }] });

    const first = await repo.appendReplayChunk(chunk);
    const second = await repo.appendReplayChunk(chunk);

    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false);
    // Counters advancing on a duplicate would inflate every retried session and
    // trip the size cap early.
    assert.equal(second.byteSize, first.byteSize);

    const summary = await repo.getReplaySummary('proj_test', sessionId);
    assert.equal(summary?.chunkCount, 1);
    assert.equal(summary?.eventCount, 2);
  });

  it('marks a session incomplete until a final chunk arrives', async () => {
    const sessionId = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 0 }));

    let summary = await repo.getReplaySummary('proj_test', sessionId);
    // Not an error state: the tab was closed or the network dropped, which is
    // itself useful signal for a researcher.
    assert.equal(summary?.complete, false);

    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 1, final: true }));
    summary = await repo.getReplaySummary('proj_test', sessionId);
    assert.equal(summary?.complete, true);
  });

  it('scopes replay reads to the project', async () => {
    const sessionId = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId, projectId: 'project_a' }));

    assert.equal(await repo.readReplaySession('project_b', sessionId), null);
    assert.ok(await repo.readReplaySession('project_a', sessionId));
  });

  it('deletes chunks when the session is deleted', async () => {
    const sessionId = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 0 }));

    await pool.query('DELETE FROM feedback.replay_sessions WHERE id = $1', [sessionId]);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM feedback.replay_chunks WHERE session_id = $1',
      [sessionId],
    );
    assert.equal(rows[0].n, 0);
  });
});
