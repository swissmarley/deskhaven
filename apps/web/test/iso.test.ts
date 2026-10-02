import { describe, expect, it } from 'vitest';
import {
  depthKey,
  FACING_DIR,
  facingFromDelta,
  isoRectPoints,
  roomBounds,
  screenToTile,
  tileDiamond,
  tileToScreen,
} from '../src/game/iso.js';

describe('iso maths', () => {
  it('maps tile centres to screen', () => {
    expect(tileToScreen(0, 0)).toEqual({ sx: 0, sy: 0 });
    expect(tileToScreen(1, 0)).toEqual({ sx: 32, sy: 16 });
    expect(tileToScreen(0, 1)).toEqual({ sx: -32, sy: 16 });
    expect(tileToScreen(3, 2)).toEqual({ sx: 32, sy: 80 });
  });

  it('round-trips every tile of a 14×10 room', () => {
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 14; x++) {
        const { sx, sy } = tileToScreen(x, y);
        expect(screenToTile(sx, sy)).toEqual({ x, y });
      }
  });

  it('rounds points inside a diamond to that tile, and across an edge to the neighbour', () => {
    const c = tileToScreen(5, 4);
    // Just inside each corner of the diamond.
    expect(screenToTile(c.sx + 30, c.sy)).toEqual({ x: 5, y: 4 });
    expect(screenToTile(c.sx - 30, c.sy)).toEqual({ x: 5, y: 4 });
    expect(screenToTile(c.sx, c.sy + 15)).toEqual({ x: 5, y: 4 });
    expect(screenToTile(c.sx, c.sy - 15)).toEqual({ x: 5, y: 4 });
    // Crossing the bottom-right edge lands on the east neighbour (x + 1).
    expect(screenToTile(c.sx + 20, c.sy + 12)).toEqual({ x: 6, y: 4 });
    // Crossing the bottom-left edge lands on the south neighbour (y + 1).
    expect(screenToTile(c.sx - 20, c.sy + 12)).toEqual({ x: 5, y: 5 });
  });

  it('neighbours differ by half a tile in each axis', () => {
    const a = tileToScreen(4, 4);
    const e = tileToScreen(5, 4);
    const s = tileToScreen(4, 5);
    expect([e.sx - a.sx, e.sy - a.sy]).toEqual([32, 16]);
    expect([s.sx - a.sx, s.sy - a.sy]).toEqual([-32, 16]);
  });

  it('depthKey grows down the screen and honours extra', () => {
    expect(depthKey(0, 0)).toBe(0);
    expect(depthKey(2, 3)).toBe(5000);
    expect(depthKey(3, 2)).toBe(5000);
    expect(depthKey(2, 3, 500)).toBeGreaterThan(depthKey(3, 2));
    expect(depthKey(2, 3, 500)).toBeLessThan(depthKey(3, 3));
  });

  it('builds diamonds and iso rectangles with N,E,S,W winding', () => {
    expect(tileDiamond(0, 0)).toEqual([0, -16, 32, 0, 0, 16, -32, 0]);
    // A 2×1 footprint at (2,1) spans x ∈ [1.5, 3.5], y ∈ [0.5, 1.5].
    const pts = isoRectPoints(1.5, 0.5, 3.5, 1.5);
    expect(pts).toEqual([32, 32, 96, 64, 64, 80, 0, 48]);
  });

  it('room bounds enclose every tile and the walls', () => {
    const b = roomBounds(14, 10, 96);
    expect(b.minX).toBe(-320);
    expect(b.maxX).toBe(448);
    expect(b.minY).toBe(-112);
    expect(b.maxY).toBe(368);
    const far = tileToScreen(13, 9);
    expect(far.sy + 16).toBeLessThanOrEqual(b.maxY);
  });

  it('derives facings from movement deltas and has unit direction vectors', () => {
    expect(facingFromDelta(1, 0)).toBe(1);
    expect(facingFromDelta(-1, 0)).toBe(3);
    expect(facingFromDelta(0, 1)).toBe(2);
    expect(facingFromDelta(0, -1)).toBe(0);
    for (const [dx, dy] of FACING_DIR) expect(Math.hypot(dx, dy)).toBeCloseTo(1, 6);
    expect(FACING_DIR[0]?.[1]).toBeLessThan(0); // north points up
    expect(FACING_DIR[2]?.[0]).toBeLessThan(0); // south points left
  });
});
