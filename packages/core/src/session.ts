import type { ConsentRecord } from './consent.js';
import { uuid } from './id.js';
import type { PlatformAdapter } from './platform.js';
import type {
  Annotation,
  Attachment,
  ReportKind,
  Reporter,
  Submission,
  SubmissionPayload,
} from './types.js';

export interface CaptureDraft {
  kind: ReportKind;
  title: string;
  description?: string;
  annotations: Annotation[];
}

export interface BuildContext {
  reporter?: Reporter;
  customData?: Submission['customData'];
  /** Links the submission to the replay session it occurred in. */
  sessionId?: string;
  consent?: ConsentRecord;
}

/**
 * Assembles a submission from a payload plus everything the adapter can observe.
 * Platform-agnostic by construction — this runs identically on web and native.
 */
export class ReportBuilder {
  constructor(
    private readonly adapter: PlatformAdapter,
    private readonly projectId: string,
  ) {}

  /** Bug report: attaches diagnostics, which research responses have no use for. */
  async buildBugReport(
    draft: CaptureDraft,
    screenshot: Attachment | undefined,
    ctx: BuildContext,
    /** Diagnostics are gated on consent, so the caller decides. */
    includeDiagnostics: boolean,
  ): Promise<Submission> {
    const payload: SubmissionPayload = {
      type: 'bug_report',
      kind: draft.kind,
      title: draft.title,
      annotations: draft.annotations,
    };
    if (draft.description) payload.description = draft.description;

    if (includeDiagnostics) {
      // Collected in parallel: independent reads, and the user is watching a spinner.
      const [consoleLogs, networkLogs] = await Promise.all([
        this.adapter.collectLogs().catch(() => []),
        this.adapter.collectNetworkActivity().catch(() => []),
      ]);
      payload.consoleLogs = consoleLogs;
      payload.networkLogs = networkLogs;
    }

    return this.envelope(payload, screenshot ? [screenshot] : [], ctx);
  }

  async buildResearchResponse(
    payload: Extract<SubmissionPayload, { type: 'research_response' }>,
    ctx: BuildContext,
  ): Promise<Submission> {
    return this.envelope(payload, [], ctx);
  }

  private async envelope(
    payload: SubmissionPayload,
    attachments: Attachment[],
    ctx: BuildContext,
  ): Promise<Submission> {
    const submission: Submission = {
      id: uuid(),
      projectId: this.projectId,
      payload,
      device: await this.adapter.collectDeviceContext(),
      attachments,
      createdAt: Date.now(),
    };

    // Assigned conditionally because exactOptionalPropertyTypes forbids
    // writing an explicit `undefined` into an optional field.
    if (ctx.reporter) submission.reporter = ctx.reporter;
    if (ctx.customData) submission.customData = ctx.customData;
    if (ctx.sessionId) submission.sessionId = ctx.sessionId;
    if (ctx.consent) submission.consent = ctx.consent;

    return submission;
  }
}
