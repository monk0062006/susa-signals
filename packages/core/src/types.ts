import type { ConsentRecord } from './consent.js';

/**
 * The wire format every platform produces. A submission captured on an iPhone
 * and one captured in Chrome must deserialize into this same shape server-side —
 * that invariant is what keeps the backend and integrations platform-agnostic.
 */

export type Platform = 'web' | 'ios' | 'android';

export type ReportKind = 'bug' | 'feedback' | 'question';

export interface Reporter {
  email?: string;
  fullName?: string;
  /** Stable id from the host app, for grouping submissions by end user. */
  externalId?: string;
}

/**
 * Device/runtime facts collected automatically. Every field is optional because
 * platforms differ in what they can see; the backend must never assume presence.
 */
export interface DeviceContext {
  platform: Platform;
  /** SDK semver, for triaging submissions from stale client versions. */
  sdkVersion: string;
  osName?: string;
  osVersion?: string;
  /** Browser name on web; device model ("iPhone15,2") on native. */
  deviceModel?: string;
  browserName?: string;
  browserVersion?: string;
  locale?: string;
  timezone?: string;
  screen?: { width: number; height: number; pixelRatio: number };
  /** Web only: the page under test. */
  url?: string;
  /** Native only: the screen/route the user was on. */
  route?: string;
  appVersion?: string;
  appBuild?: string;
  networkType?: 'wifi' | 'cellular' | 'ethernet' | 'none' | 'unknown';
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: number;
}

export interface NetworkEntry {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  timestamp: number;
}

/** Annotations are stored in normalized 0..1 coords so they survive any rescale. */
export interface Point {
  x: number;
  y: number;
}

export type Annotation =
  | { type: 'arrow'; from: Point; to: Point; color: string }
  | { type: 'rect'; origin: Point; width: number; height: number; color: string }
  | { type: 'pen'; points: Point[]; color: string; strokeWidth: number }
  | { type: 'text'; origin: Point; body: string; color: string }
  /** Redaction of sensitive regions. Must be burned into the image, not just overlaid. */
  | { type: 'blur'; origin: Point; width: number; height: number };

export interface Attachment {
  /** Opaque handle returned by the upload step, not raw bytes. */
  id: string;
  kind: 'screenshot' | 'screenrecording' | 'file';
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
}

// --- payloads ---------------------------------------------------------------

export interface BugReportPayload {
  type: 'bug_report';
  kind: ReportKind;
  title: string;
  description?: string;
  annotations: Annotation[];
  consoleLogs?: LogEntry[];
  networkLogs?: NetworkEntry[];
}

export type AnswerValue = string | number | boolean | string[];

export interface Answer {
  questionId: string;
  value: AnswerValue;
}

/** A completed (or abandoned) response to a research study. */
export interface ResearchResponsePayload {
  type: 'research_response';
  studyId: string;
  answers: Answer[];
  /** False when the user dropped out partway — still worth analysing. */
  completed: boolean;
  durationMs?: number;
}

export type SubmissionPayload = BugReportPayload | ResearchResponsePayload;

/**
 * One discrete thing a user sent. Bug reports and research responses share this
 * envelope because they share a lifecycle: user-initiated, low-volume, durable,
 * worth retrying for days.
 *
 * Session replay deliberately does NOT live here — see `ReplayChunk`.
 */
export interface Submission {
  /** Client-generated UUID. Doubles as the idempotency key for retried uploads. */
  id: string;
  projectId: string;
  payload: SubmissionPayload;
  device: DeviceContext;
  reporter?: Reporter;
  attachments: Attachment[];
  /** Arbitrary host-app metadata (plan, tenant, feature flags). */
  customData?: Record<string, string | number | boolean | null>;
  /**
   * Links this submission to the replay session it happened during, so a bug
   * report can be watched back in context. The whole point of pairing the two.
   */
  sessionId?: string;
  /** What the user had agreed to at capture time. Retained for audit. */
  consent?: ConsentRecord;
  createdAt: number;
}

// --- session replay ---------------------------------------------------------

/**
 * A slice of a recorded session.
 *
 * Kept off the `Submission` envelope on purpose. Replay is continuous and
 * high-volume — a single session can produce megabytes — so it must stream in
 * bounded chunks rather than accumulate. Critically, it must never share the
 * durable on-device queue with reports: replay data would exhaust the storage
 * quota and evict the user-written reports, which are far more valuable and
 * impossible to recreate.
 */
export interface ReplayChunk {
  sessionId: string;
  projectId: string;
  /** Monotonic per session. Lets the server order chunks that arrive out of order. */
  seq: number;
  /** Opaque rrweb events. `core` never inspects these. */
  events: unknown[];
  startedAt: number;
  endedAt: number;
  /** Set on the last chunk so the server can mark the session complete. */
  final: boolean;
}
