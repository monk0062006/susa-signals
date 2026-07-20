import {
  ConsentManager,
  IngestClient,
  ReportBuilder,
  ReportQueue,
  type Attachment,
  type BuildContext,
  type ConsentRecord,
  type Reporter,
  type Submission,
} from '@markerio-usa/core';
import { WebPlatformAdapter } from './adapter.js';
import { WebInstrumentation } from './instrument.js';
import { AnnotationOverlay } from './overlay.js';
import { ReplayRecorder, type ReplayOptions } from './replay.js';

/** Bump when consent copy changes materially; prior grants stop counting. */
const CONSENT_POLICY_VERSION = '1';

export interface WidgetOptions {
  /** Project id from your dashboard. */
  project: string;
  /** Ingest API base URL. */
  endpoint: string;
  reporter?: Reporter;
  customData?: Submission['customData'];
  /** Suppress SDK console output. */
  silent?: boolean;
  /** Bind Ctrl/Cmd+Shift+K to start a capture. Default true. */
  keyboardShortcuts?: boolean;
  /** Render the floating launcher button. Default true. */
  launcher?: boolean;
  /**
   * Session replay config. Recording never starts without a `session_replay`
   * consent grant, regardless of what is set here — passing options is a
   * capability, not a grant.
   */
  replay?: ReplayOptions & { enabled: boolean };
}

export interface Widget {
  show(): void;
  hide(): void;
  capture(): Promise<void>;
  setReporter(reporter: Reporter): void;
  setCustomData(data: Submission['customData']): void;
  /**
   * Records that the user agreed to the given scopes. The host app is asserting
   * it collected real agreement — this call is the SDK's evidence, not a
   * substitute for asking.
   */
  grantConsent(scopes: Array<'screenshot' | 'diagnostics' | 'session_replay'>): Promise<void>;
  /** Withdraws consent, stops any recording, and discards unsent replay data. */
  revokeConsent(): Promise<void>;
  /** Starts replay if consent allows. Returns the session id, or undefined. */
  startRecording(): Promise<string | undefined>;
  stopRecording(): Promise<void>;
  /** Retry anything stranded by an earlier network failure. */
  flush(): Promise<{ sent: number; remaining: number }>;
  /** Remove all UI, stop recording, and restore every patched global. */
  unload(): Promise<void>;
}

/**
 * Entry point. Mirrors the shape of Marker.io's `loadWidget` so migrating from
 * it is a change of import and endpoint rather than a rewrite of call sites.
 */
