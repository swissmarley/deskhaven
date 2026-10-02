import type { Behavior, Facing, Room, Station } from '@agenthotel/shared';
import { FURNITURE_CATALOG, interactionTiles, stationForBehavior } from '@agenthotel/shared';
import { buildGrid, type Grid, isWalkable, randomWalkable, tileKey } from './grid.js';
import { chebyshev, octile } from './iso.js';
import type { TilePoint } from './types.js';

/** Where an avatar should go for a behaviour and how to stand there. */
export interface StationTarget {
  x: number;
  y: number;
  facing: Facing;
  seated: boolean;
  /** Furniture the target belongs to, or null for `stay` / `roam`. */
  furnitureId: string | null;
}

export interface StationAvatar {
  id: string;
  deskId: string | null;
  tile: TilePoint;
  /** Current facing, kept for `stay`. Defaults to south (towards the camera). */
  facing?: Facing;
}

export interface StationOptions {
  /** Seeded RNG for `roam`; defaults to `Math.random`. */
  rng?: () => number;
  /** Pre-built grid for the room (built on demand otherwise). */
  grid?: Grid;
  /** Minimum Chebyshev distance of a roam target from the avatar (default 3). */
  minRoamDistance?: number;
}

/** Catalog station for each logical behaviour station (`stay`/`roam`/`own_desk` have none). */
const CATALOG_STATION: Partial<
  Record<Station, NonNullable<(typeof FURNITURE_CATALOG)['desk']['station']>>
> = {
  bookshelf: 'bookshelf',
  server_rack: 'server_rack',
  library_pc: 'library_pc',
  coffee_machine: 'coffee_machine',
  sofa: 'sofa',
  whiteboard: 'whiteboard',
  door: 'door',
};

/** All interaction tiles of furniture whose catalog `station` matches, inside the room. */
export function stationCandidates(
  room: Room,
  station: NonNullable<(typeof FURNITURE_CATALOG)['desk']['station']>,
  grid: Grid,
): StationTarget[] {
  const out: StationTarget[] = [];
  for (const piece of room.furniture) {
    if (FURNITURE_CATALOG[piece.kind].station !== station) continue;
    for (const p of interactionTiles(piece.kind, piece.x, piece.y, piece.rotation)) {
      if (!isWalkable(grid, p.x, p.y)) continue;
      out.push({
        x: p.x,
        y: p.y,
        facing: p.facing,
        seated: p.type === 'seat',
        furnitureId: piece.id,
      });
    }
  }
  return out;
}

/**
 * Resolve the target tile for `stationForBehavior(behavior)`.
 *
 * - `own_desk`: the seat of the furniture with id `deskId`, else any free desk seat.
 * - furniture stations: the nearest free interaction tile (octile distance from the avatar).
 * - `stay`: the current tile. `roam`: a random walkable tile ≥ `minRoamDistance` away.
 *
 * `occupied` holds `tileKey`s claimed by *other* avatars; the avatar's own tile is always free.
 * Returns null when nothing suitable exists (callers should treat that as `stay`).
 */
export function resolveStation(
  room: Room,
  behavior: Behavior,
  avatar: StationAvatar,
  occupied: ReadonlySet<string>,
  opts: StationOptions = {},
): StationTarget | null {
  const grid = opts.grid ?? buildGrid(room);
  const station = stationForBehavior(behavior);
  const here = avatar.tile;
  const free = (t: TilePoint): boolean =>
    (t.x === here.x && t.y === here.y) || !occupied.has(tileKey(t.x, t.y));

  switch (station) {
    case 'stay':
      return {
        x: here.x,
        y: here.y,
        facing: avatar.facing ?? 2,
        seated: false,
        furnitureId: null,
      };
    case 'roam': {
      const rng = opts.rng ?? Math.random;
      const minD = opts.minRoamDistance ?? 3;
      const seats = seatTiles(room);
      const pick =
        randomWalkable(
          grid,
          rng,
          (t) => chebyshev(t, here) >= minD && free(t) && !seats.has(tileKey(t.x, t.y)),
        ) ?? randomWalkable(grid, rng, (t) => free(t) && !seats.has(tileKey(t.x, t.y)));
      return pick
        ? { x: pick.x, y: pick.y, facing: avatar.facing ?? 2, seated: false, furnitureId: null }
        : null;
    }
    case 'own_desk': {
      const desks = stationCandidates(room, 'desk', grid);
      const own = desks.find((d) => d.furnitureId === avatar.deskId && free(d));
      if (own) return own;
      return nearest(desks.filter(free), here);
    }
    default: {
      const catalogStation = CATALOG_STATION[station];
      if (!catalogStation) return null;
      return nearest(stationCandidates(room, catalogStation, grid).filter(free), here);
    }
  }
}

function nearest(candidates: StationTarget[], from: TilePoint): StationTarget | null {
  let best: StationTarget | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = octile(c.x, c.y, from.x, from.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

/** Tiles that are seats (so roaming avatars do not stand on sofas). */
function seatTiles(room: Room): Set<string> {
  const out = new Set<string>();
  for (const piece of room.furniture)
    for (const p of interactionTiles(piece.kind, piece.x, piece.y, piece.rotation))
      if (p.type === 'seat') out.add(tileKey(p.x, p.y));
  return out;
}
