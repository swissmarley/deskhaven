import { defaultRoom, type Room } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { buildGrid, isWalkable } from '../src/game/grid.js';
import { findPath } from '../src/game/pathfinding.js';

function emptyRoom(width: number, height: number, furniture: Room['furniture'] = []): Room {
  return {
    id: 'r',
    name: 'r',
    width,
    height,
    floor: new Array<number>(width * height).fill(0),
    walls: new Array<number>(width + height).fill(0),
    furniture,
    updatedAt: 0,
  };
}

const plant = (id: string, x: number, y: number): Room['furniture'][number] => ({
  id,
  roomId: 'r',
  kind: 'plant',
  x,
  y,
  rotation: 0,
  meta: {},
});

describe('A* pathfinding', () => {
  it('walks a straight line and a clean diagonal', () => {
    const grid = buildGrid(emptyRoom(8, 8));
    expect(findPath(grid, { x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]);
    const diag = findPath(grid, { x: 0, y: 0 }, { x: 3, y: 3 });
    expect(diag).toHaveLength(3);
    expect(diag?.at(-1)).toEqual({ x: 3, y: 3 });
  });

  it('returns an empty path when already at the goal', () => {
    const grid = buildGrid(emptyRoom(4, 4));
    expect(findPath(grid, { x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });

  it('routes around an obstacle wall without cutting corners', () => {
    // Vertical wall of plants at x = 3, y = 0..5 in a 7×7 room; gap at y = 6.
    const wall = [0, 1, 2, 3, 4, 5].map((y) => plant(`p${y}`, 3, y));
    const grid = buildGrid(emptyRoom(7, 7, wall));
    const path = findPath(grid, { x: 1, y: 0 }, { x: 5, y: 0 });
    expect(path).not.toBeNull();
    expect(path?.at(-1)).toEqual({ x: 5, y: 0 });
    for (const t of path ?? []) expect(isWalkable(grid, t.x, t.y)).toBe(true);
    // Must pass through the gap row.
    expect(path?.some((t) => t.x === 3 && t.y === 6)).toBe(true);
    // Consecutive steps are at most one tile apart and never clip a blocked corner.
    let prev = { x: 1, y: 0 };
    for (const t of path ?? []) {
      expect(Math.max(Math.abs(t.x - prev.x), Math.abs(t.y - prev.y))).toBe(1);
      if (t.x !== prev.x && t.y !== prev.y) {
        expect(isWalkable(grid, t.x, prev.y)).toBe(true);
        expect(isWalkable(grid, prev.x, t.y)).toBe(true);
      }
      prev = t;
    }
  });

  it('returns null when the goal is enclosed', () => {
    // Box the tile (3,3) in with plants on all 8 neighbours.
    const ring: Room['furniture'] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        if (dx !== 0 || dy !== 0) ring.push(plant(`r${dx}${dy}`, 3 + dx, 3 + dy));
    const grid = buildGrid(emptyRoom(7, 7, ring));
    expect(findPath(grid, { x: 0, y: 0 }, { x: 3, y: 3 })).toBeNull();
    // And the other way round: starting inside the box.
    expect(findPath(grid, { x: 3, y: 3 }, { x: 0, y: 0 })).toBeNull();
  });

  it('paths to a walkable tile adjacent to a blocked goal', () => {
    const room = defaultRoom(0);
    const grid = buildGrid(room);
    const path = findPath(grid, { x: 7, y: 7 }, { x: 0, y: 3 }); // plant-1
    expect(path).not.toBeNull();
    const end = path?.at(-1);
    expect(end).toBeDefined();
    expect(isWalkable(grid, end?.x ?? -1, end?.y ?? -1)).toBe(true);
    expect(Math.max(Math.abs((end?.x ?? 0) - 0), Math.abs((end?.y ?? 0) - 3))).toBe(1);
    // Already adjacent to a blocked goal → nothing to do.
    expect(findPath(grid, { x: 1, y: 3 }, { x: 0, y: 3 })).toEqual([]);
  });

  it('crosses the default room from the door to a desk seat', () => {
    const grid = buildGrid(defaultRoom(0));
    const path = findPath(grid, { x: 0, y: 9 }, { x: 8, y: 2 });
    expect(path).not.toBeNull();
    expect(path?.at(-1)).toEqual({ x: 8, y: 2 });
    for (const t of path ?? []) expect(isWalkable(grid, t.x, t.y)).toBe(true);
  });
});
