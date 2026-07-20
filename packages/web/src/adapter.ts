import type {
  Attachment,
  DeviceContext,
  ImageData as CaptureImage,
  KeyValueStore,
  LogEntry,
  NetworkEntry,
  PlatformAdapter,
} from '@markerio-usa/core';
import type { WebInstrumentation } from './instrument.js';

const SDK_VERSION = '0.0.0';

/**
 * html2canvas is ~93% of this SDK's bundle (53KB gzipped against 6KB for
 * everything else) and is needed only once someone opens the composer. Loading
 * it up front makes every page view of every customer's app pay for a feature
 * most visitors never use.
 *
 * The dynamic import is code-split into its own chunk, so it is fetched on the
 * first capture and cached thereafter.
 */
let html2canvasPromise: Promise<typeof import('html2canvas').default> | undefined;

function loadHtml2Canvas(): Promise<typeof import('html2canvas').default> {
  // Memoized on the promise, not the module: two rapid captures must share one
  // in-flight request rather than starting two.
  html2canvasPromise ??= import('html2canvas').then((mod) => mod.default);
  return html2canvasPromise;
}

/**
 * Warms the chunk without blocking.
 *
 * Called when the launcher is rendered: by the time someone decides to file a
 * report, the download has usually finished, so the composer opens instantly
 * without the page having paid for it during load.
 */
export function prefetchScreenshotEngine(): void {
  // Errors are swallowed: a failed prefetch must not surface to the host app,
  // and the real capture path will retry and report properly.
  void loadHtml2Canvas().catch(() => {});
}

/**
 * Browser implementation of the shared platform contract.
 *
 * Screenshots rasterize the DOM rather than using `getDisplayMedia`, which would
 * raise a screen-share permission prompt. That prompt is fatal for a feedback
 * tool: the moment a user has to grant screen access to file a bug, most stop
 * filing it. The tradeoff is that rasterization approximates the page — see
 * `captureScreenshot` for what it cannot see.
 */
export class WebPlatformAdapter implements PlatformAdapter {
  readonly storage: KeyValueStore = new LocalStorageStore();

  constructor(
    private readonly instrumentation: WebInstrumentation,
    private readonly endpoint: string,
    private readonly projectId: string,
  ) {}

  /**
   * Known blind spots, all inherent to DOM rasterization:
   * cross-origin iframes render blank (they are unreadable by policy), and
   * `<canvas>` tainted by cross-origin drawing throws on read. Neither is
   * fixable client-side; both are why a server-side capture mode exists.
   */
  async captureScreenshot(): Promise<CaptureImage> {
    const html2canvas = await loadHtml2Canvas();

    const canvas = await html2canvas(document.body, {
      // Cropping to the viewport keeps payloads small and matches what the
      // reporter actually saw when they hit the button.
      width: window.innerWidth,
      height: window.innerHeight,
      x: window.scrollX,
      y: window.scrollY,
      scale: Math.min(window.devicePixelRatio || 1, 2), // cap: 3x triples bytes for no triage value
      useCORS: true,
      logging: false,
    });

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) throw new Error('Screenshot encoding failed');

    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mimeType: 'image/png',
      width: canvas.width,
      height: canvas.height,
    };
  }

  async collectDeviceContext(): Promise<DeviceContext> {
    const ctx: DeviceContext = {
      platform: 'web',
      sdkVersion: SDK_VERSION,
      url: window.location.href,
      screen: {
        width: window.innerWidth,
        height: window.innerHeight,
        pixelRatio: window.devicePixelRatio || 1,
      },
    };

    const nav = navigator;
    if (nav.language) ctx.locale = nav.language;

    try {
      ctx.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // Intl is absent in some embedded WebViews.
    }

    const browser = detectBrowser(nav.userAgent);
    if (browser.name) ctx.browserName = browser.name;
    if (browser.version) ctx.browserVersion = browser.version;

    const os = detectOs(nav.userAgent);
    if (os) ctx.osName = os;

    const connection = (nav as Navigator & { connection?: { type?: string } }).connection;
    if (connection?.type) ctx.networkType = normalizeNetwork(connection.type);

    return ctx;
  }

  async collectLogs(): Promise<LogEntry[]> {
    return this.instrumentation.getLogs();
  }

  async collectNetworkActivity(): Promise<NetworkEntry[]> {
    return this.instrumentation.getRequests();
  }

  async upload(image: CaptureImage, kind: Attachment['kind']): Promise<Attachment> {
    const form = new FormData();
    // Cast through ArrayBuffer: Blob rejects a Uint8Array view type directly.
    form.append(
      'file',
      new Blob([image.bytes as unknown as BlobPart], { type: image.mimeType }),
      'screenshot.png',
    );
    form.append('kind', kind);

    const res = await fetch(`${this.endpoint}/v1/uploads`, {
      method: 'POST',
      headers: { 'x-project-id': this.projectId },
      body: form,
    });

    if (!res.ok) throw new Error(`Upload failed with ${res.status}`);

    const { id } = (await res.json()) as { id: string };

    return {
      id,
      kind,
      mimeType: image.mimeType,
      byteSize: image.bytes.byteLength,
      width: image.width,
      height: image.height,
    };
  }
}

/** localStorage throws in Safari private mode rather than returning null. */
class LocalStorageStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota or private mode; the queue degrades to in-memory.
    }
  }

  async remove(key: string): Promise<void> {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // As above.
    }
  }
}

function detectBrowser(ua: string): { name?: string; version?: string } {
  // Order matters: Edge and Chrome both claim "Chrome", Chrome claims "Safari".
  const patterns: Array<[string, RegExp]> = [
    ['Edge', /Edg\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/],
    ['Chrome', /Chrome\/([\d.]+)/],
    ['Firefox', /Firefox\/([\d.]+)/],
    ['Safari', /Version\/([\d.]+).*Safari/],
  ];

  for (const [name, re] of patterns) {
    const match = re.exec(ua);
    if (match) return { name, version: match[1] as string };
  }
  return {};
}

function detectOs(ua: string): string | undefined {
  if (/Windows NT/.test(ua)) return 'Windows';
  if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return undefined;
}

type NetworkType = NonNullable<DeviceContext['networkType']>;

function normalizeNetwork(type: string): NetworkType {
  switch (type) {
    case 'wifi':
      return 'wifi';
    case 'cellular':
      return 'cellular';
    case 'ethernet':
      return 'ethernet';
    case 'none':
      return 'none';
    default:
      return 'unknown';
  }
}
