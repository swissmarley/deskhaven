import { describe, expect, it } from 'vitest';
import { defaultRoom } from '../src/defaultRoom.js';
import {
  canPlace,
  furnitureAt,
  moveFurniture,
  paintFloor,
  paintWall,
  placeFurniture,
  removeFurniture,
  resizeRoom,
  rotateFurniture,
  validateRoom,
} from '../src/roomEdit.js';

const room = defaultRoom(0);

describe('room editing', () => {
  it('the default room is valid', () => {
    expect(validateRoom(room)).toEqual([]);
  });

  it('places a plant on a free tile and refuses overlaps, out-of-bounds and blocked access', () => {
    const ok = placeFurniture(room, 'plant', 6, 2);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.room.furniture).toHaveLength(room.furniture.length + 1);
    expect(placeFurniture(room, 'plant', 2, 1)).toMatchObject({
      ok: false,
      error: 'overlaps another piece',
    });
    expect(placeFurniture(room, 'desk', 13, 0)).toMatchObject({
      ok: false,
      error: 'outside the room',
    });
    // in front of the bookshelf (its stand tiles are (11,1) and (12,1))
    expect(placeFurniture(room, 'plant', 11, 1)).toMatchObject({
      ok: false,
      error: expect.stringContaining('bookshelf access'),
    });
    // a desk whose seat would be outside the room
    expect(placeFurniture(room, 'desk', 6, 9)).toMatchObject({
      ok: false,
      error: expect.stringContaining('outside'),
    });
    expect(room.furniture).toHaveLength(defaultRoom(0).furniture.length); // immutability
  });

  it('moves, rotates and removes pieces with validation', () => {
    const moved = moveFurniture(room, 'bookshelf-1', 6, 7);
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      expect(furnitureAt(moved.room, 7, 7)?.id).toBe('bookshelf-1');
      expect(furnitureAt(moved.room, 11, 0)).toBeUndefined();
      expect(validateRoom(moved.room)).toEqual([]);
    }
    expect(moveFurniture(room, 'bookshelf-1', 2, 1)).toMatchObject({ ok: false });
    expect(moveFurniture(room, 'nope', 0, 0)).toMatchObject({ ok: false, error: 'unknown piece' });
    const rotated = rotateFurniture(room, 'desk-1');
    expect(rotated.ok).toBe(true);
    if (rotated.ok) expect(rotated.room.furniture.find((f) => f.id === 'desk-1')?.rotation).toBe(1);
    const removed = removeFurniture(room, 'plant-1');
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.room.furniture.some((f) => f.id === 'plant-1')).toBe(false);
  });

  it('paints floor and walls within bounds', () => {
    const f = paintFloor(room, 3, 3, 2);
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.room.floor[3 * room.width + 3]).toBe(2);
    expect(paintFloor(room, 99, 0, 1)).toMatchObject({ ok: false });
    const w = paintWall(room, room.width + 2, 1);
    expect(w.ok).toBe(true);
    if (w.ok) expect(w.room.walls[room.width + 2]).toBe(1);
    expect(paintWall(room, 999, 1)).toMatchObject({ ok: false });
  });

  it('validation reports overlaps, missing doors and size mismatches', () => {
    const bad = {
      ...room,
      furniture: [
        ...room.furniture,
        { id: 'x', roomId: room.id, kind: 'plant' as const, x: 2, y: 1, rotation: 0, meta: {} },
      ],
    };
    expect(validateRoom(bad).some((p) => p.startsWith('x (plant'))).toBe(true);
    const noDoor = { ...room, furniture: room.furniture.filter((f) => f.kind !== 'door') };
    expect(validateRoom(noDoor)).toContain('the room needs a door');
    expect(validateRoom({ ...room, floor: [] })[0]).toMatch(/floor array/);
  });

  it('resizes keeping fitting pieces', () => {
    const small = resizeRoom(room, 8, 6);
    expect(small.floor).toHaveLength(48);
    expect(small.walls).toHaveLength(14);
    expect(small.furniture.every((f) => f.x < 8 && f.y < 6)).toBe(true);
    expect(small.furniture.some((f) => f.id === 'bookshelf-1')).toBe(false);
    expect(canPlace(small, 'plant', 7, 5, 0).ok).toBe(true);
  });
});
