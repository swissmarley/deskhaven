import { defaultRoom } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import {
  buildGrid,
  isWalkable,
  nearestWalkable,
  neighbors8,
  randomWalkable,
  tileKey,
} from '../src/game/grid.js';
import { mulberry32 } from '../src/game/rng.js';

describe('walkability grid', () => {
  const room = defaultRoom(0);
  const grid = buildGrid(room);

  it('blocks furniture footprints and the outside', () => {
    expect(isWalkable(grid, 2, 1)).toBe(false); // desk-1
    expect(isWalkable(grid, 3, 1)).toBe(false); // desk-1 second tile
    expect(isWalkable(grid, 0, 3)).toBe(false); // plant
    expect(isWalkable(grid, 13, 2)).toBe(false); // server rack
    expect(isWalkable(grid, -1, 0)).toBe(false);
    expect(isWalkable(grid, 14, 0)).toBe(false);
    expect(isWalkable(grid, 0, 10)).toBe(false);
  });

  it('keeps non-blocking furniture and interaction tiles walkable', () => {
    expect(isWalkable(grid, 6, 7)).toBe(true); // rug
    expect(isWalkable(grid, 0, 9)).toBe(true); // door
    expect(isWalkable(grid, 2, 2)).toBe(true); // desk-1 seat (outside footprint)
    expect(isWalkable(grid, 4, 8)).toBe(true); // sofa seat inside the sofa footprint
    expect(isWalkable(grid, 5, 8)).toBe(true);
  });

  it('never cuts corners through blocked tiles', () => {
    // (1,2) → (2,3) is diagonal past desk-1's tile (2,1)? No: check a real corner.
    // Plant at (0,3): from (1,4) moving to (0,... ) is out; use the rack column instead.
    // rack-1 at (13,2), rack-2 at (13,3). From (12,2) the diagonal to (13,1) requires (13,2) free.
    const ns = neighbors8(grid, 12, 2).map((t) => tileKey(t.x, t.y));
    expect(ns).not.toContain(tileKey(13, 1));
    expect(ns).not.toContain(tileKey(13, 3));
    expect(ns).toContain(tileKey(12, 1));
    expect(ns).toContain(tileKey(11, 2));
    // Open floor has all eight neighbours.
    expect(neighbors8(grid, 7, 6)).toHaveLength(8);
  });

  it('picks random walkable tiles deterministically', () => {
    const a = randomWalkable(grid, mulberry32(7));
    const b = randomWalkable(grid, mulberry32(7));
    expect(a).toEqual(b);
    expect(a && isWalkable(grid, a.x, a.y)).toBe(true);
    const far = randomWalkable(grid, mulberry32(3), (t) => t.x > 10);
    expect(far?.x).toBeGreaterThan(10);
    expect(randomWalkable(grid, mulberry32(3), () => false)).toBeNull();
  });

  it('finds the nearest walkable tile to a blocked one', () => {
    expect(nearestWalkable(grid, { x: 7, y: 6 })).toEqual({ x: 7, y: 6 });
    const n = nearestWalkable(grid, { x: 13, y: 2 });
    expect(n).not.toBeNull();
    expect(n && isWalkable(grid, n.x, n.y)).toBe(true);
    expect(n && Math.max(Math.abs(n.x - 13), Math.abs(n.y - 2))).toBe(1);
  });
});
