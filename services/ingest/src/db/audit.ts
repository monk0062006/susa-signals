import type { Pool } from 'pg';

/**
 * Audit trail for reads.
 *
 * Writes are already reconstructable from the data itself — a submission row is
 * evidence that a submission happened. Reads leave no trace, and reads are what
 * matters here: a session replay is a recording of a person, and "which of your
 * staff watched this recording" is a question a customer is entitled to have
 * answered.
 *
 * Records are written best-effort and never block or fail the request that
 * triggered them. An audit system that can take down the service it observes
 * gets switched off, and then there is no audit system.
 */

export type AuditAction =
  | 'submission.list'
  | 'submission.read'
  | 'attachment.read'
  | 'replay.read'
  | 'replay.delete'
  | 'study.results'
  | 'events.read'
  | 'erasure.execute'
  | 'retention.sweep';

export interface AuditEntry {
  projectId: string;
  action: AuditAction;
  subjectType?: string | undefined;
  subjectId?: string | undefined;
  /** Supplied by the host product, which owns identity. */
  actor?: string | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  detail?: Record<string, unknown> | undefined;
}

export interface AuditPage {
  entries: Array<AuditEntry & { id: string; occurredAt: number }>;
  nextCursor: string | null;
}

export class AuditLog {
  constructor(
    private readonly pool: Pool,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  /**
   * Records an entry. Deliberately not awaited by callers.
   *
   * Fire-and-forget with the error swallowed: a failed audit write must not turn
   * a successful read into a 500. The tradeoff is that a database outage loses
   * audit records — which is why the failure is logged rather than silently
   * dropped, so the gap is visible afterwards.
   */
  record(entry: AuditEntry): void {
    void this.pool
      .query(
        `
        INSERT INTO feedback.audit_log
          (project_id, action, subject_type, subject_id, actor, request_id, ip, detail)
        VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8::jsonb)
        `,
        [
          entry.projectId,
          entry.action,
          entry.subjectType ?? null,
          entry.subjectId ?? null,
          entry.actor ?? null,
          entry.requestId ?? null,
          normalizeIp(entry.ip),
          entry.detail ? JSON.stringify(entry.detail) : null,
        ],
      )
      .catch((err: unknown) => {
        this.onError(
          `audit write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Awaits the write. For actions where losing the record is unacceptable. */
  async recordSync(entry: AuditEntry): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO feedback.audit_log
        (project_id, action, subject_type, subject_id, actor, request_id, ip, detail)
      VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8::jsonb)
      `,
      [
        entry.projectId,
        entry.action,
        entry.subjectType ?? null,
        entry.subjectId ?? null,
        entry.actor ?? null,
        entry.requestId ?? null,
        normalizeIp(entry.ip),
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    );
  }

  /**
   * Reads the trail. Filterable by subject, because the common question is
   * "who touched this recording" rather than "what happened generally".
   */
  async query(
    projectId: string,
    options: {
      action?: string | undefined;
      subjectId?: string | undefined;
      actor?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<AuditPage> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

    const { rows } = await this.pool.query(
      `
      SELECT id, project_id, action, subject_type, subject_id, actor, request_id,
             host(ip) AS ip, detail,
             extract(epoch FROM occurred_at) * 1000 AS occurred_ms
        FROM feedback.audit_log
       WHERE project_id = $1
         AND ($2::text IS NULL OR action = $2)
         AND ($3::text IS NULL OR subject_id = $3)
         AND ($4::text IS NULL OR actor = $4)
       ORDER BY occurred_at DESC, id DESC
       LIMIT $5
      `,
      [projectId, options.action ?? null, options.subjectId ?? null, options.actor ?? null, limit],
    );

    return {
      entries: rows.map((row) => ({
        id: String(row.id),
        projectId: row.project_id,
        action: row.action,
        subjectType: row.subject_type ?? undefined,
        subjectId: row.subject_id ?? undefined,
        actor: row.actor ?? undefined,
        requestId: row.request_id ?? undefined,
        ip: row.ip ?? undefined,
        detail: row.detail ?? undefined,
        occurredAt: Number(row.occurred_ms),
      })),
      nextCursor: null,
    };
  }

  /**
   * Deletes entries older than the retention window.
   *
   * Audit logs are themselves personal data (they record IPs and actors), so
   * they cannot be kept forever either. A year is the usual floor for a security
   * audit trail; the caller decides.
   */
  async prune(olderThanDays: number): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM feedback.audit_log WHERE occurred_at < now() - make_interval(days => $1)`,
      [olderThanDays],
    );
    return rowCount ?? 0;
  }
}

/**
 * Postgres `inet` rejects malformed input, which would fail the insert. An
 * unparseable address is not worth losing the whole audit record over.
 */
function normalizeIp(ip: string | undefined): string | null {
  if (!ip) return null;

  // Express reports IPv4-mapped IPv6 for local connections; inet accepts it,
  // but the plain form is what an operator expects to search for.
  const cleaned = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return /^[0-9a-fA-F:.]+$/.test(cleaned) ? cleaned : null;
}
