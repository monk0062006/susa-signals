import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { migrate } from '../src/db/migrate.js';
import { connectionStringFromEnv, createPool } from '../src/db/pool.js';
import type { ReplayChunk, Submission } from '../src/validate.js';

/**
 * Tests run against a real Postgres, not a mock.
 *
 * The behaviour worth testing here — ON CONFLICT dedupe, cascade deletes,
 * transaction rollback, keyset pagination — is behaviour of the database. A mock
 * would assert that our SQL strings have not changed, which is not the same as
 * asserting they are correct.
 */
export function testPool(): Pool {
  const connectionString =
    process.env.TEST_DATABASE_URL ?? connectionStringFromEnv('markerio_core_test');
  return createPool({ connectionString, max: 5 });
}

export async function setupSchema(pool: Pool): Promise<void> {
  await migrate(pool, () => {});
}

/**
 * Wipes every table between tests.
 *
 * TRUNCATE ... CASCADE rather than DELETE: it resets in one statement and makes
 * ordering between foreign-keyed tables irrelevant. Guarded to the feedback
 * schema so it can never touch a host application's tables.
 */
export async function truncateAll(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE
      feedback.replay_chunks,
      feedback.replay_sessions,
      feedback.attachments,
      feedback.submissions,
      feedback.retention_policies,
      feedback.projects
    RESTART IDENTITY CASCADE
  `);
}

export function bugReport(overrides: Partial<Submission> = {}): Submission {
  const now = Date.now();
  return {
    id: randomUUID(),
    projectId: 'proj_test',
    payload: {
      type: 'bug_report',
      kind: 'bug',
      title: 'Something broke',
      annotations: [],
    },
    device: { platform: 'web', sdkVersion: '0.0.0' },
    attachments: [],
    createdAt: now,
    receivedAt: now,
    ...overrides,
  };
}

export function replayChunk(overrides: Partial<ReplayChunk> = {}): ReplayChunk {
  const now = Date.now();
  return {
    sessionId: randomUUID(),
    projectId: 'proj_test',
    seq: 0,
    events: [{ type: 2, timestamp: now }],
    startedAt: now,
    endedAt: now + 1000,
    final: false,
    receivedAt: now,
    ...overrides,
  };
}
