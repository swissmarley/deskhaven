import type { Room } from '@agenthotel/shared';
import { FURNITURE_CATALOG, footprintTiles, interactionTiles } from '@agenthotel/shared';
import type { TilePoint } from './types.js';

/**
 * Walkability grid derived from a room. A tile is blocked when it lies outside the room or is
 * covered by furniture whose catalog spec `blocks`, except that a piece's own interaction tiles
 * stay walkable (a sofa seat is inside the sofa footprint, yet avatars must be able to sit there).
 */
export interface Grid {
  readonly width: number;
  readonly height: number;
  /** 1 = blocked, 0 = walkable, row-major `y * width + x`. */
  readonly blocked: Uint8Array;
  /** Every walkable tile in row-major order (cached for random picks). */
  readonly walkable: readonly TilePoint[];
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function buildGrid(room: Room): Grid {
  const { width, height } = room;
  const blocked = new Uint8Array(width * height);
  for (const piece of room.furniture) {
    const spec = FURNITURE_CATALOG[piece.kind];
    if (!spec.blocks) continue;
    const open = new Set(
      interactionTiles(piece.kind, piece.x, piece.y, piece.rotation).map((t) => tileKey(t.x, t.y)),
    );
    for (const t of footprintTiles(piece.kind, piece.x, piece.y, piece.rotation)) {
      if (t.x < 0 || t.y < 0 || t.x >= width || t.y >= height) continue;
      if (open.has(tileKey(t.x, t.y))) continue;
      blocked[t.y * width + t.x] = 1;
    }
  }
  const walkable: TilePoint[] = [];
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) if (blocked[y * width + x] === 0) walkable.push({ x, y });
  return { width, height, blocked, walkable };
}

export function inBounds(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

export function isWalkable(grid: Grid, x: number, y: number): boolean {
  return inBounds(grid, x, y) && (grid.blocked[y * grid.width + x] ?? 1) === 0;
}

/** The 8 directions as (dx, dy) pairs, orthogonals first. */
export const DIRS8: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * Walkable 8-neighbours. A diagonal step is only allowed when both orthogonal tiles it passes
 * between are walkable, so avatars never clip through furniture corners.
 */
export function neighbors8(grid: Grid, x: number, y: number, out: TilePoint[] = []): TilePoint[] {
  out.length = 0;
  for (const [dx, dy] of DIRS8) {
    const nx = x + dx;
    const ny = y + dy;
    if (!isWalkable(grid, nx, ny)) continue;
    if (dx !== 0 && dy !== 0 && (!isWalkable(grid, x + dx, y) || !isWalkable(grid, x, y + dy)))
      continue;
    out.push({ x: nx, y: ny });
  }
  return out;
}

/**
 * Random walkable tile using the supplied RNG (`() => number` in [0, 1)). With a predicate,
 * samples a few times then falls back to a linear scan from a random offset so a valid tile is
 * always found when one exists.
 */
export function randomWalkable(
  grid: Grid,
  rng: () => number,
  predicate?: (tile: TilePoint) => boolean,
): TilePoint | null {
  const list = grid.walkable;
  const n = list.length;
  if (n === 0) return null;
  if (!predicate) return list[Math.floor(rng() * n)] ?? null;
  for (let i = 0; i < 32; i++) {
    const t = list[Math.floor(rng() * n)];
    if (t && predicate(t)) return t;
  }
  const start = Math.floor(rng() * n);
  for (let k = 0; k < n; k++) {
    const t = list[(start + k) % n];
    if (t && predicate(t)) return t;
  }
  return null;
}

/** Closest walkable tile to `from` by Chebyshev rings (the tile itself first), skipping `exclude`. */
export function nearestWalkable(
  grid: Grid,
  from: TilePoint,
  exclude?: ReadonlySet<string>,
): TilePoint | null {
  const ok = (x: number, y: number): boolean =>
    isWalkable(grid, x, y) && !(exclude?.has(tileKey(x, y)) ?? false);
  if (ok(from.x, from.y)) return { x: from.x, y: from.y };
  const maxR = Math.max(grid.width, grid.height);
  for (let r = 1; r <= maxR; r++) {
    let best: TilePoint | null = null;
    let bestD = Number.POSITIVE_INFINITY;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = from.x + dx;
        const y = from.y + dy;
        if (!ok(x, y)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x, y };
        }
      }
    }
    if (best) return best;
  }
  return null;
}
