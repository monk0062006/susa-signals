import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Pool } from 'pg';
import { Repository } from '../src/db/repository.js';
import { Retention } from '../src/db/retention.js';
import { bugReport, replayChunk, setupSchema, testPool, truncateAll } from './helpers.js';

let pool: Pool;
let repo: Repository;
let retention: Retention;

before(async () => {
  pool = testPool();
  await setupSchema(pool);
  repo = new Repository(pool);
  retention = new Retention(pool);
});

beforeEach(async () => {
  await truncateAll(pool);
});

after(async () => {
  await pool.end();
});

/** Backdates a row so age-based expiry can be tested without waiting days. */
async function backdate(table: string, column: string, id: string, days: number): Promise<void> {
  await pool.query(
    `UPDATE feedback.${table} SET ${column} = now() - make_interval(days => $2) WHERE id = $1`,
    [id, days],
  );
}

describe('retention policy', () => {
  it('stores and updates a policy', async () => {
    await retention.setPolicy({
      projectId: 'proj_test',
      replayTtlDays: 30,
      submissionTtlDays: 365,
    });

    let policy = await retention.getPolicy('proj_test');
    assert.equal(policy?.replayTtlDays, 30);

    await retention.setPolicy({
      projectId: 'proj_test',
      replayTtlDays: 7,
      submissionTtlDays: null,
    });

    policy = await retention.getPolicy('proj_test');
    assert.equal(policy?.replayTtlDays, 7);
    assert.equal(policy?.submissionTtlDays, null);
  });

  it('keeps data indefinitely when no policy is set', async () => {
    const sessionId = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId }));
    await backdate('replay_sessions', 'created_at', sessionId, 3650);

    const result = await retention.sweep();

    // "Keep forever" must be a decision someone made, but the inverse is worse:
    // silently deleting data because nobody configured a TTL.
    assert.equal(result.replaySessionsDeleted, 0);
    assert.ok(await repo.readReplaySession('proj_test', sessionId));
  });
});

describe('sweep', () => {
  it('deletes replay past its TTL and leaves fresh sessions alone', async () => {
    await retention.setPolicy({
      projectId: 'proj_test',
      replayTtlDays: 30,
      submissionTtlDays: null,
    });

    const oldSession = randomUUID();
    const freshSession = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId: oldSession }));
    await repo.appendReplayChunk(replayChunk({ sessionId: freshSession }));
    await backdate('replay_sessions', 'created_at', oldSession, 45);

    const result = await retention.sweep();

    assert.equal(result.replaySessionsDeleted, 1);
    assert.equal(await repo.readReplaySession('proj_test', oldSession), null);
    assert.ok(await repo.readReplaySession('proj_test', freshSession));
  });

  it('cascades chunk deletion when a session expires', async () => {
    await retention.setPolicy({ projectId: 'proj_test', replayTtlDays: 1, submissionTtlDays: null });

    const sessionId = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 0 }));
    await repo.appendReplayChunk(replayChunk({ sessionId, seq: 1 }));
    await backdate('replay_sessions', 'created_at', sessionId, 5);

    await retention.sweep();

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM feedback.replay_chunks');
    // Chunks are the actual recording; a session row deleted without them would
    // leave the personal data behind.
    assert.equal(rows[0].n, 0);
  });

  it('deletes submissions past their TTL', async () => {
    await retention.setPolicy({
      projectId: 'proj_test',
      replayTtlDays: null,
      submissionTtlDays: 90,
    });

    const old = bugReport();
    await repo.saveSubmission(old);
    await backdate('submissions', 'received_at', old.id, 120);

    const result = await retention.sweep();

    assert.equal(result.submissionsDeleted, 1);
    assert.equal(await repo.getSubmission('proj_test', old.id), null);
  });

  it('does not apply one project’s policy to another', async () => {
    await retention.setPolicy({ projectId: 'project_a', replayTtlDays: 1, submissionTtlDays: null });

    const sessionA = randomUUID();
    const sessionB = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId: sessionA, projectId: 'project_a' }));
    await repo.appendReplayChunk(replayChunk({ sessionId: sessionB, projectId: 'project_b' }));
    await backdate('replay_sessions', 'created_at', sessionA, 10);
    await backdate('replay_sessions', 'created_at', sessionB, 10);

    await retention.sweep();

    assert.equal(await repo.readReplaySession('project_a', sessionA), null);
    // project_b never configured a TTL, so its data survives.
    assert.ok(await repo.readReplaySession('project_b', sessionB));
  });

  it('reclaims uploads abandoned without a submission', async () => {
    const orphan = randomUUID();
    const linked = randomUUID();

    for (const id of [orphan, linked]) {
      await repo.saveAttachment({
        id,
        projectId: 'proj_test',
        kind: 'screenshot',
        mimeType: 'image/png',
        bytes: Buffer.from('x'),
      });
    }

    const submission = bugReport({ attachments: [{ id: linked }] });
    await repo.saveSubmission(submission);

    // The user opened the composer, the screenshot uploaded, they hit Cancel.
    await pool.query(
      `UPDATE feedback.attachments SET created_at = now() - interval '48 hours' WHERE id = $1`,
      [orphan],
    );

    const result = await retention.sweep();

    assert.equal(result.orphanAttachmentsDeleted, 1);
    assert.equal(await repo.readAttachment('proj_test', orphan), null);
    assert.ok(await repo.readAttachment('proj_test', linked));
  });

  it('does not reclaim a recent unlinked upload still mid-flow', async () => {
    const inFlight = randomUUID();
    await repo.saveAttachment({
      id: inFlight,
      projectId: 'proj_test',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes: Buffer.from('x'),
    });

    const result = await retention.sweep();

    // The user is still typing their description; deleting now loses the image.
    assert.equal(result.orphanAttachmentsDeleted, 0);
    assert.ok(await repo.readAttachment('proj_test', inFlight));
  });
});

