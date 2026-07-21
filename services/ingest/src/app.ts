import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import type { Pool } from 'pg';
import { AuditLog } from './db/audit.js';
import { encryptorFromEnv, type Encryptor } from './db/encryption.js';
import { Events, parseEventBatch } from './db/events.js';
import { Repository } from './db/repository.js';
import { Retention } from './db/retention.js';
import { Studies } from './db/studies.js';
import { createLogger, requestLogging, Metrics, type Logger } from './observability.js';
import { DEFAULT_LIMITS, RateLimiter, rateLimit, type RateLimitConfig } from './ratelimit.js';
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
  /** Injected so the host product can route these lines into its own stack. */
  logger?: Logger;
  /**
   * Per-project throttles. Traffic classes are budgeted separately so an
   * analytics flood cannot starve bug reports. Pass `false` only if the host
   * product already rate limits upstream.
   */
  rateLimits?: RateLimitConfig | false;
  /**
   * Encrypts attachments and replay events at rest. Defaults to reading
   * SIGNALS_ENCRYPTION_KEY from the environment, and to no-op when unset so an
   * existing deployment upgrades without key material.
   */
  encryptor?: Encryptor;
  /**
   * Identifies the human behind a request, for the audit trail. The host
   * product owns identity, so it supplies this — usually from its own session.
   */
  actorFor?: (req: express.Request) => string | undefined;
}

/**
 * Builds the ingest app as an Express router-bearing application.
 *
 * Exported as a factory taking a Pool rather than a module that owns its own
 * connection, so the host product can mount these routes on its existing server,
 * inside its existing pool, under whatever auth it already has.
 */
