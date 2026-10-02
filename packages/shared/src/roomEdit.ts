import type { Furniture, FurnitureKind, Room } from './dto.js';
import { FURNITURE_CATALOG, footprintTiles, interactionTiles, rotatedSize } from './furniture.js';
import { newId } from './ids.js';

/**
 * Pure room-editing operations. Every function returns a new Room (or an error string) and never
 * mutates its input, so the UI can preview, undo, and the server can validate the same way.
 */

export type EditResult = { ok: true; room: Room } | { ok: false; error: string };

const key = (x: number, y: number) => `${x},${y}`;

export function inBounds(room: Room, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < room.width && y < room.height;
}

/** Tiles covered by blocking furniture, mapped to the owning piece id. */
export function blockedTiles(room: Room, ignoreId?: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of room.furniture) {
    if (f.id === ignoreId || !FURNITURE_CATALOG[f.kind].blocks) continue;
    for (const t of footprintTiles(f.kind, f.x, f.y, f.rotation)) m.set(key(t.x, t.y), f.id);
  }
  return m;
}

/** Can a piece of `kind` sit at (x, y, rotation)? Checks bounds and overlap with other blocking pieces. */
export function canPlace(
  room: Room,
  kind: FurnitureKind,
  x: number,
  y: number,
  rotation: number,
  ignoreId?: string,
): { ok: boolean; reason?: string } {
  const spec = FURNITURE_CATALOG[kind];
  const tiles = footprintTiles(kind, x, y, rotation);
  for (const t of tiles)
    if (!inBounds(room, t.x, t.y)) return { ok: false, reason: 'outside the room' };
  const blocked = blockedTiles(room, ignoreId);
  if (spec.blocks) {
    for (const t of tiles)
      if (blocked.has(key(t.x, t.y))) return { ok: false, reason: 'overlaps another piece' };
    // Also keep other pieces' interaction tiles usable (a desk in front of a bookshelf blocks it).
    for (const f of room.furniture) {
      if (f.id === ignoreId) continue;
      for (const p of interactionTiles(f.kind, f.x, f.y, f.rotation)) {
        if (tiles.some((t) => t.x === p.x && t.y === p.y))
          return {
            ok: false,
            reason: `would block ${FURNITURE_CATALOG[f.kind].label.toLowerCase()} access`,
          };
      }
    }
  }
  // Non-blocking pieces (rug, chair, door) may lie under furniture; only their access tiles must stay
  // free, which the check below covers.
  // The piece's own interaction tiles must be inside the room and free of blocking furniture.
  for (const p of interactionTiles(kind, x, y, rotation)) {
    if (!inBounds(room, p.x, p.y))
      return { ok: false, reason: 'its access tile would be outside the room' };
    if (blocked.has(key(p.x, p.y))) return { ok: false, reason: 'its access tile is blocked' };
  }
  return { ok: true };
}

export function placeFurniture(
  room: Room,
  kind: FurnitureKind,
  x: number,
  y: number,
  rotation = 0,
  id = newId(),
): EditResult {
  const check = canPlace(room, kind, x, y, rotation);
  if (!check.ok) return { ok: false, error: check.reason ?? 'cannot place here' };
  const piece: Furniture = {
    id,
    roomId: room.id,
    kind,
    x,
    y,
    rotation: ((rotation % 4) + 4) % 4,
    meta: {},
  };
  return {
    ok: true,
    room: { ...room, furniture: [...room.furniture, piece], updatedAt: Date.now() },
  };
}

export function moveFurniture(room: Room, id: string, x: number, y: number): EditResult {
  const f = room.furniture.find((p) => p.id === id);
  if (!f) return { ok: false, error: 'unknown piece' };
  const check = canPlace(room, f.kind, x, y, f.rotation, id);
  if (!check.ok) return { ok: false, error: check.reason ?? 'cannot move here' };
  return {
    ok: true,
    room: {
      ...room,
      furniture: room.furniture.map((p) => (p.id === id ? { ...p, x, y } : p)),
      updatedAt: Date.now(),
    },
  };
}

