import type { Attachment, DeviceContext, LogEntry, NetworkEntry } from './types.js';

/**
 * The single seam between shared logic and each platform.
 *
 * `core` never touches a DOM, a UIView or an Android Activity — it calls this
 * interface. Web implements it in TypeScript; iOS and Android implement the same
 * method set natively and speak to the same ingest API. Adding a fourth platform
 * means implementing this and nothing else.
 */
export interface PlatformAdapter {
  /**
   * Raw pixels of the current screen. Implementations differ sharply:
   * web rasterizes the DOM, iOS uses UIGraphicsImageRenderer, Android uses PixelCopy.
   */
  captureScreenshot(): Promise<ImageData>;

  /** Facts about the device/runtime. Called once per report, at capture time. */
  collectDeviceContext(): Promise<DeviceContext>;

  /** Buffered console/logcat output, newest last. Empty array if unsupported. */
  collectLogs(): Promise<LogEntry[]>;

  /** Buffered network activity, newest last. Empty array if unsupported. */
  collectNetworkActivity(): Promise<NetworkEntry[]>;

  /** Persist a value across app launches (offline queue, reporter identity). */
  storage: KeyValueStore;

  /** Upload bytes, returning a handle to reference from the report. */
  upload(image: ImageData, kind: Attachment['kind']): Promise<Attachment>;
}

/** Platform-neutral image bytes. Web maps this to a Blob, native to Data/ByteArray. */
export interface ImageData {
  bytes: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
