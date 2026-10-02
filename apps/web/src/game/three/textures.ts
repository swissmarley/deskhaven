import { CanvasTexture, NearestFilter, RepeatWrapping, SRGBColorSpace, type Texture } from 'three';
import { FLOOR_STYLE_COUNT, floorStyleColors } from '../styles.js';

/**
 * Procedural floor and wall textures drawn on a 2D canvas once per style. Everything is created
 * lazily (never at import time) because a canvas does not exist under Node.
 */

/** Texture resolution per tile; `NearestFilter` keeps the pixel-art feel at any zoom. */
export const TEXTURE_SIZE = 64;
/** Brick texture resolution; it repeats along a wall segment. */
export const BRICK_TEXTURE_SIZE = 64;

const floorCache = new Map<number, Texture>();
let brickCache: Texture | null = null;

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  return [canvas, ctx];
}

function hex(c: number): string {
  return `#${c.toString(16).padStart(6, '0')}`;
}

function shade(c: number, f: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((c >> 16) & 0xff) * f)));
  const g = Math.min(255, Math.max(0, Math.round(((c >> 8) & 0xff) * f)));
  const b = Math.min(255, Math.max(0, Math.round((c & 0xff) * f)));
  return (r << 16) | (g << 8) | b;
}

/** Tiny deterministic noise so each style has stable speckles. */
function noise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

function finish(canvas: HTMLCanvasElement): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = NearestFilter;
  tex.minFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

function paintFloor(ctx: CanvasRenderingContext2D, style: number): void {
  const [light, dark] = floorStyleColors(style);
  const S = TEXTURE_SIZE;
  ctx.fillStyle = hex(light);
  ctx.fillRect(0, 0, S, S);
  switch (style) {
    case 1: {
      // Rug: warm woven weave with a darker border.
      for (let y = 0; y < S; y += 4)
        for (let x = 0; x < S; x += 4) {
          const alt = ((x + y) / 4) % 2 === 0;
          ctx.fillStyle = hex(alt ? dark : shade(light, 1.04));
          ctx.fillRect(x, y, 4, 4);
        }
      ctx.fillStyle = hex(shade(dark, 0.85));
      ctx.fillRect(0, 0, S, 3);
      ctx.fillRect(0, S - 3, S, 3);
      ctx.fillRect(0, 0, 3, S);
      ctx.fillRect(S - 3, 0, 3, S);
      break;
    }
    case 2: {
      // Dark tile: subtle speckle and a grout line.
      for (let y = 0; y < S; y += 2)
        for (let x = 0; x < S; x += 2) {
          const n = noise(x, y, 2);
          if (n > 0.8) {
            ctx.fillStyle = hex(shade(light, 1.08));
            ctx.fillRect(x, y, 2, 2);
          }
        }
      ctx.fillStyle = hex(shade(dark, 0.8));
      ctx.fillRect(0, 0, S, 2);
      ctx.fillRect(0, 0, 2, S);
      break;
    }
    case 3: {
      // Wood: planks along x with staggered joints and grain lines.
      const plank = S / 4;
      for (let p = 0; p < 4; p++) {
        const y0 = p * plank;
        ctx.fillStyle = hex(shade(light, 0.96 + 0.04 * (p % 2)));
        ctx.fillRect(0, y0, S, plank);
        ctx.fillStyle = hex(shade(dark, 0.92));
        ctx.fillRect(0, y0, S, 1);
        for (let g = 0; g < 3; g++) {
          const gy = y0 + 3 + Math.floor(noise(p, g, 3) * (plank - 5));
          ctx.fillStyle = hex(shade(dark, 0.97));
          ctx.fillRect(0, gy, S, 1);
        }
        const jx = Math.floor(noise(p, 7, 3) * S);
        ctx.fillStyle = hex(shade(dark, 0.85));
        ctx.fillRect(jx, y0, 1, plank);
      }
      break;
    }
    case 4: {
      // Grass: blotches of two greens plus a few blade highlights.
      for (let y = 0; y < S; y += 2)
        for (let x = 0; x < S; x += 2) {
          const n = noise(x, y, 4);
          ctx.fillStyle = hex(n > 0.55 ? dark : n < 0.08 ? shade(light, 1.12) : light);
          ctx.fillRect(x, y, 2, 2);
        }
      break;
    }
    default: {
      // Tile: 2×2 light checker with a thin grout.
      const half = S / 2;
      ctx.fillStyle = hex(dark);
      ctx.fillRect(half, 0, half, half);
      ctx.fillRect(0, half, half, half);
      ctx.fillStyle = hex(shade(dark, 0.9));
      ctx.fillRect(0, 0, S, 1);
      ctx.fillRect(0, 0, 1, S);
      ctx.fillRect(half, 0, 1, S);
      ctx.fillRect(0, half, S, 1);
      break;
    }
  }
}

/** Texture for a floor style id (unknown ids fall back to style 0). Cached for the page lifetime. */
export function floorTexture(style: number): Texture {
  const id = style >= 0 && style < FLOOR_STYLE_COUNT ? style : 0;
  const cached = floorCache.get(id);
  if (cached) return cached;
  const [canvas, ctx] = makeCanvas(TEXTURE_SIZE);
  paintFloor(ctx, id);
  const tex = finish(canvas);
  floorCache.set(id, tex);
  return tex;
}

/** Greyscale brick pattern, tinted by the material colour (so both wall faces share one texture). */
export function brickTexture(): Texture {
  if (brickCache) return brickCache;
  const S = BRICK_TEXTURE_SIZE;
  const [canvas, ctx] = makeCanvas(S);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);
  const rowH = S / 4;
  const brickW = S / 2;
  for (let r = 0; r < 4; r++) {
    const y0 = r * rowH;
    const offset = r % 2 === 0 ? 0 : brickW / 2;
    for (let i = -1; i < 3; i++) {
      const x0 = i * brickW + offset;
      const tone = 0.9 + 0.1 * noise(i, r, 11);
      const v = Math.round(255 * tone);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.fillRect(x0 + 1, y0 + 1, brickW - 2, rowH - 2);
    }
    // Mortar lines.
    ctx.fillStyle = '#b8b8b8';
    ctx.fillRect(0, y0, S, 1);
    for (let i = -1; i < 3; i++) ctx.fillRect(i * brickW + offset, y0, 1, rowH);
  }
  brickCache = finish(canvas);
  return brickCache;
}

/** Dispose every cached texture (on world destroy, so a re-mount regenerates them). */
export function disposeTextures(): void {
  for (const t of floorCache.values()) t.dispose();
  floorCache.clear();
  brickCache?.dispose();
  brickCache = null;
}