export function rotateFurniture(room: Room, id: string, steps = 1): EditResult {
  const f = room.furniture.find((p) => p.id === id);
  if (!f) return { ok: false, error: 'unknown piece' };
  const rotation = (((f.rotation + steps) % 4) + 4) % 4;
  const check = canPlace(room, f.kind, f.x, f.y, rotation, id);
  if (!check.ok) return { ok: false, error: check.reason ?? 'cannot rotate here' };
  return {
    ok: true,
    room: {
      ...room,
      furniture: room.furniture.map((p) => (p.id === id ? { ...p, rotation } : p)),
      updatedAt: Date.now(),
    },
  };
}

export function removeFurniture(room: Room, id: string): EditResult {
  if (!room.furniture.some((p) => p.id === id)) return { ok: false, error: 'unknown piece' };
  return {
    ok: true,
    room: { ...room, furniture: room.furniture.filter((p) => p.id !== id), updatedAt: Date.now() },
  };
}

export function furnitureAt(room: Room, x: number, y: number): Furniture | undefined {
  return room.furniture.find((f) =>
    footprintTiles(f.kind, f.x, f.y, f.rotation).some((t) => t.x === x && t.y === y),
  );
}

export function paintFloor(room: Room, x: number, y: number, style: number): EditResult {
  if (!inBounds(room, x, y)) return { ok: false, error: 'outside the room' };
  const floor = room.floor.slice();
  floor[y * room.width + x] = style;
  return { ok: true, room: { ...room, floor, updatedAt: Date.now() } };
}

/** Wall segments: indices 0..width-1 are the north wall (by x), width..width+height-1 the west wall (by y). */
export function paintWall(room: Room, index: number, style: number): EditResult {
  if (index < 0 || index >= room.width + room.height)
    return { ok: false, error: 'no such wall segment' };
  const walls = room.walls.slice();
  walls[index] = style;
  return { ok: true, room: { ...room, walls, updatedAt: Date.now() } };
}

/** Full validation used by the server before saving a layout. Returns a list of problems (empty = valid). */
export function validateRoom(room: Room): string[] {
  const problems: string[] = [];
  if (room.floor.length !== room.width * room.height)
    problems.push('floor array length does not match the room size');
  if (room.walls.length !== room.width + room.height)
    problems.push('walls array length does not match the room size');
  const ids = new Set<string>();
  for (const f of room.furniture) {
    if (ids.has(f.id)) problems.push(`duplicate furniture id ${f.id}`);
    ids.add(f.id);
    if (f.roomId !== room.id) problems.push(`${f.id} belongs to another room`);
    const others: Room = { ...room, furniture: room.furniture.filter((p) => p.id !== f.id) };
    const check = canPlace(others, f.kind, f.x, f.y, f.rotation);
    if (!check.ok) problems.push(`${f.id} (${f.kind} at ${f.x},${f.y}): ${check.reason}`);
  }
  if (!room.furniture.some((f) => f.kind === 'door')) problems.push('the room needs a door');
  return problems;
}

/** Resize keeping the top-left content; pieces that no longer fit are dropped. */
export function resizeRoom(room: Room, width: number, height: number): Room {
  const floor = new Array<number>(width * height).fill(0);
  for (let y = 0; y < Math.min(height, room.height); y++) {
    for (let x = 0; x < Math.min(width, room.width); x++)
      floor[y * width + x] = room.floor[y * room.width + x] ?? 0;
  }
  const walls = new Array<number>(width + height).fill(0);
  for (let i = 0; i < Math.min(width, room.width); i++) walls[i] = room.walls[i] ?? 0;
  for (let i = 0; i < Math.min(height, room.height); i++)
    walls[width + i] = room.walls[room.width + i] ?? 0;
  const resized: Room = {
    ...room,
    width,
    height,
    floor,
    walls,
    furniture: [],
    updatedAt: Date.now(),
  };
  const kept = room.furniture.filter((f) => {
    const { w, h } = rotatedSize(f.kind, f.rotation);
    return f.x + w <= width && f.y + h <= height;
  });
  return { ...resized, furniture: kept };
}
