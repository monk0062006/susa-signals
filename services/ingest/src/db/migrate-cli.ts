import { migrate } from './migrate.js';
import { connectionStringFromEnv, createPool } from './pool.js';

/** Standalone migration runner, for deploys that migrate before starting. */
const pool = createPool({ connectionString: connectionStringFromEnv() });
try {
  const result = await migrate(pool);
  console.info(
    result.applied.length > 0
      ? `[migrate] applied ${result.applied.length} migration(s)`
      : `[migrate] up to date (${result.alreadyApplied} applied)`,
  );
} finally {
  await pool.end();
}
