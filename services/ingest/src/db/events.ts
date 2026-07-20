import type { Pool } from 'pg';
import { ValidationError } from '../validate.js';

export interface EventInput {
  id: string;
  name: string;
  properties?: Record<string, unknown>;
  userId?: string;
  sessionId: string;
  timestamp: number;
}

export interface EventRow {
  id: string;
  name: string;
  properties: Record<string, unknown> | null;
  userId: string | null;
  sessionId: string;
  occurredAt: number;
  receivedAt: number;
}

export interface EventCount {
  name: string;
  count: number;
  users: number;
}

export interface TimeseriesPoint {
  bucket: string;
  count: number;
}

const MAX_BATCH = 500;
const MAX_NAME = 200;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export class Events {
  constructor(private readonly pool: Pool) {}

  /**
   * Inserts a batch.
   *
   * One multi-row INSERT rather than a loop: at analytics volume a round trip
   * per event would dominate the cost entirely. Conflicts are ignored so a
   * client retrying a batch it already delivered is a no-op instead of an
   * error — the SDK cannot know which half of a timed-out request landed.
   */
  async insertBatch(
    projectId: string,
    events: EventInput[],
    device: Record<string, unknown>,
  ): Promise<{ inserted: number }> {
    if (events.length === 0) return { inserted: 0 };
    if (events.length > MAX_BATCH) throw new ValidationError('batch too large');

    await this.pool.query(
      `INSERT INTO feedback.projects (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [projectId],
    );

    const values: unknown[] = [];
    const tuples: string[] = [];

    events.forEach((event, index) => {
      const base = index * 7;
      // Every column cast explicitly: Postgres does not infer parameter types
      // inside a VALUES subquery, so an uncast $n arrives as text and the
      // insert fails against uuid columns.
      tuples.push(
        `($${base + 1}::uuid, $${base + 2}::text, $${base + 3}::text, ` +
          `$${base + 4}::jsonb, $${base + 5}::text, $${base + 6}::uuid, ` +
          `to_timestamp($${base + 7}::double precision / 1000))`,
      );
      values.push(
        event.id,
        projectId,
        event.name,
        event.properties ? JSON.stringify(event.properties) : null,
        event.userId ?? null,
        event.sessionId,
        event.timestamp,
      );
    });

    const deviceJson = JSON.stringify(device ?? {});

    const { rowCount } = await this.pool.query(
      `
      INSERT INTO feedback.events
        (id, project_id, name, properties, user_id, session_id, occurred_at, device)
      SELECT v.id, v.project_id, v.name, v.properties, v.user_id, v.session_id, v.occurred_at, $${values.length + 1}::jsonb
        FROM (VALUES ${tuples.join(',')})
          AS v(id, project_id, name, properties, user_id, session_id, occurred_at)
      ON CONFLICT (id) DO NOTHING
      `,
      [...values, deviceJson],
    );

    return { inserted: rowCount ?? 0 };
  }

  /** Most recent events, for the dashboard's live stream. */
  async recent(projectId: string, limit = 100): Promise<EventRow[]> {
    const { rows } = await this.pool.query(
      `
      SELECT id, name, properties, user_id, session_id,
             extract(epoch FROM occurred_at) * 1000 AS occurred_ms,
             extract(epoch FROM received_at) * 1000 AS received_ms
        FROM feedback.events
       WHERE project_id = $1
       ORDER BY received_at DESC
       LIMIT $2
      `,
      [projectId, Math.min(Math.max(limit, 1), 500)],
    );

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      properties: row.properties,
      userId: row.user_id,
      sessionId: row.session_id,
      occurredAt: Number(row.occurred_ms),
      receivedAt: Number(row.received_ms),
    }));
  }

  /**
   * Event counts over a window, with distinct users per event.
   *
   * `count(DISTINCT user_id)` rather than counting rows: "500 clicks" from one
   * looping script and from 500 people mean entirely different things, and a
   * dashboard that cannot tell them apart is worse than no dashboard.
   */
  async counts(projectId: string, sinceDays = 7): Promise<EventCount[]> {
    const { rows } = await this.pool.query(
      `
      SELECT name,
             count(*)::int                    AS total,
             count(DISTINCT user_id)::int     AS users
        FROM feedback.events
       WHERE project_id = $1
         AND received_at > now() - make_interval(days => $2)
       GROUP BY name
       ORDER BY total DESC
       LIMIT 100
      `,
      [projectId, sinceDays],
    );

    return rows.map((row) => ({ name: row.name, count: row.total, users: row.users }));
  }

  /** Hourly or daily buckets for one event, or all events when name is omitted. */
  async timeseries(
    projectId: string,
    options: { name?: string | undefined; days?: number | undefined } = {},
  ): Promise<TimeseriesPoint[]> {
    const days = Math.min(Math.max(options.days ?? 7, 1), 90);
    // Hourly buckets stop being readable past a few days.
    const bucket = days <= 2 ? 'hour' : 'day';

    const { rows } = await this.pool.query(
      `
      SELECT date_trunc($3, received_at) AS bucket, count(*)::int AS total
        FROM feedback.events
       WHERE project_id = $1
         AND received_at > now() - make_interval(days => $2)
         AND ($4::text IS NULL OR name = $4)
       GROUP BY 1
       ORDER BY 1 ASC
      `,
      [projectId, days, bucket, options.name ?? null],
    );

    return rows.map((row) => ({
      bucket: (row.bucket as Date).toISOString(),
      count: row.total,
    }));
  }

  /** Erasure by subject, mirroring the submissions path. */
  async eraseUser(projectId: string, userId: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM feedback.events WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    return rowCount ?? 0;
  }
}

/** Validates one incoming batch. Nothing from a public endpoint is trusted. */
export function parseEventBatch(body: unknown): {
  events: EventInput[];
  device: Record<string, unknown>;
} {
  if (typeof body !== 'object' || body === null) {
    throw new ValidationError('Body must be a JSON object');
  }

  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.events)) throw new ValidationError('events must be an array');
  if (b.events.length > MAX_BATCH) throw new ValidationError('batch too large');

  const events: EventInput[] = [];

  for (const raw of b.events) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;

    if (typeof e.id !== 'string' || !UUID_RE.test(e.id)) continue;
    if (typeof e.name !== 'string' || !e.name.trim()) continue;
    if (typeof e.sessionId !== 'string' || !UUID_RE.test(e.sessionId)) continue;

    const event: EventInput = {
      id: e.id,
      name: e.name.slice(0, MAX_NAME),
      sessionId: e.sessionId,
      timestamp: typeof e.timestamp === 'number' ? e.timestamp : Date.now(),
    };

    if (typeof e.properties === 'object' && e.properties !== null) {
      event.properties = e.properties as Record<string, unknown>;
    }
    if (typeof e.userId === 'string') event.userId = e.userId.slice(0, 200);

    events.push(event);
  }

  const device =
    typeof b.device === 'object' && b.device !== null
      ? (b.device as Record<string, unknown>)
      : {};

  return { events, device };
}