export async function loadWidget(options: WidgetOptions): Promise<Widget> {
  if (typeof window === 'undefined') {
    // SSR frameworks import this at module scope; failing loudly here is kinder
    // than a cryptic `document is not defined` deeper in the stack.
    throw new Error('loadWidget requires a browser environment');
  }
  if (!options.project) throw new Error('loadWidget requires a `project` id');
  if (!options.endpoint) throw new Error('loadWidget requires an `endpoint`');

  const log = (msg: string): void => {
    if (!options.silent) console.info(`[markerio] ${msg}`);
  };

  const instrumentation = new WebInstrumentation();
  instrumentation.install();

  const adapter = new WebPlatformAdapter(instrumentation, options.endpoint, options.project);
  const client = new IngestClient({ endpoint: options.endpoint, projectId: options.project });
  const queue = new ReportQueue(adapter.storage, client);
  const builder = new ReportBuilder(adapter, options.project);
  const consent = new ConsentManager(adapter.storage, CONSENT_POLICY_VERSION);

  const replay = new ReplayRecorder(
    client,
    consent,
    options.project,
    options.replay ?? {},
    log,
  );

  let reporter = options.reporter;
  let customData = options.customData;
  let capturing = false;

  // Anything stranded by a previous session's network failure goes out now.
  void queue.flush().then(({ sent }) => {
    if (sent > 0) log(`delivered ${sent} queued submission(s)`);
  });

  // Replay is opt-in twice over: the host must enable it AND consent must exist.
  if (options.replay?.enabled) {
    void replay.start();
  }

  const capture = async (): Promise<void> => {
    // A second overlay over a live capture would double-submit.
    if (capturing) return;
    capturing = true;

    const overlay = new AnnotationOverlay();
    launcher?.style.setProperty('display', 'none');

    try {
      const screenshot = await adapter.captureScreenshot();
      const draft = await overlay.present(screenshot);
      if (!draft) return; // user cancelled

      // Flatten before upload so redactions are burned into the bytes we send.
      const flattened = await overlay.flatten();

      let attachment: Attachment | undefined;
      try {
        attachment = await adapter.upload(flattened, 'screenshot');
      } catch {
        // Send the report without its image rather than losing the user's
        // written description, which is the harder part to reproduce.
        log('screenshot upload failed; sending report without it');
      }

      const ctx: BuildContext = {};
      if (reporter) ctx.reporter = reporter;
      if (customData) ctx.customData = customData;
      // Links the report to the replay, so it can be watched in context.
      const sessionId = replay.getSessionId();
      if (sessionId) ctx.sessionId = sessionId;
      const record = await consent.load();
      if (record) ctx.consent = record;

      const submission = await builder.buildBugReport(
        draft,
        attachment,
        ctx,
        await consent.has('diagnostics'),
      );
      await queue.enqueue(submission);
      log(`submission ${submission.id} sent`);
    } catch (err) {
      log(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      overlay.destroy();
      capturing = false;
      if (launcherVisible) launcher?.style.removeProperty('display');
    }
  };

  /**
   * Filing a report is itself the consent act for screenshot and diagnostics:
   * the user chose to open the widget, sees exactly what will be sent, and can
   * redact it before pressing send. Replay has no such moment, which is why it
   * is excluded here and must be granted explicitly.
   */
  if (!(await consent.load())) {
    await consent.grant(['screenshot', 'diagnostics'], 'host_app');
  }

  // --- launcher button ------------------------------------------------------
  let launcherVisible = options.launcher !== false;
  let launcher: HTMLButtonElement | undefined;

  if (options.launcher !== false) {
    launcher = document.createElement('button');
    launcher.textContent = 'Feedback';
    launcher.setAttribute('aria-label', 'Report a bug or send feedback');
    launcher.style.cssText = `
      position: fixed; right: 20px; bottom: 20px; z-index: 2147482000;
      padding: 11px 18px; border: 0; border-radius: 999px;
      background: #3b82f6; color: #fff; font-weight: 600; cursor: pointer;
      font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 4px 14px rgba(0,0,0,.25);
    `;
    launcher.onclick = () => void capture();
    document.body.appendChild(launcher);
  }

  // --- keyboard shortcut ----------------------------------------------------
  const onKey = (e: KeyboardEvent): void => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      void capture();
    }
  };
  if (options.keyboardShortcuts !== false) {
    document.addEventListener('keydown', onKey);
  }

  log(`widget loaded for project ${options.project}`);

  return {
    show(): void {
      launcherVisible = true;
      launcher?.style.removeProperty('display');
    },
    hide(): void {
      launcherVisible = false;
      launcher?.style.setProperty('display', 'none');
    },
    capture,
    setReporter(next: Reporter): void {
      reporter = next;
    },
    setCustomData(data: Submission['customData']): void {
      customData = data;
    },
    async grantConsent(scopes): Promise<void> {
      const existing: ConsentRecord | null = await consent.load();
      // Union with prior scopes so granting replay does not silently drop
      // screenshot/diagnostics.
      const merged = new Set([...(existing?.scopes ?? []), ...scopes]);
      await consent.grant([...merged], 'explicit_prompt');
      log(`consent granted: ${[...merged].join(', ')}`);
    },
    async revokeConsent(): Promise<void> {
      await consent.revoke();
      // Withdrawal is immediate: anything buffered is discarded, not sent.
      await replay.abandon();
      log('consent revoked');
    },
    startRecording: () => replay.start(),
    stopRecording: () => replay.stop(),
    flush: () => queue.flush(),
    async unload(): Promise<void> {
      document.removeEventListener('keydown', onKey);
      launcher?.remove();
      await replay.stop();
      instrumentation.uninstall();
    },
  };
}

export default { loadWidget };
