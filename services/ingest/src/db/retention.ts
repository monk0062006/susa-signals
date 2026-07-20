import type { Pool } from 'pg';

/**
 * Retention and erasure.
 *
 * Session recordings are personal data. Storing them without a defined lifetime
 * and without the ability to delete one person's data on request is not a
 * missing feature — it is a state you cannot lawfully operate in under GDPR
 * Art. 17. That is why this ships alongside the storage layer rather than after
 * it.
 *
 * Both operations delete in bounded batches. A single unbounded DELETE over
 * months of accumulated replay takes a long lock and can stall live ingest; the
 * sweep is designed to be run repeatedly on a schedule instead.
 */

export interface RetentionPolicy {
  projectId: string;
  replayTtlDays: number | null;
  submissionTtlDays: number | null;
}

export interface SweepResult {
  replaySessionsDeleted: number;
  submissionsDeleted: number;
  orphanAttachmentsDeleted: number;
}

export interface ErasureResult {
  submissionsDeleted: number;
  replaySessionsDeleted: number;
  eventsDeleted: number;
}

/** How many rows one sweep pass removes per table. */
const BATCH = 500;

/** Uploads never linked to a submission are abandoned after this long. */
const ORPHAN_ATTACHMENT_HOURS = 24;

export class Retention {
  constructor(private readonly pool: Pool) {}

