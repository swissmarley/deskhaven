import type { FurnitureKind } from './dto.js';

export type Facing = 0 | 1 | 2 | 3; // 0 = north (up-right in iso), 1 = east, 2 = south, 3 = west

export interface InteractionPoint {
  type: 'seat' | 'stand';
  /** Offset in tiles from the furniture origin at rotation 0. */
  dx: number;
  dy: number;
  /** Direction the avatar faces while using the point, at rotation 0. */
  facing: Facing;
}

export interface FurnitureSpec {
  label: string;
  /** Footprint in tiles at rotation 0 (w along x, h along y). */
  w: number;
  h: number;
  /** Whether the footprint blocks walking. */
  blocks: boolean;
  /** Logical station used by the behaviour system; null for decoration. */
  station:
    | 'desk'
    | 'bookshelf'
    | 'server_rack'
    | 'coffee_machine'
    | 'sofa'
    | 'whiteboard'
    | 'library_pc'
    | 'door'
    | null;
  interactions: InteractionPoint[];
  /** Placeholder colour (hex) until real art is loaded. */
  color: number;
  /** Placeholder height in pixels for the iso box. */
  height: number;
}

export const FURNITURE_CATALOG: Record<FurnitureKind, FurnitureSpec> = {
  desk: {
    label: 'Desk',
    w: 2,
    h: 1,
    blocks: true,
    station: 'desk',
    interactions: [{ type: 'seat', dx: 0, dy: 1, facing: 0 }],
    color: 0x9a6b3f,
    height: 22,
  },
  chair: {
    label: 'Chair',
    w: 1,
    h: 1,
    blocks: false,
    station: null,
    interactions: [{ type: 'seat', dx: 0, dy: 0, facing: 0 }],
    color: 0x4a4e69,
    height: 14,
  },
  bookshelf: {
    label: 'Bookshelf',
    w: 2,
    h: 1,
    blocks: true,
    station: 'bookshelf',
    interactions: [
      { type: 'stand', dx: 0, dy: 1, facing: 0 },
      { type: 'stand', dx: 1, dy: 1, facing: 0 },
    ],
    color: 0x6b4226,
    height: 48,
  },
  server_rack: {
    label: 'Server rack',
    w: 1,
    h: 1,
    blocks: true,
    station: 'server_rack',
    interactions: [{ type: 'stand', dx: 0, dy: 1, facing: 0 }],
    color: 0x2b2d42,
    height: 52,
  },
  coffee_machine: {
    label: 'Coffee machine',
    w: 1,
    h: 1,
    blocks: true,
    station: 'coffee_machine',
    interactions: [
      { type: 'stand', dx: 0, dy: 1, facing: 0 },
      { type: 'stand', dx: 1, dy: 0, facing: 3 },
    ],
    color: 0x8d99ae,
    height: 30,
  },
  sofa: {
    label: 'Sofa',
    w: 2,
    h: 1,
    blocks: true,
    station: 'sofa',
    interactions: [
      { type: 'seat', dx: 0, dy: 0, facing: 2 },
      { type: 'seat', dx: 1, dy: 0, facing: 2 },
    ],
    color: 0xc1121f,
    height: 18,
  },
  plant: {
    label: 'Plant',
    w: 1,
    h: 1,
    blocks: true,
    station: null,
    interactions: [],
    color: 0x2a9d8f,
    height: 34,
  },
  whiteboard: {
    label: 'Whiteboard',
    w: 2,
    h: 1,
    blocks: true,
    station: 'whiteboard',
    interactions: [
      { type: 'stand', dx: 0, dy: 1, facing: 0 },
      { type: 'stand', dx: 1, dy: 1, facing: 0 },
    ],
    color: 0xedf2f4,
    height: 44,
  },
  library_pc: {
    label: 'Library computer',
    w: 1,
    h: 1,
    blocks: true,
    station: 'library_pc',
    interactions: [{ type: 'seat', dx: 0, dy: 1, facing: 0 }],
    color: 0x3a86ff,
    height: 24,
  },
  door: {
    label: 'Door',
    w: 1,
    h: 1,
    blocks: false,
    station: 'door',
    interactions: [{ type: 'stand', dx: 0, dy: 0, facing: 2 }],
    color: 0x6c584c,
    height: 56,
  },
  rug: {
    label: 'Rug',
    w: 2,
    h: 2,
    blocks: false,
    station: null,
    interactions: [],
    color: 0xffb703,
    height: 2,
  },
};

/** Rotate a point of the footprint (rotation 0 coordinates) by 90° steps around the origin. */
export function rotateOffset(
  dx: number,
  dy: number,
  w: number,
  h: number,
  rotation: number,
): { dx: number; dy: number } {
  switch (((rotation % 4) + 4) % 4) {
    case 1:
      return { dx: h - 1 - dy, dy: dx };
    case 2:
      return { dx: w - 1 - dx, dy: h - 1 - dy };
    case 3:
      return { dx: dy, dy: w - 1 - dx };
    default:
      return { dx, dy };
  }
}

export function rotatedSize(kind: FurnitureKind, rotation: number): { w: number; h: number } {
  const spec = FURNITURE_CATALOG[kind];
  return rotation % 2 === 1 ? { w: spec.h, h: spec.w } : { w: spec.w, h: spec.h };
}

export function rotateFacing(facing: Facing, rotation: number): Facing {
  return ((((facing + rotation) % 4) + 4) % 4) as Facing;
}

/** All tiles occupied by a furniture piece. */
export function footprintTiles(
  kind: FurnitureKind,
  x: number,
  y: number,
  rotation: number,
): { x: number; y: number }[] {
  const { w, h } = rotatedSize(kind, rotation);
  const tiles: { x: number; y: number }[] = [];
  for (let dx = 0; dx < w; dx++)
    for (let dy = 0; dy < h; dy++) tiles.push({ x: x + dx, y: y + dy });
  return tiles;
}

/** Interaction points in world tiles for a placed piece. Note: a rotated footprint spans a different box. */
export function interactionTiles(
  kind: FurnitureKind,
  x: number,
  y: number,
  rotation: number,
): { x: number; y: number; type: 'seat' | 'stand'; facing: Facing }[] {
  const spec = FURNITURE_CATALOG[kind];
  return spec.interactions.map((p) => {
    // Interaction points may sit outside the footprint (e.g. dy = h). Rotate within the bounding box
    // that includes the point so the "in front of" relation is preserved.
    const boxW = Math.max(spec.w, p.dx + 1);
    const boxH = Math.max(spec.h, p.dy + 1);
    const r = rotateOffset(p.dx, p.dy, boxW, boxH, rotation);
    // Re-anchor: the footprint's own origin after rotation inside the same box.
    const o = rotateOffset(0, 0, boxW, boxH, rotation);
    const anchor = rotateOffset(0, 0, spec.w, spec.h, rotation);
    return {
      x: x + (r.dx - o.dx) + anchor.dx,
      y: y + (r.dy - o.dy) + anchor.dy,
      type: p.type,
      facing: rotateFacing(p.facing, rotation),
    };
  });
}
