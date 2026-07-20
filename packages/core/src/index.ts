export type {
  Annotation,
  Answer,
  AnswerValue,
  Attachment,
  BugReportPayload,
  DeviceContext,
  LogEntry,
  LogLevel,
  NetworkEntry,
  Platform,
  Point,
  ReplayChunk,
  ReportKind,
  Reporter,
  ResearchResponsePayload,
  Submission,
  SubmissionPayload,
} from './types.js';

export type { ImageData, KeyValueStore, PlatformAdapter } from './platform.js';

export { ConsentManager } from './consent.js';
export type { ConsentRecord, ConsentScope } from './consent.js';

export { IngestClient, IngestError } from './client.js';
export type { IngestClientOptions } from './client.js';

export { ReportQueue } from './queue.js';
export { ReportBuilder } from './session.js';
export type { BuildContext, CaptureDraft } from './session.js';
export { uuid } from './id.js';
