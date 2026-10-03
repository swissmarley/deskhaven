import { type Furniture, interactionTiles, rotatedSize } from '@deskhaven/shared';

/**
 * Door animation maths (pure, Node-testable). The `doorway.glb` leaf (`door 3` in the Kenney GLB,
 * `door_3` after GLTFLoader sanitises the name) is a separate node: it spans model x −4.58 … −0.28
 * with the handle at its −X end, so its hinge is the +X edge beside the frame post at x = 0. The
 * furniture layer re-parents the leaf under a hinge group at that edge and turns the group about +Y
 * by `doorAngle(openness)`. With the manifest's `yawOffset = π/2` the model's +Z is the piece's local
 * +X, i.e. into the room at every rotation, and a positive yaw about the +X-edge hinge swings the
 * −X leaf towards model +Z: the door opens inwards.
 *
 * Timing: the leaf swings open over `DOOR_SWING_S` (smoothstep-eased) as soon as an avatar is within
 * `DOOR_NEAR_TILES` of one of the door's tiles (its footprint or its interaction tile) and swings
 * shut `DOOR_CLOSE_DELAY_S` after the last one left.
 */

export const DOOR_OPEN_DEG = 80;
export const DOOR_OPEN_RAD = (DOOR_OPEN_DEG * Math.PI) / 180;
/** Swing time (open and close), seconds. */
export const DOOR_SWING_S = 0.35;
/** Delay after the last nearby avatar left before the door closes, seconds. */
export const DOOR_CLOSE_DELAY_S = 0.6;
/** Distance (tiles, Euclidean, fractional positions) at which an avatar counts as near the door. */
export const DOOR_NEAR_TILES = 1;
/** Name of the hinge group the furniture layer inserts above the leaf. */
export const DOOR_HINGE_NAME = 'door-hinge';

export interface DoorState {
  /** Swing progress 0 (closed) → 1 (open), linear in time; `doorAngle` eases it. */
  openness: number;
  /** Where the swing is heading. */
  target: 0 | 1;
  /** Seconds since nobody was near (only counts while the target is open). */
  idle: number;
}

export const DOOR_CLOSED: DoorState = { openness: 0, target: 0, idle: 0 };

/** One frame of the door state machine: `nearCount` avatars within reach, `dt` seconds elapsed. */
export function doorState(prev: DoorState, nearCount: number, dt: number): DoorState {
  let target = prev.target;
  let idle = prev.idle;
  if (nearCount > 0) {
    target = 1;
    idle = 0;
  } else if (target === 1) {
    idle += dt;
    if (idle >= DOOR_CLOSE_DELAY_S) {
      target = 0;
      idle = 0;
    }
  }
  const step = dt / DOOR_SWING_S;
  const openness =
    target === 1 ? Math.min(1, prev.openness + step) : Math.max(0, prev.openness - step);
  return { openness, target, idle };
}

/** Leaf yaw (radians about +Y) for an openness: smoothstep-eased swing to `DOOR_OPEN_RAD`. */
export function doorAngle(openness: number): number {
  const u = Math.min(1, Math.max(0, openness));
  return DOOR_OPEN_RAD * u * u * (3 - 2 * u);
}

export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Hinge point of a leaf with these bounds (model frame): its +X edge at the leaf's mid-thickness. */
export function doorHinge(leaf: Box): { x: number; y: number; z: number } {
  return { x: leaf.maxX, y: 0, z: (leaf.minZ + leaf.maxZ) / 2 };
}

/** Whether an object name is the doorway's leaf node (`door 3` / `door_3`, never `doorway`). */
export function isDoorLeafName(name: string): boolean {
  return /^door[ _]?\d/i.test(name);
}

export interface Point {
  x: number;
  y: number;
}

/** Whether a (fractional) avatar position is within `radius` tiles of any of the door's tiles. */
export function nearDoor(
  ax: number,
  ay: number,
  tiles: readonly Point[],
  radius = DOOR_NEAR_TILES,
): boolean {
  for (const t of tiles) if (Math.hypot(ax - t.x, ay - t.y) <= radius + 1e-9) return true;
  return false;
}

/** How many of the positions are near the door. */
export function countNearDoor(
  positions: readonly Point[],
  tiles: readonly Point[],
  radius = DOOR_NEAR_TILES,
): number {
  let n = 0;
  for (const p of positions) if (nearDoor(p.x, p.y, tiles, radius)) n++;
  return n;
}

/**
 * The tiles that open a door: its (rotated) footprint plus its interaction tile(s), deduplicated
 * (the door's stand tile is its own tile). Recomputed whenever the piece is created, moved or
 * rotated, since the furniture layer keeps a node across moves.
 */
export function doorTiles(piece: Pick<Furniture, 'kind' | 'x' | 'y' | 'rotation'>): Point[] {
  const { w, h } = rotatedSize(piece.kind, piece.rotation);
  const out: Point[] = [];
  const seen = new Set<string>();
  const add = (x: number, y: number): void => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ x, y });
  };
  for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) add(piece.x + dx, piece.y + dy);
  for (const t of interactionTiles(piece.kind, piece.x, piece.y, piece.rotation)) add(t.x, t.y);
  return out;
}
