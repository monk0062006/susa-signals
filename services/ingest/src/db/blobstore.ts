import type { Pool } from 'pg';

/**
 * Where attachment bytes actually live.
 *
 * Postgres `bytea` is the default because it keeps deployment to one dependency,
 * and for screenshots it is genuinely fine — tens to a few hundred KB, a handful
 * per user. Session replay changes the arithmetic completely: at 1fps a
 * fifteen-minute session is ~900 frames, so a thousand sessions is close to a
 * million rows of image data. Postgres will store that and then make every
 * backup, restore and vacuum painful.
 *
 * So bytes move behind this seam. The row in `attachments` stays the source of
 * truth for metadata and access control; only the payload relocates.
 */
export interface BlobStore {
  put(key: string, bytes: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  delete(key: string): Promise<void>;
  /** Identifies which backend a stored row used, so a migration can be staged. */
  readonly backend: string;
}

/**
 * Default. Bytes in the `attachments` row itself.
 *
 * Transactional with the metadata, which is its real advantage: an attachment
 * row can never reference bytes that failed to store, a consistency an external
 * store cannot offer without a two-phase dance.
 */
export class PostgresBlobStore implements BlobStore {
  readonly backend = 'postgres';

  constructor(private readonly pool: Pool) {}

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    // Written by Repository.saveAttachment inside its own transaction; this
    // path exists for backfills and tests.
    await this.pool.query(
      `UPDATE feedback.attachments SET bytes = $2, mime_type = $3 WHERE id = $1`,
      [key, bytes, mimeType],
    );
  }

  async get(key: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const { rows } = await this.pool.query<{ bytes: Buffer | null; mime_type: string }>(
      `SELECT bytes, mime_type FROM feedback.attachments WHERE id = $1`,
      [key],
    );

    const row = rows[0];
    if (!row?.bytes) return null;
    return { bytes: row.bytes, mimeType: row.mime_type };
  }

  async delete(key: string): Promise<void> {
    // Row deletion cascades from submissions; this only clears the payload,
    // which is what a "shrink the database" backfill wants.
    await this.pool.query(`UPDATE feedback.attachments SET bytes = ''::bytea WHERE id = $1`, [key]);
  }
}

export interface S3Config {
  bucket: string;
  region: string;
  /** For S3-compatible services — R2, MinIO, Spaces. */
  endpoint?: string;
  prefix?: string;
}

/**
 * S3-compatible object storage.
 *
 * Takes an injected client rather than importing the AWS SDK, so this core does
 * not force that dependency on a host product that uses a different one — or
 * none at all. Anything implementing the three calls below works, including a
 * thin fetch-based signer.
 */
export interface S3Like {
  putObject(input: { Bucket: string; Key: string; Body: Buffer; ContentType: string }): Promise<unknown>;
  getObject(input: { Bucket: string; Key: string }): Promise<{ Body?: unknown; ContentType?: string }>;
  deleteObject(input: { Bucket: string; Key: string }): Promise<unknown>;
}

export class S3BlobStore implements BlobStore {
  readonly backend = 's3';

  constructor(
    private readonly client: S3Like,
    private readonly config: S3Config,
  ) {}

  private keyFor(id: string): string {
    // Sharded by the id's first characters. A flat prefix with millions of
    // objects degrades listing on several S3-compatible backends.
    const prefix = this.config.prefix ? `${this.config.prefix.replace(/\/+$/, '')}/` : '';
    return `${prefix}${id.slice(0, 2)}/${id.slice(2, 4)}/${id}`;
  }

  async put(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.client.putObject({
      Bucket: this.config.bucket,
      Key: this.keyFor(key),
      Body: bytes,
      ContentType: mimeType,
    });
  }

  async get(key: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    try {
      const result = await this.client.getObject({
        Bucket: this.config.bucket,
        Key: this.keyFor(key),
      });

      const bytes = await toBuffer(result.Body);
      if (!bytes) return null;

      return { bytes, mimeType: result.ContentType ?? 'application/octet-stream' };
    } catch {
      // A missing object is a 404 to the caller, not a 500. Object stores signal
      // absence by throwing, and treating that as an outage would turn every
      // expired retention deletion into a page.
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.deleteObject({
      Bucket: this.config.bucket,
      Key: this.keyFor(key),
    });
  }
}

/** Normalizes the several shapes an S3 client may return a body in. */
async function toBuffer(body: unknown): Promise<Buffer | null> {
  if (!body) return null;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);

  // AWS SDK v3 returns a stream with this helper attached.
  const maybe = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof maybe.transformToByteArray === 'function') {
    return Buffer.from(await maybe.transformToByteArray());
  }

  // Node readable stream.
  const stream = body as AsyncIterable<Uint8Array>;
  if (typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function') {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  }

  return null;
}