export function createIngestApp(options: AppOptions): express.Express {
  const crypto = options.encryptor ?? encryptorFromEnv();
  const repo = new Repository(options.pool, crypto);
  const retention = new Retention(options.pool);
  const studies = new Studies(options.pool);
  const events = new Events(options.pool);

  const logger = options.logger ?? createLogger();
  const audit = new AuditLog(options.pool, (message) => logger.warn(message));
  const actorFor = options.actorFor ?? (() => undefined);

  /** Common audit fields for a request. */
  const who = (req: express.Request) => ({
    actor: actorFor(req),
    requestId: req.requestId,
    ip: req.ip,
  });
  const metrics = new Metrics();
  const limiter =
    options.rateLimits === false
      ? null
      : new RateLimiter(options.rateLimits ?? DEFAULT_LIMITS, () => Date.now(), metrics);

  /** No-op when limiting is disabled, so route definitions stay uniform. */
  const limit = (traffic: Parameters<typeof rateLimit>[1], cost?: (req: express.Request) => number) =>
    limiter ? rateLimit(limiter, traffic, cost) : ((_req, _res, next) => next()) as express.RequestHandler;

  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.use(requestLogging(logger));
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
      res.json({ ok: true, encryptionAtRest: crypto.enabled });
    } catch {
      res.status(503).json({ ok: false, error: 'database unavailable' });
    }
  });

  app.get('/metrics', (_req, res) => {
    res.json({ counters: metrics.snapshot(), rateLimitBuckets: limiter?.size() ?? 0 });
  });

  // --- uploads --------------------------------------------------------------

  app.post('/v1/uploads', limit('uploads'), upload.single('file'), async (req, res) => {
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
      handleError(err, res, req);
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

      audit.record({
        projectId: req.params.projectId,
        action: 'attachment.read',
        subjectType: 'attachment',
        subjectId: req.params.id,
        ...who(req),
      });

      res.send(blob.bytes);
    } catch (err) {
      handleError(err, res, req);
    }
  });

  // --- submissions ----------------------------------------------------------

  app.post('/v1/reports', limit('reports'), async (req, res) => {
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
      handleError(err, res, req);
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
      handleError(err, res, req);
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
      handleError(err, res, req);
    }
  });

  // --- replay ---------------------------------------------------------------

  app.post('/v1/replay/chunks', limit('replay'), async (req, res) => {
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
      handleError(err, res, req);
    }
  });

  app.get('/v1/replay/:sessionId', async (req, res) => {
    try {
      const session = await repo.readReplaySession(projectId(req), req.params.sessionId);
      if (!session) {
        res.sendStatus(404);
        return;
      }

      // A replay is a recording of a person. "Which of your staff watched this"
      // is a question a customer is entitled to have answered.
      audit.record({
        projectId: projectId(req),
        action: 'replay.read',
        subjectType: 'replay_session',
        subjectId: req.params.sessionId,
        detail: { events: session.events.length, chunks: session.chunks },
        ...who(req),
      });

      res.json(session);
    } catch (err) {
      handleError(err, res, req);
    }
  });

  app.delete('/v1/replay/:sessionId', async (req, res) => {
    try {
      const deleted = await retention.deleteReplaySession(projectId(req), req.params.sessionId);
      res.status(deleted ? 204 : 404).end();
    } catch (err) {
      handleError(err, res, req);
    }
  });

  // --- analytics ------------------------------------------------------------

  /**
   * Batch ingest. Returns 202 rather than 201: the SDK does not wait on this
   * and has nothing useful to do with a per-event result.
   */
  app.post(
    '/v1/events',
    // Cost is the batch size: a 500-event batch consumes 500 tokens, so the
    // limit tracks work rather than request count.
    limit('events', (req) => {
      const body = req.body as { events?: unknown[] };
      return Array.isArray(body?.events) ? Math.max(body.events.length, 1) : 1;
    }),
    async (req, res) => {
    try {
      const project = projectId(req);
      const { events: batch, device } = parseEventBatch(req.body);

      const { inserted } = await events.insertBatch(project, batch, device);
      metrics.increment('events.inserted', inserted);
      res.status(202).json({ received: batch.length, inserted });
    } catch (err) {
      handleError(err, res, req);
    }
  },
  );

  app.get('/v1/events', async (req, res) => {
    try {
      res.json({
        events: await events.recent(
          projectId(req),
          req.query.limit ? Number(req.query.limit) : undefined,
        ),
      });
    } catch (err) {
      handleError(err, res, req);
    }
  });

  app.get('/v1/events/counts', async (req, res) => {
    try {
      res.json({
        counts: await events.counts(
          projectId(req),
          req.query.days ? Number(req.query.days) : undefined,
        ),
      });
    } catch (err) {
      handleError(err, res, req);
    }
  });

  app.get('/v1/events/timeseries', async (req, res) => {
    try {
      res.json({
        points: await events.timeseries(projectId(req), {
          name: typeof req.query.name === 'string' ? req.query.name : undefined,
          days: req.query.days ? Number(req.query.days) : undefined,
        }),
      });
    } catch (err) {
      handleError(err, res, req);
    }
  });

  // --- studies --------------------------------------------------------------

  app.get('/v1/studies', async (req, res) => {
    try {
      res.json({ studies: await studies.list(projectId(req)) });
    } catch (err) {
      handleError(err, res, req);
    }
  });

  /**
   * Fetched by the SDK before presenting a survey, so wording can change
   * without the host product shipping a release.
   */
  app.get('/v1/studies/:id', async (req, res) => {
    try {
      const study = await studies.get(projectId(req), req.params.id);
      if (!study) {
        res.sendStatus(404);
        return;
      }
      // A paused study must not be presented to users, but stays readable so
      // existing responses keep their context in the dashboard.
      if (!study.active) {
        res.status(409).json({ error: 'Study is not active' });
        return;
      }
      res.json(study);
    } catch (err) {
      handleError(err, res, req);
    }
  });

  app.put('/v1/studies/:id', async (req, res) => {
    try {
      const project = projectId(req);
      const body = req.body as Record<string, unknown>;

      const study = await studies.upsert({
        id: req.params.id,
        projectId: project,
        name: typeof body.name === 'string' ? body.name : req.params.id,
        questions: Array.isArray(body.questions) ? body.questions : [],
        intro: typeof body.intro === 'string' ? body.intro : undefined,
        thanks: typeof body.thanks === 'string' ? body.thanks : undefined,
        active: typeof body.active === 'boolean' ? body.active : undefined,
      });

      res.status(200).json(study);
    } catch (err) {
      handleError(err, res, req);
    }
  });

  app.delete('/v1/studies/:id', async (req, res) => {
    try {
      const deleted = await studies.delete(projectId(req), req.params.id);
      res.status(deleted ? 204 : 404).end();
    } catch (err) {
      handleError(err, res, req);
    }
  });

  /** Aggregated responses, for the dashboard's study view. */
  app.get('/v1/studies/:id/results', async (req, res) => {
    try {
      const project = projectId(req);
      const study = await studies.get(project, req.params.id);
      if (!study) {
        res.sendStatus(404);
        return;
      }
      res.json({ study, results: await studies.results(project, req.params.id) });
    } catch (err) {
      handleError(err, res, req);
    }
  });

  app.get('/v1/audit', async (req, res) => {
    try {
      res.json(
        await audit.query(projectId(req), {
          action: typeof req.query.action === 'string' ? req.query.action : undefined,
          subjectId: typeof req.query.subjectId === 'string' ? req.query.subjectId : undefined,
          actor: typeof req.query.actor === 'string' ? req.query.actor : undefined,
          limit: req.query.limit ? Number(req.query.limit) : undefined,
        }),
      );
    } catch (err) {
      handleError(err, res, req);
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
      handleError(err, res, req);
    }
  });

  app.get('/v1/retention', async (req, res) => {
    try {
      res.json(await retention.getPolicy(projectId(req)));
    } catch (err) {
      handleError(err, res, req);
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

      const result = await retention.eraseSubject(project, subject);

      // Erasure is awaited, not fire-and-forget: proving a deletion request was
      // honoured is the entire point of recording it.
      await audit.recordSync({
        projectId: project,
        action: 'erasure.execute',
        subjectType: 'data_subject',
        subjectId: email ?? externalId,
        detail: result as unknown as Record<string, unknown>,
        ...who(req),
      });

      res.json(result);
    } catch (err) {
      handleError(err, res, req);
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

function handleError(err: unknown, res: express.Response, req?: express.Request): void {
  if (err instanceof ValidationError) {
    // 4xx tells the SDK queue this is permanent and to stop retrying.
    res.status(400).json({ error: err.message });
    return;
  }

  // Logged with the request id so a 500 can be traced to its exact request.
  req?.log?.error('unhandled error', {
    error: err instanceof Error ? err.message : String(err),
  });
  res.status(500).json({ error: 'Internal error' });
}
