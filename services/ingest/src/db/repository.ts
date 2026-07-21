import type { Pool, PoolClient } from 'pg';
import type { ReplayChunk, Submission } from '../validate.js';
import { NoEncryption, PLAINTEXT_KEY_ID, type Encryptor } from './encryption.js';

export interface StoredSubmission extends Submission {
  attachments: StoredAttachment[];
}

export interface StoredAttachment {
  id: string;
  kind: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
}

export interface ReplaySessionSummary {
  sessionId: string;
  chunkCount: number;
  eventCount: number;
  byteSize: number;
  complete: boolean;
  startedAt: string;
  lastChunkAt: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque cursor for the next page, or null at the end. */
  nextCursor: string | null;
}

/**
 * All database access for the feedback core.
 *
 * Callers never see SQL and never see a connection. Every method that touches
 * more than one table runs in a transaction, because the alternative — a
 * submission row with no attachments linked, or a chunk counted twice — is the
 * kind of corruption that only shows up as a confusing dashboard weeks later.
 */
export class Repository {
  constructor(
    private readonly pool: Pool,
    /**
     * Encrypts attachment bytes and replay events at rest. Defaults to a no-op
     * so an existing deployment upgrades without key material, and so local
     * development needs none.
     */
    private readonly crypto: Encryptor = new NoEncryption(),
  ) {}

  // --- projects -------------------------------------------------------------

