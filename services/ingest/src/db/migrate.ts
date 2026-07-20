import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

/**
 * Minimal forward-only migration runner.
 *
 * No framework, because this schema is intended to be mounted inside someone
 * else's product and a migration tool is exactly the kind of dependency that
 * collides with the one they already run. The contract is small enough to own:
 * numbered .sql files, applied once, in order, each inside a transaction.
 */

export interface MigrationResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(pool: Pool, log = console.info): Promise<MigrationResult> {
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);

    // Session-scoped advisory lock: two instances booting at once (rolling
    // deploy, multiple workers) would otherwise race to apply the same file.
    // The loser blocks here, then sees the work already done.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);

    try {
      const applied = await appliedVersions(client);
      const files = await migrationFiles();

      const pending = files.filter((file) => !applied.has(file));
      if (pending.length === 0) {
        return { applied: [], alreadyApplied: applied.size };
      }

      const ran: string[] = [];
      for (const file of pending) {
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');

        // Each migration is atomic: a failure halfway through leaves no partial
        // schema behind, so a retry starts from a known state.
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO feedback_migrations (version) VALUES ($1)',
            [file],
          );
          await client.query('COMMIT');
          ran.push(file);
          log(`[migrate] applied ${file}`);
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(
            `Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      return { applied: ran, alreadyApplied: applied.size };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/** Arbitrary but fixed: any constant works so long as every instance agrees. */
const MIGRATION_LOCK_ID = 8_274_113;

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  // Deliberately in `public`, not `feedback`: the ledger has to exist before the
  // migration that creates the feedback schema runs.
  await client.query(`
    CREATE TABLE IF NOT EXISTS feedback_migrations (
      version     text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM feedback_migrations',
  );
  return new Set(rows.map((row) => row.version));
}

async function migrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  // Lexicographic order over zero-padded numeric prefixes is chronological.
  return entries.filter((name) => name.endsWith('.sql')).sort();
}
