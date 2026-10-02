import {
  type Facing,
  FURNITURE_CATALOG,
  type FurnitureKind,
  rotatedSize,
} from '@agenthotel/shared';
import type { Graphics } from 'pixi.js';
import { shade } from '../color.js';
import {
  FACING_DIR,
  HALF_H,
  HALF_W,
  isoRectPoints,
  tileDiamond,
  tileToScreen,
  WALL_H,
} from '../iso.js';
import { floorStyleColors, wallStyleColor } from '../styles.js';
import type { AvatarPalette, Painters, PrismShape } from './index.js';

/**
 * Draws an isometric prism whose base is the parallelogram `base` (N, E, S, W screen points) and
 * which rises `height` px. Faces: top (lightest), left/south-west (base), right/south-east (dark).
 */
export function drawPrism(g: Graphics, base: number[], height: number, color: number): void {
  const [nx = 0, ny = 0, ex = 0, ey = 0, sx = 0, sy = 0, wx = 0, wy = 0] = base;
  // South-west face: W → S, extruded up.
  g.poly([wx, wy, sx, sy, sx, sy - height, wx, wy - height]).fill(shade(color, 0.82));
  // South-east face: S → E, extruded up.
  g.poly([sx, sy, ex, ey, ex, ey - height, sx, sy - height]).fill(shade(color, 0.62));
  // Top face.
  g.poly([nx, ny - height, ex, ey - height, sx, sy - height, wx, wy - height]).fill(
    shade(color, 1.12),
  );
}

/** Hexagonal silhouette of a prism (for hit areas): W, S, E, E−h, N−h, W−h. */
export function prismOutline(base: number[], height: number): number[] {
  const [nx = 0, ny = 0, ex = 0, ey = 0, sx = 0, sy = 0, wx = 0, wy = 0] = base;
  return [wx, wy, sx, sy, ex, ey, ex, ey - height, nx, ny - height, wx, wy - height];
}

/** Soft elliptical shadow under a base parallelogram. */
export function drawShadow(g: Graphics, base: number[], grow = 1.15): void {
  const [, ny = 0, ex = 0, , , sy = 0, wx = 0] = base;
  const cx = (wx + ex) / 2;
  const cy = (ny + sy) / 2;
  g.ellipse(cx + 2, cy + 2, ((ex - wx) / 2) * grow, ((sy - ny) / 2) * grow).fill({
    color: 0x000000,
    alpha: 0.22,
  });
}

export const placeholderPainters: Painters = {
  floorTile(g, x, y, style) {
    const pair = floorStyleColors(style);
    g.poly(tileDiamond(x, y)).fill(pair[(x + y) % 2]);
  },

  wallSegment(g, side, i, style) {
    // Each wall quad stands on one edge of a border tile: the north wall on the top-right edge of
    // tile (i, 0), the west wall on the top-left edge of tile (0, i). See `iso.ts` header.
    const c = side === 'north' ? tileToScreen(i, 0) : tileToScreen(0, i);
    const ax = c.sx;
    const ay = c.sy - HALF_H;
    const bx = side === 'north' ? c.sx + HALF_W : c.sx - HALF_W;
    const by = c.sy;
    const color = wallStyleColor(side, style);
    g.poly([ax, ay, bx, by, bx, by - WALL_H, ax, ay - WALL_H]).fill(color);
    // Skirting board.
    g.poly([ax, ay, bx, by, bx, by - 6, ax, ay - 6]).fill(shade(color, 0.7));
  },

  furniture(g, kind: FurnitureKind, rotation): PrismShape {
    const spec = FURNITURE_CATALOG[kind];
    const { w, h } = rotatedSize(kind, rotation);
    // Inset the footprint slightly so adjacent pieces read as separate boxes. Origin tile is (0,0);
    // the sprite is positioned at the piece's origin tile by the caller.
    const inset = 0.06;
    const base = isoRectPoints(-0.5 + inset, -0.5 + inset, w - 0.5 - inset, h - 0.5 - inset);
    drawShadow(g, base);
    drawPrism(g, base, spec.height, spec.color);
    const [, ny = 0, ex = 0, , , sy = 0, wx = 0] = base;
    return {
      outline: prismOutline(base, spec.height),
      labelX: (wx + ex) / 2,
      labelY: (ny + sy) / 2 - spec.height,
    };
  },

  avatarBody(g, palette: AvatarPalette, facing: Facing, intern: boolean) {
    // Footprint 24×24 world px of a 64-px tile → 0.375 tiles; head is 16×16.
    const half = 0.1875;
    const headHalf = 0.125;
    const legs = isoRectPoints(-half, -half, half, half);
    drawShadow(g, legs, 1.3);
    drawPrism(g, legs, 16, palette.pants);
    const torso = legs.map((v, i) => (i % 2 === 1 ? v - 16 : v));
    drawPrism(g, torso, 18, palette.shirt);
    const head = isoRectPoints(-headHalf, -headHalf, headHalf, headHalf).map((v, i) =>
      i % 2 === 1 ? v - 34 : v,
    );
    drawPrism(g, head, 10, palette.skin);
    if (palette.hair !== null) {
      // Hair: a thin slab on top of the head.
      const hair = head.map((v, i) => (i % 2 === 1 ? v - 10 : v));
      drawPrism(g, hair, 3, palette.hair);
    }
    // Facing marker: a small triangle on the head top pointing the way the avatar looks.
    const dir = FACING_DIR[facing] ?? FACING_DIR[2] ?? [0, 1];
    const topY = -47;
    const tipX = dir[0] * 9;
    const tipY = topY + dir[1] * 5;
    const px = -dir[1];
    const py = dir[0] * 0.5;
    g.poly([tipX, tipY, px * 3, topY + py * 3, -px * 3, topY - py * 3]).fill(0xfff3b0);
    if (intern) {
      // Dashed diamond around the feet marks temporary intern avatars.
      const d = tileDiamond(0, 0).map((v) => v * 0.55);
      for (let e = 0; e < 4; e++) {
        const x0 = d[e * 2] ?? 0;
        const y0 = d[e * 2 + 1] ?? 0;
        const x1 = d[((e + 1) % 4) * 2] ?? 0;
        const y1 = d[((e + 1) % 4) * 2 + 1] ?? 0;
        for (let k = 0; k < 4; k += 2) {
          const t0 = k / 4;
          const t1 = (k + 1) / 4;
          g.moveTo(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
            .lineTo(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
            .stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
        }
      }
    }
  },
};
