/**
 * Hand-written validation of the ingest payloads.
 *
 * These endpoints are public by definition — the SDK runs in untrusted browsers
 * and on untrusted devices — so nothing from the client is assumed well-formed.
 * Unknown fields are dropped rather than persisted, which keeps a compromised or
 * outdated SDK from writing arbitrary JSON into the store.
 */

export interface Submission {
  id: string;
  projectId: string;
  payload: Record<string, unknown> & { type: string };
  device: Record<string, unknown>;
  reporter?: { email?: string; fullName?: string; externalId?: string };
  attachments: unknown[];
  customData?: Record<string, unknown>;
  sessionId?: string;
  consent?: Record<string, unknown>;
  createdAt: number;
  /** Server-assigned; never trusted from the client. */
  receivedAt: number;
}

export interface ReplayChunk {
  sessionId: string;
  projectId: string;
  seq: number;
  events: unknown[];
  startedAt: number;
  endedAt: number;
  final: boolean;
  receivedAt: number;
}

const MAX_TITLE = 300;
const MAX_DESCRIPTION = 10_000;
const MAX_ARRAY = 500;
const MAX_EVENTS_PER_CHUNK = 5_000;
const UUID_RE = /^[0-9a-f-]{36}$/i;

export class ValidationError extends Error {}

export function parseSubmission(body: unknown, projectId: string): Submission {
  const b = asObject(body);

  const id = str(b.id, 'id');
  if (!UUID_RE.test(id)) throw new ValidationError('id must be a UUID');

  const payload = parsePayload(b.payload);

  const submission: Submission = {
    id,
    // Taken from the authenticated header, not the body, so a client cannot
    // write submissions into a project it does not hold a key for.
    projectId,
    payload,
    device: obj(b.device),
    attachments: arr(b.attachments),
    createdAt: typeof b.createdAt === 'number' ? b.createdAt : Date.now(),
    receivedAt: Date.now(),
  };

  if (typeof b.sessionId === 'string' && UUID_RE.test(b.sessionId)) {
    submission.sessionId = b.sessionId;
  }

  if (typeof b.reporter === 'object' && b.reporter !== null) {
    const r = b.reporter as Record<string, unknown>;
    const reporter: Submission['reporter'] = {};
    if (typeof r.email === 'string') reporter.email = r.email.slice(0, 320);
    if (typeof r.fullName === 'string') reporter.fullName = r.fullName.slice(0, 200);
    if (typeof r.externalId === 'string') reporter.externalId = r.externalId.slice(0, 200);
    submission.reporter = reporter;
  }

  if (typeof b.customData === 'object' && b.customData !== null) {
    submission.customData = b.customData as Record<string, unknown>;
  }

  // Retained verbatim: the consent record is the audit trail for why this data
  // was collected, so it is stored as received rather than normalized.
  if (typeof b.consent === 'object' && b.consent !== null) {
    submission.consent = b.consent as Record<string, unknown>;
  }

  return submission;
}

function parsePayload(value: unknown): Submission['payload'] {
  const p = asObject(value);
  const type = str(p.type, 'payload.type');

  switch (type) {
    case 'bug_report': {
      const title = str(p.title, 'payload.title').trim();
      if (!title) throw new ValidationError('payload.title must not be empty');
      if (title.length > MAX_TITLE) throw new ValidationError('payload.title too long');

      const out: Submission['payload'] = {
        type,
        kind: oneOf(p.kind, ['bug', 'feedback', 'question'], 'bug'),
        title,
        annotations: arr(p.annotations),
      };
      if (typeof p.description === 'string' && p.description.trim()) {
        out.description = p.description.slice(0, MAX_DESCRIPTION);
      }
      if (Array.isArray(p.consoleLogs)) out.consoleLogs = p.consoleLogs.slice(0, MAX_ARRAY);
      if (Array.isArray(p.networkLogs)) out.networkLogs = p.networkLogs.slice(0, MAX_ARRAY);
      return out;
    }

    case 'research_response': {
      const studyId = str(p.studyId, 'payload.studyId');
      if (!Array.isArray(p.answers)) throw new ValidationError('payload.answers must be an array');

      const out: Submission['payload'] = {
        type,
        studyId: studyId.slice(0, 200),
        answers: p.answers.slice(0, MAX_ARRAY),
        completed: p.completed === true,
      };
      if (typeof p.durationMs === 'number') out.durationMs = p.durationMs;
      return out;
    }

    default:
      throw new ValidationError(`Unsupported payload.type: ${type}`);
  }
}

export function parseReplayChunk(body: unknown, projectId: string): ReplayChunk {
  const b = asObject(body);

  const sessionId = str(b.sessionId, 'sessionId');
  if (!UUID_RE.test(sessionId)) throw new ValidationError('sessionId must be a UUID');

  const seq = b.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    throw new ValidationError('seq must be a non-negative integer');
  }

  if (!Array.isArray(b.events)) throw new ValidationError('events must be an array');
  if (b.events.length > MAX_EVENTS_PER_CHUNK) {
    throw new ValidationError('too many events in one chunk');
  }

  return {
    sessionId,
    projectId,
    seq,
    events: b.events,
    startedAt: typeof b.startedAt === 'number' ? b.startedAt : Date.now(),
    endedAt: typeof b.endedAt === 'number' ? b.endedAt : Date.now(),
    final: b.final === true,
    receivedAt: Date.now(),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  return value;
}

function oneOf(value: unknown, allowed: string[], fallback: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value.slice(0, MAX_ARRAY) : [];
}