  async setPolicy(policy: RetentionPolicy): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO feedback.projects (id) VALUES ($1) ON CONFLICT (id) DO NOTHING
      `,
      [policy.projectId],
    );

    await this.pool.query(
      `
      INSERT INTO feedback.retention_policies (project_id, replay_ttl_days, submission_ttl_days)
      VALUES ($1, $2, $3)
      ON CONFLICT (project_id) DO UPDATE
        SET replay_ttl_days     = EXCLUDED.replay_ttl_days,
            submission_ttl_days = EXCLUDED.submission_ttl_days,
            updated_at          = now()
      `,
      [policy.projectId, policy.replayTtlDays, policy.submissionTtlDays],
    );
  }

  async getPolicy(projectId: string): Promise<RetentionPolicy | null> {
    const { rows } = await this.pool.query(
      `
      SELECT project_id, replay_ttl_days, submission_ttl_days
        FROM feedback.retention_policies
       WHERE project_id = $1
      `,
      [projectId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      projectId: row.project_id,
      replayTtlDays: row.replay_ttl_days,
      submissionTtlDays: row.submission_ttl_days,
    };
  }

  /**
   * Deletes everything past its policy's TTL.
   *
   * Projects with no policy, or a NULL TTL, are skipped — "keep indefinitely"
   * has to be a decision someone made, not something that happens because a
   * config value was missing.
   */
  async sweep(): Promise<SweepResult> {
    const replaySessionsDeleted = await this.sweepReplay();
    const submissionsDeleted = await this.sweepSubmissions();
    const orphanAttachmentsDeleted = await this.sweepOrphanAttachments();

    return { replaySessionsDeleted, submissionsDeleted, orphanAttachmentsDeleted };
  }

  private async sweepReplay(): Promise<number> {
    // Chunks cascade from the session row, so deleting sessions is sufficient.
    const { rowCount } = await this.pool.query(
      `
      DELETE FROM feedback.replay_sessions s
       USING feedback.retention_policies p
       WHERE s.project_id = p.project_id
         AND p.replay_ttl_days IS NOT NULL
         AND s.created_at < now() - make_interval(days => p.replay_ttl_days)
         AND s.id IN (
           SELECT s2.id
             FROM feedback.replay_sessions s2
             JOIN feedback.retention_policies p2 ON p2.project_id = s2.project_id
            WHERE p2.replay_ttl_days IS NOT NULL
              AND s2.created_at < now() - make_interval(days => p2.replay_ttl_days)
            LIMIT ${BATCH}
         )
      `,
    );
    return rowCount ?? 0;
  }

  private async sweepSubmissions(): Promise<number> {
    // Attachments cascade from the submission row.
    const { rowCount } = await this.pool.query(
      `
      DELETE FROM feedback.submissions s
       USING feedback.retention_policies p
       WHERE s.project_id = p.project_id
         AND p.submission_ttl_days IS NOT NULL
         AND s.received_at < now() - make_interval(days => p.submission_ttl_days)
         AND s.id IN (
           SELECT s2.id
             FROM feedback.submissions s2
             JOIN feedback.retention_policies p2 ON p2.project_id = s2.project_id
            WHERE p2.submission_ttl_days IS NOT NULL
              AND s2.received_at < now() - make_interval(days => p2.submission_ttl_days)
            LIMIT ${BATCH}
         )
      `,
    );
    return rowCount ?? 0;
  }

  /**
   * Reclaims uploads that never got linked to a submission — the user opened the
   * composer, a screenshot uploaded, then they hit Cancel. Without this the
   * table grows forever with images no one can reach.
   */
  private async sweepOrphanAttachments(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `
      DELETE FROM feedback.attachments
       WHERE id IN (
         SELECT id FROM feedback.attachments
          WHERE submission_id IS NULL
            AND created_at < now() - make_interval(hours => $1)
          LIMIT ${BATCH}
       )
      `,
      [ORPHAN_ATTACHMENT_HOURS],
    );
    return rowCount ?? 0;
  }

  /**
   * Erases everything belonging to one data subject — the Art. 17 path.
   *
   * Matches on email (case-insensitively, since users capitalise inconsistently
   * and a missed match means undeleted personal data) or on the host app's own
   * external id.
   *
   * Replay sessions linked to that subject's submissions are deleted too. A
   * recording is arguably the most identifying artefact here, so leaving it
   * behind while deleting the report would defeat the request.
   */
  async eraseSubject(
    projectId: string,
    subject: { email?: string; externalId?: string },
  ): Promise<ErasureResult> {
    if (!subject.email && !subject.externalId) {
      throw new Error('eraseSubject requires an email or externalId');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Collect sessions first: the link lives on the submission rows that are
      // about to be deleted.
      const { rows: sessionRows } = await client.query<{ session_id: string }>(
        `
        SELECT DISTINCT session_id
          FROM feedback.submissions
         WHERE project_id = $1
           AND session_id IS NOT NULL
           AND (
             ($2::text IS NOT NULL AND lower(reporter_email) = lower($2))
             OR ($3::text IS NOT NULL AND reporter_external_id = $3)
           )
        `,
        [projectId, subject.email ?? null, subject.externalId ?? null],
      );

      const { rowCount: submissionsDeleted } = await client.query(
        `
        DELETE FROM feedback.submissions
         WHERE project_id = $1
           AND (
             ($2::text IS NOT NULL AND lower(reporter_email) = lower($2))
             OR ($3::text IS NOT NULL AND reporter_external_id = $3)
           )
        `,
        [projectId, subject.email ?? null, subject.externalId ?? null],
      );

      let replaySessionsDeleted = 0;
      const sessionIds = sessionRows.map((row) => row.session_id);
      if (sessionIds.length > 0) {
        const { rowCount } = await client.query(
          `DELETE FROM feedback.replay_sessions WHERE project_id = $1 AND id = ANY($2::uuid[])`,
          [projectId, sessionIds],
        );
        replaySessionsDeleted = rowCount ?? 0;
      }

      // Analytics events carry the subject as `user_id`, set by identify().
      // Leaving them would mean a "delete my data" request that quietly kept a
      // full behavioural history — the largest row count of the three.
      const { rowCount: eventsDeleted } = await client.query(
        `
        DELETE FROM feedback.events
         WHERE project_id = $1
           AND user_id IS NOT NULL
           AND (
             ($2::text IS NOT NULL AND lower(user_id) = lower($2))
             OR ($3::text IS NOT NULL AND user_id = $3)
           )
        `,
        [projectId, subject.email ?? null, subject.externalId ?? null],
      );

      await client.query('COMMIT');

      return {
        submissionsDeleted: submissionsDeleted ?? 0,
        replaySessionsDeleted,
        eventsDeleted: eventsDeleted ?? 0,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Deletes one session outright, for a targeted "delete this recording" action. */
  async deleteReplaySession(projectId: string, sessionId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM feedback.replay_sessions WHERE project_id = $1 AND id = $2`,
      [projectId, sessionId],
    );
    return (rowCount ?? 0) > 0;
  }
}
