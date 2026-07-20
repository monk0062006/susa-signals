import { Replayer } from 'rrweb';

/**
 * Session replay playback.
 *
 * Drives rrweb's `Replayer` directly rather than pulling in `rrweb-player`. The
 * player ships its own Svelte runtime and styling that would have to be fought to
 * match this UI, and the control surface needed here is a play/pause button and a
 * scrubber.
 */
export class ReplayPlayer {
  private replayer: Replayer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private playing = false;
  private durationMs = 0;
  private startTime = 0;

  constructor(
    private readonly mount: HTMLElement,
    private readonly onTick: (currentMs: number, durationMs: number, playing: boolean) => void,
  ) {}

  /** Returns false when the events cannot form a playable session. */
  load(events: unknown[]): boolean {
    this.destroy();

    // rrweb needs a full snapshot (type 2) plus at least one following event, or
    // it throws rather than returning an error.
    if (events.length < 2) return false;

    try {
      this.replayer = new Replayer(events as never[], {
        root: this.mount,
        // The recording is of a different origin's DOM; blocking remote assets
        // keeps playback from firing requests to the customer's servers.
        UNSAFE_replayCanvas: false,
        mouseTail: false,
        speed: 1,
      });

      const meta = this.replayer.getMetaData();
      this.durationMs = Math.max(meta.totalTime, 0);
      this.startTime = meta.startTime;
      this.onTick(0, this.durationMs, false);
      return true;
    } catch {
      this.replayer = undefined;
      return false;
    }
  }

  /**
   * Playback offset in ms from the start of the recording.
   *
   * rrweb 2.x returns `baselineTime - startTime` from `getCurrentTime()`, and
   * `baselineTime` is 0 until playback initializes — so before the first play the
   * raw value is the negated epoch timestamp (around -1.78e12), and after it the
   * value stays epoch-shifted. Adding `startTime` back recovers the real offset.
   * Detected by sign rather than by rrweb version, so a future release that
   * returns a already-relative value keeps working.
   */
  private currentOffset(): number {
    if (!this.replayer) return 0;
    const raw = this.replayer.getCurrentTime();
    const normalized = raw < 0 ? raw + this.startTime : raw;
    return Math.min(Math.max(normalized, 0), this.durationMs);
  }

  play(): void {
    if (!this.replayer) return;

    // Restart from the beginning when play is pressed at the very end, rather
    // than appearing to do nothing.
    const current = this.currentOffset();
    this.replayer.play(current >= this.durationMs ? 0 : current);

    this.playing = true;
    this.startTicking();
  }

  pause(): void {
    if (!this.replayer) return;
    this.replayer.pause();
    this.playing = false;
    this.stopTicking();
    this.onTick(this.currentOffset(), this.durationMs, false);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(ms: number): void {
    if (!this.replayer) return;
    const clamped = Math.min(Math.max(ms, 0), this.durationMs);

    // pause(ms) seeks without starting playback; play(ms) would resume even if
    // the user only dragged the scrubber.
    if (this.playing) {
      this.replayer.play(clamped);
    } else {
      this.replayer.pause(clamped);
    }
    this.onTick(clamped, this.durationMs, this.playing);
  }

  /** Debug probe: raw state from the underlying rrweb replayer. */
  debugState(): Record<string, unknown> {
    return {
      hasReplayer: Boolean(this.replayer),
      playing: this.playing,
      durationMs: this.durationMs,
      currentTime: this.currentOffset(),
      meta: this.replayer?.getMetaData(),
    };
  }

  /** Seek by 0..1 fraction, so callers need not know the duration. */
  seekFraction(fraction: number): void {
    this.seek(Math.min(Math.max(fraction, 0), 1) * this.durationMs);
  }

  destroy(): void {
    this.stopTicking();
    this.playing = false;
    this.durationMs = 0;
    this.startTime = 0;

    try {
      this.replayer?.destroy();
    } catch {
      // Destroying a partially-constructed replayer can throw; nothing to do.
    }
    this.replayer = undefined;
    this.mount.replaceChildren();
  }

  private startTicking(): void {
    this.stopTicking();
    this.timer = setInterval(() => {
      if (!this.replayer) return;
      const current = this.currentOffset();

      if (current >= this.durationMs) {
        this.playing = false;
        this.stopTicking();
        this.onTick(this.durationMs, this.durationMs, false);
        return;
      }
      this.onTick(current, this.durationMs, true);
    }, 100);
  }

  private stopTicking(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
