import { defaultRoom } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import {
  beginFurnitureDrag,
  beginPaint,
  clampOrigin,
  dragOriginFor,
  editorKeyFor,
  GHOST_INVALID,
  GHOST_VALID,
  ghostTint,
  paintStep,
  samePoint,
} from '../src/game/editor.js';
import {
  FLOOR_STYLE_COUNT,
  FLOOR_STYLES,
  floorStyleColors,
  WALL_STYLE_COUNT,
  WALL_STYLES,
  wallStyleColor,
} from '../src/game/styles.js';

describe('furniture drag snapping', () => {
  const desk = { kind: 'desk' as const, x: 5, y: 1, rotation: 0 };

  it('keeps the grabbed cell under the pointer so the piece does not jump', () => {
    // Grab the 2×1 desk by its second tile.
    const grab = beginFurnitureDrag(desk, { x: 6, y: 1 });
    expect(grab).toEqual({ w: 2, h: 1, dx: 1, dy: 0 });
    // Not moving the pointer leaves the origin where it was.
    expect(dragOriginFor(grab, { x: 6, y: 1 })).toEqual({ x: 5, y: 1 });
    // Moving three tiles right and two down moves the origin by the same delta.
    expect(dragOriginFor(grab, { x: 9, y: 3 })).toEqual({ x: 8, y: 3 });
  });

  it('clamps the grab offset into the footprint (the prism hit area is taller than its base)', () => {
    // Pointer on the tile "behind" the desk, where the prism's top face is drawn.
    const behind = beginFurnitureDrag(desk, { x: 5, y: 0 });
    expect(behind.dy).toBe(0);
    const beyond = beginFurnitureDrag(desk, { x: 9, y: 1 });
    expect(beyond.dx).toBe(1);
  });

  it('uses the rotated footprint', () => {
    const grab = beginFurnitureDrag({ ...desk, rotation: 1 }, { x: 5, y: 2 });
    expect(grab).toEqual({ w: 1, h: 2, dx: 0, dy: 1 });
    expect(dragOriginFor(grab, { x: 7, y: 7 })).toEqual({ x: 7, y: 6 });
  });

  it('keeps the footprint inside the room', () => {
    const room = defaultRoom(0);
    expect(clampOrigin({ x: -1, y: -2 }, { w: 2, h: 1 }, room)).toEqual({ x: 0, y: 0 });
    expect(clampOrigin({ x: 13, y: 9 }, { w: 2, h: 1 }, room)).toEqual({ x: 12, y: 9 });
    expect(clampOrigin({ x: 4, y: 4 }, { w: 2, h: 1 }, room)).toEqual({ x: 4, y: 4 });
    // Oversized pieces pin to the origin rather than going negative.
    expect(clampOrigin({ x: 3, y: 3 }, { w: 50, h: 50 }, room)).toEqual({ x: 0, y: 0 });
  });
});

describe('paint stroke', () => {
  it('emits nothing while the pointer stays on the press tile or leaves the room', () => {
    const stroke = beginPaint({ x: 2, y: 2 });
    expect(paintStep(stroke, { x: 2, y: 2 })).toEqual([]);
    expect(paintStep(stroke, null)).toEqual([]);
    expect(stroke.emitted).toBe(false);
  });

  it('emits the press tile once the stroke leaves it, then each new tile exactly once', () => {
    const stroke = beginPaint({ x: 2, y: 2 });
    expect(paintStep(stroke, { x: 3, y: 2 })).toEqual([
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ]);
    expect(paintStep(stroke, { x: 3, y: 2 })).toEqual([]);
    expect(paintStep(stroke, { x: 4, y: 2 })).toEqual([{ x: 4, y: 2 }]);
    // Going back over a tile re-emits it (the UI's paint is idempotent); the press tile is not repeated as a start.
    expect(paintStep(stroke, { x: 3, y: 2 })).toEqual([{ x: 3, y: 2 }]);
    expect(stroke.emitted).toBe(true);
  });
});

describe('editor keys and ghost colours', () => {
  it('maps only the editor shortcuts', () => {
    expect(editorKeyFor('r')).toBe('r');
    expect(editorKeyFor('R')).toBe('R');
    expect(editorKeyFor('Delete')).toBe('Delete');
    expect(editorKeyFor('Backspace')).toBe('Backspace');
    expect(editorKeyFor('Escape')).toBe('Escape');
    expect(editorKeyFor('a')).toBeNull();
    expect(editorKeyFor(' ')).toBeNull();
    expect(editorKeyFor('Enter')).toBeNull();
  });

  it('tints valid placements green and invalid ones red', () => {
    expect(ghostTint(true)).toBe(GHOST_VALID);
    expect(ghostTint(false)).toBe(GHOST_INVALID);
    expect(GHOST_VALID).not.toBe(GHOST_INVALID);
  });

  it('compares tiles by value', () => {
    expect(samePoint({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(true);
    expect(samePoint({ x: 1, y: 2 }, { x: 2, y: 1 })).toBe(false);
    expect(samePoint(null, null)).toBe(true);
    expect(samePoint({ x: 0, y: 0 }, null)).toBe(false);
  });
});

describe('floor and wall styles', () => {
  it('defines five distinct floor styles and three wall styles', () => {
    expect(FLOOR_STYLE_COUNT).toBe(5);
    expect(WALL_STYLE_COUNT).toBe(3);
    const floors = new Set(FLOOR_STYLES.map((p) => p[0]));
    expect(floors.size).toBe(FLOOR_STYLES.length);
    const walls = new Set(WALL_STYLES.map((p) => p[0]));
    expect(walls.size).toBe(WALL_STYLES.length);
  });

  it('falls back to style 0 for unknown ids', () => {
    expect(floorStyleColors(99)).toEqual(FLOOR_STYLES[0]);
    expect(floorStyleColors(-1)).toEqual(FLOOR_STYLES[0]);
    expect(wallStyleColor('north', 99)).toBe(WALL_STYLES[0]?.[0]);
    expect(wallStyleColor('west', 2)).toBe(WALL_STYLES[2]?.[1]);
  });
});
