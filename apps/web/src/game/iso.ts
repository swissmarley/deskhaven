import type { TilePoint } from './types.js';

/**
 * Isometric tile maths for 64×32 diamonds.
 *
 * Tile axes in screen space:  +x → down-right (+32, +16),  +y → down-left (−32, +16).
 * Tile (0, 0) has its top-face centre at the origin; the room's north wall runs along the
 * top-right edge of row y = 0 and the west wall along the top-left edge of column x = 0.
 */
export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;
/** Placeholder wall height in pixels (three tiles). */
export const WALL_H = 96;

export interface ScreenPoint {
  sx: number;
  sy: number;
}

/** Centre of the tile's top face. Works for fractional tile coordinates (used while tweening). */
export function tileToScreen(x: number, y: number): ScreenPoint {
  return { sx: (x - y) * HALF_W, sy: (x + y) * HALF_H };
}

/**
 * Inverse of `tileToScreen`, rounded to the containing diamond. The affine inverse maps every
 * diamond onto the unit square centred on its tile coordinate, so plain rounding is exact.
 */
export function screenToTile(sx: number, sy: number): TilePoint {
  const f = screenToTileF(sx, sy);
  return { x: Math.round(f.x), y: Math.round(f.y) };
}

/** Unrounded inverse of `tileToScreen`. */
export function screenToTileF(sx: number, sy: number): { x: number; y: number } {
  const u = sx / HALF_W;
  const v = sy / HALF_H;
  return { x: (u + v) / 2, y: (v - u) / 2 };
}

/**
 * Painter's-order key: things further down the screen (larger x + y) draw later. `extra` breaks
 * ties inside a tile row (avatars use 500 so they draw over furniture that shares their row).
 */
export function depthKey(x: number, y: number, extra = 0): number {
  return (x + y) * 1000 + extra;
}

/** The four corners of a tile's top face as a flat `[x0, y0, x1, y1, …]` array: N, E, S, W. */
export function tileDiamond(x: number, y: number, out: number[] = []): number[] {
  const { sx, sy } = tileToScreen(x, y);
  out.length = 0;
  out.push(sx, sy - HALF_H, sx + HALF_W, sy, sx, sy + HALF_H, sx - HALF_W, sy);
  return out;
}

/**
 * Screen-space parallelogram for the axis-aligned tile rectangle `[x0, x1] × [y0, y1]` given in
 * (fractional) tile units, e.g. a 2×1 desk at (2,1) covers `[1.5, 3.5] × [0.5, 1.5]`.
 * Returned as N, E, S, W corners (flat array) — the same winding as `tileDiamond`.
 */
export function isoRectPoints(x0: number, y0: number, x1: number, y1: number): number[] {
  const n = tileToScreen(x0, y0);
  const e = tileToScreen(x1, y0);
  const s = tileToScreen(x1, y1);
  const w = tileToScreen(x0, y1);
  return [n.sx, n.sy, e.sx, e.sy, s.sx, s.sy, w.sx, w.sy];
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Screen-space bounding box of a room including its walls (used by the camera to centre it). */
export function roomBounds(width: number, height: number, wallHeight = WALL_H): Bounds {
  return {
    minX: -height * HALF_W,
    maxX: width * HALF_W,
    minY: -HALF_H - wallHeight,
    maxY: (width + height - 2) * HALF_H + HALF_H,
  };
}

/** Screen-space unit vector for each facing: 0 N up-right, 1 E down-right, 2 S down-left, 3 W up-left. */
const DIAG = 1 / Math.hypot(HALF_W, HALF_H);
export const FACING_DIR: readonly (readonly [number, number])[] = [
  [HALF_W * DIAG, -HALF_H * DIAG],
  [HALF_W * DIAG, HALF_H * DIAG],
  [-HALF_W * DIAG, HALF_H * DIAG],
  [-HALF_W * DIAG, -HALF_H * DIAG],
];

/**
 * Facing for a movement delta in tile space. +x is east (down-right), +y is south (down-left);
 * diagonals prefer the east/west component so avatars show their side while walking along rows.
 */
export function facingFromDelta(dx: number, dy: number): 0 | 1 | 2 | 3 {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 1 : 3;
  return dy > 0 ? 2 : 0;
}

export function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

export function chebyshev(a: TilePoint, b: TilePoint): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
