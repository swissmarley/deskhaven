import type { Avatar, Facing } from '@agenthotel/shared';

/**
 * Pure helpers for the offscreen 3D avatar preview (`three/preview.ts`): the cache key, the LRU
 * cache and the orthographic framing of a posed character's bounding box. No three.js here so it
 * runs under Node.
 */

/** Default edge of the square preview in CSS pixels. */
export const PREVIEW_SIZE = 96;
/** Default facing: south (towards the camera), see `PREVIEW_TURN_RAD`. */
export const PREVIEW_FACING: Facing = 2;
/** Extra turn so a facing-2 character shows a three-quarter view instead of a flat front. */
export const PREVIEW_TURN_RAD = (30 * Math.PI) / 180;
/** Camera elevation above the horizontal. */
export const PREVIEW_ELEVATION_RAD = (12 * Math.PI) / 180;
/** Margin around the body as a fraction of the framed extent (each side). */
export const PREVIEW_MARGIN = 0.06;
/** Previews kept in memory (data URLs of ~96² PNGs are a few kB each). */
export const PREVIEW_CACHE_MAX = 64;
/** Fallback framing height (world units) when the posed bounds cannot be measured. */
export const PREVIEW_FALLBACK_HEIGHT = 1.45;

export interface PreviewOptions {
  /** Edge of the square output in pixels (default `PREVIEW_SIZE`). */
  size?: number;
  /** Which way the character faces (default `PREVIEW_FACING`, towards the camera). */
  facing?: Facing;
  /** Intern look: smaller and washed out (default false). */
  intern?: boolean;
}

/** Normalised options with defaults applied. */
export function previewOptions(opts: PreviewOptions | undefined): Required<PreviewOptions> {
  const size = Math.max(8, Math.min(1024, Math.round(opts?.size ?? PREVIEW_SIZE)));
  return { size, facing: opts?.facing ?? PREVIEW_FACING, intern: opts?.intern ?? false };
}

/** Cache key: the whole avatar DTO plus every option that changes the pixels. */
export function previewKey(avatar: Avatar, opts: Required<PreviewOptions>): string {
  return `${JSON.stringify(avatar)}|${opts.size}|${opts.facing}|${opts.intern ? 'i' : 'a'}`;
}

/** Small insertion-ordered LRU: `get` refreshes, `set` evicts the least recently used past `max`. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  /** Keys from least to most recently used (tests). */
  keys(): K[] {
    return [...this.map.keys()];
  }
}

export interface Bounds3 {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface Framing {
  /** Point the camera looks at. */
  centre: { x: number; y: number; z: number };
  /** Half-size of the square orthographic frustum. */
  halfExtent: number;
}

/**
 * Square orthographic framing of a bounding box: centred on the box, the half-extent covering the
 * largest dimension (height for a standing character) plus the margin. Degenerate or non-finite
 * boxes frame a `PREVIEW_FALLBACK_HEIGHT`-tall body standing on the origin instead.
 */
export function frameFor(box: Bounds3 | null, margin = PREVIEW_MARGIN): Framing {
  if (!box || !isFiniteBox(box) || box.maxY - box.minY <= 0.01) {
    const h = PREVIEW_FALLBACK_HEIGHT;
    return { centre: { x: 0, y: h / 2, z: 0 }, halfExtent: (h / 2) * (1 + 2 * margin) };
  }
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  const d = box.maxZ - box.minZ;
  // The view is turned about Y, so the on-screen width is at most the XZ diagonal.
  const extent = Math.max(h, Math.hypot(w, d));
  return {
    centre: {
      x: (box.minX + box.maxX) / 2,
      y: (box.minY + box.maxY) / 2,
      z: (box.minZ + box.maxZ) / 2,
    },
    halfExtent: (extent / 2) * (1 + 2 * margin),
  };
}

function isFiniteBox(b: Bounds3): boolean {
  return [b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ].every((v) => Number.isFinite(v));
}

/** Unit direction from the framing centre towards the preview camera (in front, slightly above). */
export function previewViewDirection(elevation = PREVIEW_ELEVATION_RAD): {
  x: number;
  y: number;
  z: number;
} {
  return { x: 0, y: Math.sin(elevation), z: Math.cos(elevation) };
}
