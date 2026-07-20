import pg from 'pg';

const { Pool, types } = pg;

/**
 * `bigint` (OID 20) arrives as a string by default, because a 64-bit integer can
 * exceed Number.MAX_SAFE_INTEGER. Our bigint columns are byte counters that will
 * never approach 2^53, and a string leaking into arithmetic produces silent
 * concatenation ("0" + 100 = "0100"). Parsing here keeps that bug impossible.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number.parseInt(value, 10));

export interface PoolOptions {
  connectionString: string;
  /** Cap on concurrent connections. Sized for the ingest workload, not the host app. */
  max?: number;
}

export function createPool(options: PoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    // Return a connection to the OS after 30s idle so a quiet service does not
    // pin server-side backends.
    idleTimeoutMillis: 30_000,
    // Fail fast rather than hanging a request forever when the database is down.
    connectionTimeoutMillis: 5_000,
  });

  // An idle client erroring (database restart, network blip) emits on the pool.
  // Without a listener Node treats it as an unhandled 'error' event and exits —
  // a database hiccup would take the whole service down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  return pool;
}

export function connectionStringFromEnv(fallbackDatabase = 'markerio_core'): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.PGHOST ?? 'localhost';
  const port = process.env.PGPORT ?? '5432';
  const user = process.env.PGUSER ?? 'postgres';
  const password = process.env.PGPASSWORD ?? 'postgres';
  const database = process.env.PGDATABASE ?? fallbackDatabase;

  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${database}`;
}
