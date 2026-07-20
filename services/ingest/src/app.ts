import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { Repository } from './db/repository.js';
import { Retention } from './db/retention.js';
import { ValidationError, parseReplayChunk, parseSubmission } from './validate.js';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Ceiling per replay session. Storage cost is the constraint, not correctness. */
const MAX_SESSION_BYTES = 25 * 1024 * 1024;

export interface AppOptions {
  pool: Pool;
  /**
   * Serve the bundled dashboard. Off by default: when this core is mounted
   * inside an existing product, that product owns the UI and an extra static
   * route would be surprising.
   */
  serveDashboard?: boolean;
  /**
   * Origins allowed to post from a browser. `true` allows any, which is only
   * appropriate for local development — the SDK runs on customer pages, so an
   * open policy lets any site write into any project it can name.
   */
  allowedOrigins?: string[] | true;
}

/**
 * Builds the ingest app as an Express router-bearing application.
 *
 * Exported as a factory taking a Pool rather than a module that owns its own
 * connection, so the host product can mount these routes on its existing server,
 * inside its existing pool, under whatever auth it already has.
 */
export function createIngestApp(options: AppOptions): express.Express {
  const repo = new Repository(options.pool);
  const retention = new Retention(options.pool);

  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(cors(options.allowedOrigins ?? true));

  if (options.serveDashboard) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.resolve(here, '../public'), { index: 'index.html' }));
  }

  // --- health ---------------------------------------------------------------

  app.get('/health', async (_req, res) => {
    try {
      // Touches the database, so this fails when the service is up but its
      // dependency is not — the case a load balancer actually needs to know.
      await options.pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  // --- uploads --------------------------------------------------------------

  app.post('/v1/uploads', upload.single('file'), async (req, res) => {
    try {
      const project = projectId(req);
      if (!req.file) {
        res.status(400).json({ error: 'No file provided' });
        return;
      }

      // Trusting the client's content-type would let a caller store scripts and
      // have them served back from this origin.
      if (!/^image\/(png|jpeg|webp)$/.test(req.file.mimetype)) {
        res.status(415).json({ error: 'Unsupported media type' });
        return;
      }

      const id = randomUUID();
      await repo.saveAttachment({
        id,
        projectId: project,
        kind: 'screenshot',
        mimeType: req.file.mimetype,
        bytes: req.file.buffer,
      });

      res.status(201).json({ id });
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * Project scoped in the path, not the `x-project-id` header.
   *
   * Attachments are loaded by the browser as `<img src>`, and an img tag cannot
   * attach custom headers. Header-scoping this route makes every screenshot
   * silently fail to render while the JSON API keeps working — which is exactly
   * how it broke the first time.
   */
  app.get('/v1/projects/:projectId/attachments/:id', async (req, res) => {
    try {
      const blob = await repo.readAttachment(req.params.projectId, req.params.id);
      if (!blob) {
        res.sendStatus(404);
        return;
      }
      res.setHeader('content-type', blob.mimeType);
      // Defense in depth: even with the mime allowlist, never let a stored blob
      // be sniffed into an executable type.
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'private, max-age=3600');
      res.send(blob.bytes);
    } catch (err) {
      handleError(err, res);
    }
  });

  // --- submissions ----------------------------------------------------------

  app.post('/v1/reports', async (req, res) => {
    try {
      const project = projectId(req);
      const submission = parseSubmission(req.body, project);

      const created = await repo.saveSubmission(submission);
      if (!created) {
        // Replay from the offline queue. 200, not 409 — the client's goal
        // ("this is delivered") is satisfied, so it should stop retrying.
        res.status(200).json({ id: submission.id, duplicate: true });
        return;
      }

      res.status(201).json({ id: submission.id, duplicate: false });
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get('/v1/reports', async (req, res) => {
    try {
      const page = await repo.listSubmissions(projectId(req), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        cursor: typeof req.query.cursor === 'string' ? req.query.cursor : undefined,
      });
      // `reports` for backwards compatibility with the shipped dashboard bundle.
      res.json({ reports: page.items, nextCursor: page.nextCursor });
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get('/v1/reports/:id', async (req, res) => {
    try {
      const submission = await repo.getSubmission(projectId(req), req.params.id);
      if (!submission) {
        res.sendStatus(404);
        return;
      }
      res.json(submission);
    } catch (err) {
      handleError(err, res);
    }
  });

  // --- replay ---------------------------------------------------------------

  app.post('/v1/replay/chunks', async (req, res) => {
    try {
      const project = projectId(req);
      const chunk = parseReplayChunk(req.body, project);

      const { inserted, byteSize } = await repo.appendReplayChunk(chunk);

      // Signal the SDK to stop rather than silently absorbing unbounded data.
      // 413 is non-retryable, so the recorder drops it and gives up cleanly.
      if (byteSize > MAX_SESSION_BYTES) {
        res.status(413).json({ error: 'Session size limit reached' });
        return;
      }

      res.status(202).json({ seq: chunk.seq, accepted: true, duplicate: !inserted });
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get('/v1/replay/:sessionId', async (req, res) => {
    try {
      const session = await repo.readReplaySession(projectId(req), req.params.sessionId);
      if (!session) {
        res.sendStatus(404);
        return;
      }
      res.json(session);
    } catch (err) {
      handleError(err, res);
    }
  });

  app.delete('/v1/replay/:sessionId', async (req, res) => {
    try {
      const deleted = await retention.deleteReplaySession(projectId(req), req.params.sessionId);
      res.status(deleted ? 204 : 404).end();
    } catch (err) {
      handleError(err, res);
    }
  });

  // --- retention & erasure --------------------------------------------------

  app.put('/v1/retention', async (req, res) => {
    try {
      const project = projectId(req);
      const body = req.body as { replayTtlDays?: unknown; submissionTtlDays?: unknown };

      await retention.setPolicy({
        projectId: project,
        replayTtlDays: optionalPositiveInt(body.replayTtlDays, 'replayTtlDays'),
        submissionTtlDays: optionalPositiveInt(body.submissionTtlDays, 'submissionTtlDays'),
      });

      res.status(200).json(await retention.getPolicy(project));
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get('/v1/retention', async (req, res) => {
    try {
      res.json(await retention.getPolicy(projectId(req)));
    } catch (err) {
      handleError(err, res);
    }
  });

  /**
   * Art. 17 erasure. Exposed as an endpoint so the host product can wire its own
   * "delete my data" flow straight through without reaching into the schema.
   */
  app.post('/v1/erasure', async (req, res) => {
    try {
      const project = projectId(req);
      const body = req.body as { email?: unknown; externalId?: unknown };

      const email = typeof body.email === 'string' ? body.email : undefined;
      const externalId = typeof body.externalId === 'string' ? body.externalId : undefined;
      if (!email && !externalId) {
        throw new ValidationError('email or externalId is required');
      }

      const subject: { email?: string; externalId?: string } = {};
      if (email) subject.email = email;
      if (externalId) subject.externalId = externalId;

      res.json(await retention.eraseSubject(project, subject));
    } catch (err) {
      handleError(err, res);
    }
  });

  return app;
}

/** Exposed so a host product can run the sweep from its own scheduler. */
export function createRetention(pool: Pool): Retention {
  return new Retention(pool);
}

// --- helpers ----------------------------------------------------------------

function cors(allowed: string[] | true): express.RequestHandler {
  return (req, res, next) => {
    const origin = req.header('origin');

    if (allowed === true) {
      res.setHeader('access-control-allow-origin', '*');
    } else if (origin && allowed.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      // Tells caches the response varies per origin; without it a CDN can serve
      // one origin's allow header to another.
      res.setHeader('vary', 'Origin');
    }

    res.setHeader('access-control-allow-headers', 'content-type,x-project-id,idempotency-key');
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  };
}

function projectId(req: express.Request): string {
  const id = req.header('x-project-id');
  if (!id) throw new ValidationError('Missing x-project-id header');
  if (id.length > 200) throw new ValidationError('x-project-id too long');
  return id;
}

function optionalPositiveInt(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive integer or null`);
  }
  return value;
}

function handleError(err: unknown, res: express.Response): void {
  if (err instanceof ValidationError) {
    // 4xx tells the SDK queue this is permanent and to stop retrying.
    res.status(400).json({ error: err.message });
    return;
  }
  console.error('[ingest] unhandled', err);
  res.status(500).json({ error: 'Internal error' });
}
