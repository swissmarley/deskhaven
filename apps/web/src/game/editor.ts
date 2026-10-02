import type { FurnitureKind } from '@agenthotel/shared';
import { rotatedSize } from '@agenthotel/shared';
import type { TilePoint } from './types.js';

/**
 * Pure editor helpers (no Pixi): pointer → piece-origin snapping for furniture drags, the paint
 * stroke bookkeeping, the keyboard mapping and the ghost colours. Covered by
 * `test/editor-geometry.test.ts` under plain node.
 */

export interface PlacedPiece {
  kind: FurnitureKind;
  x: number;
  y: number;
  rotation: number;
}

/** A furniture drag in progress: the rotated footprint size and the cell the pointer grabbed. */
export interface DragGrab {
  w: number;
  h: number;
  /** Offset of the grabbed cell from the piece's origin, clamped into the footprint. */
  dx: number;
  dy: number;
}

/**
 * Start dragging `piece` from the tile under the pointer. The offset is clamped into the footprint
 * because the hit area (a prism) is taller than the footprint, so the pointer tile may lie behind it.
 */
export function beginFurnitureDrag(piece: PlacedPiece, pointerTile: TilePoint): DragGrab {
  const { w, h } = rotatedSize(piece.kind, piece.rotation);
  return {
    w,
    h,
    dx: clamp(pointerTile.x - piece.x, 0, w - 1),
    dy: clamp(pointerTile.y - piece.y, 0, h - 1),
  };
}

/** Origin the dragged piece snaps to so the grabbed cell stays under the pointer (no jump). */
export function dragOriginFor(grab: DragGrab, pointerTile: TilePoint): TilePoint {
  return { x: pointerTile.x - grab.dx, y: pointerTile.y - grab.dy };
}

/** Keep a `w × h` footprint inside the room; a piece larger than the room pins to the origin. */
export function clampOrigin(
  origin: TilePoint,
  size: { w: number; h: number },
  room: { width: number; height: number },
): TilePoint {
  return {
    x: clamp(origin.x, 0, Math.max(0, room.width - size.w)),
    y: clamp(origin.y, 0, Math.max(0, room.height - size.h)),
  };
}

/**
 * A paint stroke (primary button held over tiles). The press tile is reported through
 * `onTileClick` when the button is released on it; once the pointer moves to another tile the
 * stroke emits the press tile first, then every newly entered tile, each exactly once.
 */
export interface PaintStroke {
  start: TilePoint;
  last: TilePoint;
  /** True once the stroke has emitted anything (the press tile then no longer counts as a click). */
  emitted: boolean;
}

export function beginPaint(tile: TilePoint): PaintStroke {
  return { start: tile, last: tile, emitted: false };
}

/** Tiles to emit for a pointer move to `tile` (none while still on the same tile or outside). */
export function paintStep(stroke: PaintStroke, tile: TilePoint | null): TilePoint[] {
  if (!tile || samePoint(tile, stroke.last)) return [];
  const out: TilePoint[] = [];
  if (!stroke.emitted) {
    stroke.emitted = true;
    out.push(stroke.start);
  }
  stroke.last = tile;
  out.push(tile);
  return out;
}

export const EDITOR_KEYS = ['r', 'R', 'Delete', 'Backspace', 'Escape'] as const;
export type EditorKey = (typeof EDITOR_KEYS)[number];

/** `KeyboardEvent.key` → editor shortcut, or null for every other key. */
export function editorKeyFor(key: string): EditorKey | null {
  return (EDITOR_KEYS as readonly string[]).includes(key) ? (key as EditorKey) : null;
}

export function samePoint(a: TilePoint | null, b: TilePoint | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y);
}

export const GHOST_VALID = 0x7ee787;
export const GHOST_INVALID = 0xff7b72;
export const GHOST_ALPHA = 0.55;

export function ghostTint(valid: boolean): number {
  return valid ? GHOST_VALID : GHOST_INVALID;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