describe('erasure', () => {
  it('deletes a subject’s submissions by email, case-insensitively', async () => {
    await repo.saveSubmission(bugReport({ reporter: { email: 'Dana@Example.com' } }));
    await repo.saveSubmission(bugReport({ reporter: { email: 'other@example.com' } }));

    // Users capitalise inconsistently; a missed match is undeleted personal data.
    const result = await retention.eraseSubject('proj_test', { email: 'dana@example.com' });

    assert.equal(result.submissionsDeleted, 1);

    const remaining = await repo.listSubmissions('proj_test');
    assert.equal(remaining.items.length, 1);
    assert.equal(remaining.items[0]?.reporter?.email, 'other@example.com');
  });

  it('deletes by external id', async () => {
    await repo.saveSubmission(bugReport({ reporter: { externalId: 'user_42' } }));
    await repo.saveSubmission(bugReport({ reporter: { externalId: 'user_99' } }));

    const result = await retention.eraseSubject('proj_test', { externalId: 'user_42' });

    assert.equal(result.submissionsDeleted, 1);
  });

  it('deletes the subject’s replay sessions too', async () => {
    const sessionId = randomUUID();
    await repo.appendReplayChunk(replayChunk({ sessionId }));
    await repo.saveSubmission(
      bugReport({ reporter: { email: 'dana@example.com' }, sessionId }),
    );

    const result = await retention.eraseSubject('proj_test', { email: 'dana@example.com' });

    assert.equal(result.replaySessionsDeleted, 1);
    // A recording is the most identifying artefact here; deleting the report
    // while keeping the video would defeat the request entirely.
    assert.equal(await repo.readReplaySession('proj_test', sessionId), null);
  });

  it('deletes the subject’s screenshots via cascade', async () => {
    const attachmentId = randomUUID();
    await repo.saveAttachment({
      id: attachmentId,
      projectId: 'proj_test',
      kind: 'screenshot',
      mimeType: 'image/png',
      bytes: Buffer.from('x'),
    });
    await repo.saveSubmission(
      bugReport({ reporter: { email: 'dana@example.com' }, attachments: [{ id: attachmentId }] }),
    );

    await retention.eraseSubject('proj_test', { email: 'dana@example.com' });

    assert.equal(await repo.readAttachment('proj_test', attachmentId), null);
  });

  it('does not cross project boundaries', async () => {
    await repo.saveSubmission(
      bugReport({ projectId: 'project_a', reporter: { email: 'dana@example.com' } }),
    );
    await repo.saveSubmission(
      bugReport({ projectId: 'project_b', reporter: { email: 'dana@example.com' } }),
    );

    await retention.eraseSubject('project_a', { email: 'dana@example.com' });

    assert.equal((await repo.listSubmissions('project_a')).items.length, 0);
    assert.equal((await repo.listSubmissions('project_b')).items.length, 1);
  });

  it('refuses an erasure request with no subject', async () => {
    // An empty subject matching everything would be a catastrophic no-op-looking
    // call, so it has to fail loudly.
    await assert.rejects(() => retention.eraseSubject('proj_test', {}));
  });
});
