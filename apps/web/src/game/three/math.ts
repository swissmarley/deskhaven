import type { Facing } from '@deskhaven/shared';

/**
 * Small pure conversions shared by picking and the avatars (three core only, Node-testable).
 */

/** Canvas-local CSS pixels → normalised device coordinates for `Raycaster.setFromCamera`. */
export function canvasToNdc(
  sx: number,
  sy: number,
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: (sx / Math.max(1, width)) * 2 - 1, y: 1 - (sy / Math.max(1, height)) * 2 };
}

/**
 * World direction of a `Facing`. Tile (x, y) → world (x, 0, y), so north (facing 0, up-right on
 * screen, the −y tile direction) is world −Z, east is +X, south is +Z and west is −X.
 */
export function facingDirection(facing: Facing): { x: number; z: number } {
  switch (facing) {
    case 0:
      return { x: 0, z: -1 };
    case 1:
      return { x: 1, z: 0 };
    case 2:
      return { x: 0, z: 1 };
    default:
      return { x: -1, z: 0 };
  }
}

/**
 * Yaw (radians about +Y) that turns an object's local +Z front onto a facing's direction: a yaw θ
 * maps local +Z to world (sin θ, 0, cos θ), so south (+Z) is 0, east (+X) is +90°, north (−Z) is
 * 180° and west (−X) is −90°: `θ = (2 − facing) × 90°`.
 */
export function facingYaw(facing: Facing): number {
  return (2 - facing) * (Math.PI / 2);
}

/** Shortest signed difference between two yaws, in (−π, π]. */
export function yawDelta(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Default turn smoothing rate (1/s): the remaining angle shrinks by this factor per second. */
export const TURN_RATE = 12;

/** Wrap a yaw into (−π, π]. */
export function normalizeYaw(yaw: number): number {
  return yawDelta(0, yaw);
}

/**
 * Move `current` towards `target` along the shortest arc by the fraction `rate × dt` of the
 * remaining angle (clamped to 1), so it converges exponentially and never overshoots.
 */
export function approachYaw(current: number, target: number, dt: number, rate = TURN_RATE): number {
  const d = yawDelta(current, target);
  const k = Math.min(1, Math.max(0, rate * dt));
  return normalizeYaw(current + d * k);
}
