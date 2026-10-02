import type { TilePoint } from './types.js';

/** Walking speed along a path, in tiles per second. */
export const SPEED_TILES_PER_S = 2.5;
/** Duration of the acceleration / deceleration ramps at each end of a walk. */
const RAMP_S = 0.25;

export interface Motion {
  /** Waypoints; index 0 is where the avatar started (fractional after an interrupt). */
  points: TilePoint[];
  /** Cumulative path length (tiles) at each waypoint. */
  cum: number[];
  total: number;
  elapsed: number;
  duration: number;
}

export interface MotionSample {
  x: number;
  y: number;
  /** Segment endpoints the avatar is currently between (for facing and logical tile). */
  from: TilePoint;
  to: TilePoint;
  done: boolean;
}

export function buildMotion(points: TilePoint[]): Motion {
  const cum: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
    cum.push(total);
  }
  return { points, cum, total, elapsed: 0, duration: Math.max(0.05, total / SPEED_TILES_PER_S) };
}

/** Advance the motion by `dt` seconds and sample the eased position along the polyline. */
export function advanceMotion(m: Motion, dt: number): MotionSample | null {
  m.elapsed += dt;
  const first = m.points[0];
  if (!first) return null;
  const u = Math.min(1, m.elapsed / m.duration);
  const ramp = Math.min(0.3, RAMP_S / m.duration);
  const s = easeTrapezoid(u, ramp) * m.total;
  let i = 1;
  while (i < m.cum.length - 1 && (m.cum[i] ?? 0) < s) i++;
  const a = m.points[i - 1] ?? first;
  const b = m.points[i] ?? a;
  const c0 = m.cum[i - 1] ?? 0;
  const segLen = (m.cum[i] ?? 0) - c0;
  const t = segLen > 0 ? Math.min(1, Math.max(0, (s - c0) / segLen)) : 1;
  if (u >= 1) {
    const last = m.points.at(-1) ?? b;
    return { x: last.x, y: last.y, from: a, to: last, done: true };
  }
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, from: a, to: b, done: false };
}

/**
 * Trapezoidal velocity profile: accelerate over the first `r` of the journey, cruise, decelerate
 * over the last `r`; normalised so the result reaches 1 at u = 1 (r in (0, 0.5]).
 */
export function easeTrapezoid(u: number, r: number): number {
  if (r <= 0) return u;
  const v = 1 / (1 - r);
  if (u < r) return (v * u * u) / (2 * r);
  if (u <= 1 - r) return v * (u - r / 2);
  const w = 1 - u;
  return 1 - (v * w * w) / (2 * r);
}
