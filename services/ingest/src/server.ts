import { createIngestApp } from './app.js';
import { migrate } from './db/migrate.js';
import { connectionStringFromEnv, createPool } from './db/pool.js';

/**
 * Standalone entry point.
 *
 * Thin on purpose: everything meaningful lives in `createIngestApp`, so mounting
 * this core inside an existing product means importing that factory rather than
 * running a second server. This file only exists for local development and for
 * deployments that do want a separate process.
 */

const PORT = Number(process.env.PORT ?? 4000);

const pool = createPool({ connectionString: connectionStringFromEnv() });

// Migrate before listening. Serving traffic against a schema that has not been
// brought up to date produces confusing column-missing errors under load rather
// than one clear failure at boot.
const result = await migrate(pool);
if (result.applied.length === 0) {
  console.info(`[migrate] schema up to date (${result.alreadyApplied} migration(s))`);
}

const app = createIngestApp({
  pool,
  serveDashboard: true,
  // Local development only. In production pass an explicit origin allowlist.
  allowedOrigins: true,
});

const server = app.listen(PORT, () => {
  console.info(`[ingest] listening on http://localhost:${PORT}`);
});

// Drain in-flight requests and close pooled connections, so a redeploy does not
// sever a request mid-write or leave server-side backends behind.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.info(`[ingest] ${signal} received, shutting down`);
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
