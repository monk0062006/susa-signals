/** Types the dashboard reads. Deliberately loose — the server is the authority. */

export interface DeviceContext {
  platform?: string;
  sdkVersion?: string;
  osName?: string;
  osVersion?: string;
  deviceModel?: string;
  browserName?: string;
  browserVersion?: string;
  locale?: string;
  timezone?: string;
  screen?: { width: number; height: number; pixelRatio: number };
  url?: string;
  route?: string;
  appVersion?: string;
  appBuild?: string;
  networkType?: string;
}

export interface LogEntry {
  level: string;
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

export interface Attachment {
  id: string;
  kind: string;
  mimeType: string;
  byteSize: number;
  width?: number;
  height?: number;
}

export interface Submission {
  id: string;
  projectId: string;
  payload: {
    type: string;
    kind?: string;
    title?: string;
    description?: string;
    annotations?: unknown[];
    consoleLogs?: LogEntry[];
    networkLogs?: NetworkEntry[];
    studyId?: string;
    answers?: Array<{ questionId: string; value: unknown }>;
    completed?: boolean;
    durationMs?: number;
  };
  device: DeviceContext;
  reporter?: { email?: string; fullName?: string; externalId?: string };
  attachments: Attachment[];
  customData?: Record<string, unknown>;
  sessionId?: string;
  consent?: { scopes?: string[]; policyVersion?: string; grantedAt?: number; source?: string };
  createdAt: number;
  receivedAt: number;
}

export interface ReplaySession {
  events: unknown[];
  chunks: number;
  final: boolean;
}

export class Api {
  constructor(
    private readonly base: string,
    private projectId: string,
  ) {}

  setProject(projectId: string): void {
    this.projectId = projectId;
  }

  getProject(): string {
    return this.projectId;
  }

  /**
   * Project lives in the path because this URL is consumed by `<img src>`,
   * which cannot send the `x-project-id` header the JSON endpoints use.
   */
  attachmentUrl(id: string): string {
    return `${this.base}/v1/projects/${encodeURIComponent(this.projectId)}/attachments/${id}`;
  }

  async listSubmissions(): Promise<Submission[]> {
    const res = await fetch(`${this.base}/v1/reports`, {
      headers: { 'x-project-id': this.projectId },
    });
    if (!res.ok) throw new Error(`Failed to load reports (${res.status})`);
    const body = (await res.json()) as { reports: Submission[] };
    return body.reports ?? [];
  }

  async listStudies(): Promise<Array<{ id: string; name: string; active: boolean; questions: unknown[] }>> {
    const res = await fetch(`${this.base}/v1/studies`, {
      headers: { 'x-project-id': this.projectId },
    });
    if (!res.ok) throw new Error(`Failed to load studies (${res.status})`);
    const body = (await res.json()) as { studies: Array<{ id: string; name: string; active: boolean; questions: unknown[] }> };
    return body.studies ?? [];
  }

  async getStudyResults(studyId: string): Promise<{ study: unknown; results: unknown }> {
    const res = await fetch(`${this.base}/v1/studies/${encodeURIComponent(studyId)}/results`, {
      headers: { 'x-project-id': this.projectId },
    });
    if (!res.ok) throw new Error(`Failed to load results (${res.status})`);
    return (await res.json()) as { study: unknown; results: unknown };
  }

  /** Returns null when the session has no stored chunks, which is normal. */
  async getReplay(sessionId: string): Promise<ReplaySession | null> {
    const res = await fetch(`${this.base}/v1/replay/${sessionId}`, {
      headers: { 'x-project-id': this.projectId },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Failed to load replay (${res.status})`);
    return (await res.json()) as ReplaySession;
  }
}