  /**
   * Projects are created on first use rather than requiring provisioning. With
   * no auth layer, demanding a pre-registered project would just be a lookup
   * that always succeeds; on first write it is one upsert.
   */
  async ensureProject(projectId: string, client?: PoolClient): Promise<void> {
    const runner = client ?? this.pool;
    await runner.query(
      `INSERT INTO feedback.projects (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [projectId],
    );
  }

  // --- submissions ----------------------------------------------------------

  /**
   * Inserts a submission and links its attachments.
   *
   * Returns false when the id already exists. The SDK's offline queue replays on
   * every app start, so duplicate delivery is the normal case — dedupe here is
   * what stops one bug becoming five tickets in the host product.
   */
  async saveSubmission(submission: Submission): Promise<boolean> {
    return this.transaction(async (client) => {
      await this.ensureProject(submission.projectId, client);

      const reporter = submission.reporter ?? null;

      const { rowCount } = await client.query(
        `
        INSERT INTO feedback.submissions (
          id, project_id, payload_type, kind, title, description,
          payload, device, reporter, custom_data, consent, session_id,
          reporter_email, reporter_external_id, created_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, to_timestamp($15::double precision / 1000))
        ON CONFLICT (id) DO NOTHING
        `,
        [
          submission.id,
          submission.projectId,
          submission.payload.type,
          typeof submission.payload.kind === 'string' ? submission.payload.kind : null,
          typeof submission.payload.title === 'string' ? submission.payload.title : '',
          typeof submission.payload.description === 'string' ? submission.payload.description : null,
          JSON.stringify(submission.payload),
          JSON.stringify(submission.device),
          reporter ? JSON.stringify(reporter) : null,
          submission.customData ? JSON.stringify(submission.customData) : null,
          submission.consent ? JSON.stringify(submission.consent) : null,
          submission.sessionId ?? null,
          reporter?.email ?? null,
          reporter?.externalId ?? null,
          submission.createdAt,
        ],
      );

      // ON CONFLICT DO NOTHING reports 0 rows: this id was already delivered.
      if (rowCount === 0) return false;

      // Link previously-uploaded attachments. Scoped by project so a caller
      // cannot attach another project's blob to their own submission.
      //
      // Dimensions are carried over here rather than captured at upload time:
      // the upload endpoint receives raw bytes and would have to decode the PNG
      // header to learn them, whereas the client already knows and sends them
      // with the submission.
      const attachments = (submission.attachments ?? []).filter(
        (a): a is Record<string, unknown> => typeof a === 'object' && a !== null,
      );

      for (const attachment of attachments) {
        const id = attachment.id;
        if (typeof id !== 'string') continue;

        await client.query(
          `
          UPDATE feedback.attachments
             SET submission_id = $1,
                 width  = COALESCE($4::integer, width),
                 height = COALESCE($5::integer, height)
           WHERE id = $2::uuid
             AND project_id = $3
             AND submission_id IS NULL
          `,
          [
            submission.id,
            id,
            submission.projectId,
            typeof attachment.width === 'number' ? attachment.width : null,
            typeof attachment.height === 'number' ? attachment.height : null,
          ],
        );
      }

      return true;
    });
  }

  /**
   * Newest-first page of submissions, ordered by *arrival* time.
   *
   * `received_at` (server clock), not `created_at` (client clock). The client
   * value is untrusted: a device with a skewed clock could otherwise pin itself
   * to the top of every triage queue, and an offline-queued report would sort
   * into the past where nobody would see it on delivery. Keyset pagination also
   * needs a monotonic server-side column to be stable.
   *
   * Keyset rather than OFFSET: submissions arrive continuously, and OFFSET would
   * skip or repeat rows as the list shifts under the reader.
   */
  async listSubmissions(
    projectId: string,
    // `| undefined` on both, so callers can forward optional query params
    // directly without stripping undefined first.
    options: { limit?: number | undefined; cursor?: string | undefined } = {},
  ): Promise<Page<StoredSubmission>> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const cursor = decodeCursor(options.cursor);

    const { rows } = await this.pool.query(
      `
      SELECT
        s.id, s.project_id, s.payload_type, s.payload, s.device,
        s.reporter, s.custom_data, s.consent, s.session_id,
        extract(epoch FROM s.created_at) * 1000  AS created_ms,
        extract(epoch FROM s.received_at) * 1000 AS received_ms,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', a.id, 'kind', a.kind, 'mimeType', a.mime_type,
              'byteSize', a.byte_size, 'width', a.width, 'height', a.height
            ) ORDER BY a.created_at)
            FROM feedback.attachments a
            WHERE a.submission_id = s.id
          ),
          '[]'::json
        ) AS attachments
      FROM feedback.submissions s
      WHERE s.project_id = $1
        AND ($2::timestamptz IS NULL OR (s.received_at, s.id) < ($2::timestamptz, $3::uuid))
      ORDER BY s.received_at DESC, s.id DESC
      LIMIT $4
      `,
      [projectId, cursor?.receivedAt ?? null, cursor?.id ?? null, limit + 1],
    );

    // Over-fetch by one to learn whether another page exists without a count query.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const last = page.at(-1);
    return {
      items: page.map(rowToSubmission),
      nextCursor:
        hasMore && last
          ? encodeCursor({
              receivedAt: new Date(Number(last.received_ms)).toISOString(),
              id: last.id,
            })
          : null,
    };
  }

  async getSubmission(projectId: string, id: string): Promise<StoredSubmission | null> {
    const { rows } = await this.pool.query(
      `
      SELECT
        s.id, s.project_id, s.payload_type, s.payload, s.device,
        s.reporter, s.custom_data, s.consent, s.session_id,
        extract(epoch FROM s.created_at) * 1000  AS created_ms,
        extract(epoch FROM s.received_at) * 1000 AS received_ms,
        COALESCE(
          (
            SELECT json_agg(json_build_object(
              'id', a.id, 'kind', a.kind, 'mimeType', a.mime_type,
              'byteSize', a.byte_size, 'width', a.width, 'height', a.height
            ) ORDER BY a.created_at)
            FROM feedback.attachments a
            WHERE a.submission_id = s.id
          ),
          '[]'::json
        ) AS attachments
      FROM feedback.submissions s
      WHERE s.project_id = $1 AND s.id = $2
      `,
      [projectId, id],
    );

    const row = rows[0];
    return row ? rowToSubmission(row) : null;
  }

  // --- attachments ----------------------------------------------------------

  async saveAttachment(input: {
    id: string;
    projectId: string;
    kind: string;
    mimeType: string;
    bytes: Buffer;
    width?: number | null;
    height?: number | null;
  }): Promise<void> {
    await this.transaction(async (client) => {
      await this.ensureProject(input.projectId, client);
      // byte_size records the PLAINTEXT length. The dashboard shows it to a
      // human, and "how big is this screenshot" should not change because the
      // storage layer added a 28-byte envelope.
      const sealed = this.crypto.encrypt(input.bytes);

      await client.query(
        `
        INSERT INTO feedback.attachments
          (id, project_id, kind, mime_type, byte_size, width, height, bytes, encryption_key_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `,
        [
          input.id,
          input.projectId,
          input.kind,
          input.mimeType,
          input.bytes.byteLength,
          input.width ?? null,
          input.height ?? null,
          sealed.bytes,
          sealed.keyId,
        ],
      );
    });
  }

  async readAttachment(
    projectId: string,
    id: string,
  ): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const { rows } = await this.pool.query<{
      bytes: Buffer;
      mime_type: string;
      encryption_key_id: string;
    }>(
      `SELECT bytes, mime_type, encryption_key_id FROM feedback.attachments
        WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );

    const row = rows[0];
    if (!row) return null;

    const plaintext = this.crypto.decrypt(row.bytes, row.encryption_key_id);
    // null means the key is missing or the ciphertext failed authentication.
    // Surfacing that as "not found" is correct: there is nothing servable, and
    // returning undecrypted bytes to a browser would be worse than a 404.
    if (!plaintext) return null;

    return { bytes: plaintext, mimeType: row.mime_type };
  }

  // --- replay ---------------------------------------------------------------

  /**
   * Appends one chunk and updates the session rollup atomically.
   *
   * Redelivery is idempotent by primary key. Critically, the counters are only
   * advanced when the insert actually happened — incrementing on a duplicate
   * would inflate every retried session's event count and corrupt the size cap.
   */
  async appendReplayChunk(chunk: ReplayChunk): Promise<{ inserted: boolean; byteSize: number }> {
    return this.transaction(async (client) => {
      await this.ensureProject(chunk.projectId, client);

      await client.query(
        `
        INSERT INTO feedback.replay_sessions (id, project_id, started_at)
        VALUES ($1, $2, to_timestamp($3::double precision / 1000))
        ON CONFLICT (id) DO NOTHING
        `,
        [chunk.sessionId, chunk.projectId, chunk.startedAt],
      );

      const eventsJson = JSON.stringify(chunk.events);

      // Replay events are a recording of the user's screen — on web literally
      // the DOM, on native a reference to frame images. They belong under the
      // same protection as the screenshots themselves.
      const sealed = this.crypto.enabled
        ? this.crypto.encrypt(Buffer.from(eventsJson, 'utf8'))
        : null;

      const inserted = await client.query(
        `
        INSERT INTO feedback.replay_chunks
          (session_id, seq, events, events_encrypted, encryption_key_id,
           started_at, ended_at, final)
        VALUES ($1, $2, $3::jsonb, $4, $5,
                to_timestamp($6::double precision / 1000),
                to_timestamp($7::double precision / 1000),
                $8)
        ON CONFLICT (session_id, seq) DO NOTHING
        `,
        [
          chunk.sessionId,
          chunk.seq,
          sealed ? null : eventsJson,
          sealed ? sealed.bytes : null,
          sealed ? sealed.keyId : PLAINTEXT_KEY_ID,
          chunk.startedAt,
          chunk.endedAt,
          chunk.final,
        ],
      );

      const isNew = inserted.rowCount === 1;

      const { rows } = await client.query<{ byte_size: number }>(
        `
        UPDATE feedback.replay_sessions
           SET chunk_count   = chunk_count + $2,
               event_count   = event_count + $3,
               byte_size     = byte_size + $4,
               last_chunk_at = now(),
               complete      = complete OR $5
         WHERE id = $1
        RETURNING byte_size
        `,
        [
          chunk.sessionId,
          isNew ? 1 : 0,
          isNew ? chunk.events.length : 0,
          isNew ? Buffer.byteLength(eventsJson, 'utf8') : 0,
          chunk.final,
        ],
      );

      return { inserted: isNew, byteSize: rows[0]?.byte_size ?? 0 };
    });
  }

  /**
   * Reassembles a session's events in seq order.
   *
   * Ordering happens in SQL rather than in JS because chunks arrive out of order
   * over an unreliable network, and playback of misordered events is worse than
   * no playback — it looks like the user did things they never did.
   */
  async readReplaySession(
    projectId: string,
    sessionId: string,
  ): Promise<{ events: unknown[]; chunks: number; final: boolean } | null> {
    const { rows: sessionRows } = await this.pool.query<{ complete: boolean }>(
      `SELECT complete FROM feedback.replay_sessions WHERE id = $1 AND project_id = $2`,
      [sessionId, projectId],
    );
    if (sessionRows.length === 0) return null;

    const { rows } = await this.pool.query<{
      events: unknown[] | null;
      events_encrypted: Buffer | null;
      encryption_key_id: string;
    }>(
      `
      SELECT events, events_encrypted, encryption_key_id
        FROM feedback.replay_chunks
       WHERE session_id = $1
       ORDER BY seq ASC
      `,
      [sessionId],
    );

    if (rows.length === 0) return null;

    const events: unknown[] = [];
    for (const row of rows) {
      if (row.events_encrypted) {
        const plaintext = this.crypto.decrypt(row.events_encrypted, row.encryption_key_id);
        // A chunk that cannot be decrypted is skipped rather than failing the
        // whole session: a recording with a gap is still worth watching, and a
        // rotated-away key should not make every older session unplayable.
        if (!plaintext) continue;
        try {
          events.push(...(JSON.parse(plaintext.toString('utf8')) as unknown[]));
        } catch {
          continue;
        }
      } else if (row.events) {
        events.push(...row.events);
      }
    }

    return {
      events,
      chunks: rows.length,
      final: sessionRows[0]?.complete ?? false,
    };
  }

  async getReplaySummary(
    projectId: string,
    sessionId: string,
  ): Promise<ReplaySessionSummary | null> {
    const { rows } = await this.pool.query(
      `
      SELECT id, chunk_count, event_count, byte_size, complete,
             started_at, last_chunk_at
        FROM feedback.replay_sessions
       WHERE id = $1 AND project_id = $2
      `,
      [sessionId, projectId],
    );

    const row = rows[0];
    if (!row) return null;

    return {
      sessionId: row.id,
      chunkCount: row.chunk_count,
      eventCount: row.event_count,
      byteSize: row.byte_size,
      complete: row.complete,
      startedAt: row.started_at.toISOString(),
      lastChunkAt: row.last_chunk_at.toISOString(),
    };
  }

  // --- helpers --------------------------------------------------------------

  /** Runs `fn` in a transaction, rolling back on any throw. */
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      // Rollback can itself fail on a dead connection; the original error is the
      // one worth surfacing, so swallow this one.
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
}

function rowToSubmission(row: Record<string, unknown>): StoredSubmission {
  const submission: StoredSubmission = {
    id: row.id as string,
    projectId: row.project_id as string,
    payload: row.payload as StoredSubmission['payload'],
    device: row.device as Record<string, unknown>,
    attachments: (row.attachments as StoredAttachment[]) ?? [],
    createdAt: Number(row.created_ms),
    receivedAt: Number(row.received_ms),
  };

  // Assigned conditionally rather than as `?? undefined`: under
  // exactOptionalPropertyTypes an explicit undefined is not the same as absent,
  // and NULL columns must serialize as omitted fields, not `"reporter": null`.
  if (row.reporter) {
    submission.reporter = row.reporter as NonNullable<StoredSubmission['reporter']>;
  }
  if (row.custom_data) submission.customData = row.custom_data as Record<string, unknown>;
  if (row.consent) submission.consent = row.consent as Record<string, unknown>;
  if (row.session_id) submission.sessionId = row.session_id as string;

  return submission;
}

interface Cursor {
  receivedAt: string;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    // A malformed cursor must not become a SQL error; treat it as "start over".
    if (typeof parsed?.receivedAt !== 'string' || typeof parsed?.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}
