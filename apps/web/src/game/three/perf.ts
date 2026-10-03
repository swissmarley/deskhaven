/**
 * Frame-rate bookkeeping for the Three scene: a rolling 1 s fps meter, the one-shot degrade rule
 * and the stats-overlay switch. Pure (no DOM, no three), tested under Node.
 */

/** Window of the rolling fps average. */
export const FPS_WINDOW_MS = 1000;
/** Below this rolling fps for `DEGRADE_HOLD_MS` the scene degrades once. */
export const DEGRADE_FPS = 45;
export const DEGRADE_HOLD_MS = 3000;
/** `localStorage` key that turns the stats overlay on (`'1'`), besides `?stats=1`. */
export const STATS_STORAGE_KEY = 'agenthotel.stats';

/** Rolling frame counter: fps over the last `FPS_WINDOW_MS` of frames. */
export class FpsMeter {
  private readonly frames: number[] = [];
  private total = 0;

  constructor(private readonly windowMs = FPS_WINDOW_MS) {}

  /** Record one frame of `dtMs`; frames older than the window fall off. */
  push(dtMs: number): void {
    const dt = Math.max(0, dtMs);
    this.frames.push(dt);
    this.total += dt;
    while (this.frames.length > 1 && this.total - (this.frames[0] ?? 0) >= this.windowMs) {
      this.total -= this.frames.shift() ?? 0;
    }
  }

  /** Frames per second over the window; 0 until two frames have been seen. */
  get fps(): number {
    if (this.frames.length < 2 || this.total <= 0) return 0;
    return (this.frames.length * 1000) / this.total;
  }

  /** Whether the window holds a full second of frames (so `fps` is meaningful). */
  get warm(): boolean {
    return this.total >= this.windowMs * 0.9;
  }
}

/**
 * Fires once when the rolling fps has stayed under `threshold` for `holdMs` of frame time, never
 * again in the same session (there is no re-upgrade).
 */
export class DegradeMonitor {
  private below = 0;
  private fired = false;

  constructor(
    private readonly threshold = DEGRADE_FPS,
    private readonly holdMs = DEGRADE_HOLD_MS,
  ) {}

  /** Feed one frame; returns true exactly once, on the frame the hold time is reached. */
  sample(fps: number, dtMs: number, warm = true): boolean {
    if (this.fired) return false;
    if (!warm || fps <= 0 || fps >= this.threshold) {
      this.below = 0;
      return false;
    }
    this.below += Math.max(0, dtMs);
    if (this.below < this.holdMs) return false;
    this.fired = true;
    return true;
  }

  get done(): boolean {
    return this.fired;
  }
}

/** `?stats=1` in the page URL, or the stored flag, shows the stats overlay. */
export function statsEnabled(
  search: string | undefined,
  stored: string | null | undefined,
): boolean {
  if (stored === '1') return true;
  if (!search) return false;
  try {
    return new URLSearchParams(search).get('stats') === '1';
  } catch {
    return false;
  }
}

/** One line for the overlay. */
export function formatStats(s: {
  fps: number;
  calls: number;
  triangles: number;
  avatars: number;
  degraded: boolean;
}): string {
  const tri = s.triangles >= 1000 ? `${(s.triangles / 1000).toFixed(1)}k` : `${s.triangles}`;
  return `${Math.round(s.fps)} fps · ${s.calls} calls · ${tri} tris · ${s.avatars} avatars${
    s.degraded ? ' · degraded' : ''
  }`;
}
