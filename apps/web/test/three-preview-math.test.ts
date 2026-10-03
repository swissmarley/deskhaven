import type { Avatar } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import {
  frameFor,
  LruCache,
  PREVIEW_CACHE_MAX,
  PREVIEW_FALLBACK_HEIGHT,
  PREVIEW_MARGIN,
  PREVIEW_SIZE,
  PREVIEW_TURN_RAD,
  previewKey,
  previewOptions,
  previewViewDirection,
} from '../src/game/three/preview-math.js';

const AVATAR: Avatar = {
  skin: '#f1c27d',
  hair: '#4a2c17',
  hairStyle: 'short',
  shirt: '#3a86ff',
  pants: '#3d405b',
  accessory: 'glasses',
};

describe('previewOptions / previewKey', () => {
  it('applies the defaults and clamps the size', () => {
    expect(previewOptions(undefined)).toEqual({ size: PREVIEW_SIZE, facing: 2, intern: false });
    expect(previewOptions({ size: 2 }).size).toBe(8);
    expect(previewOptions({ size: 5000 }).size).toBe(1024);
    expect(previewOptions({ size: 143.6 }).size).toBe(144);
    expect(previewOptions({ facing: 1, intern: true })).toEqual({
      size: PREVIEW_SIZE,
      facing: 1,
      intern: true,
    });
  });

  it('keys on every avatar field and every option', () => {
    const base = previewKey(AVATAR, previewOptions(undefined));
    expect(previewKey({ ...AVATAR }, previewOptions(undefined))).toBe(base);
    const variants = [
      previewKey({ ...AVATAR, hair: '#000000' }, previewOptions(undefined)),
      previewKey({ ...AVATAR, hairStyle: 'bun' }, previewOptions(undefined)),
      previewKey({ ...AVATAR, accessory: 'none' }, previewOptions(undefined)),
      previewKey(AVATAR, previewOptions({ size: 128 })),
      previewKey(AVATAR, previewOptions({ facing: 0 })),
      previewKey(AVATAR, previewOptions({ intern: true })),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });
});

describe('LruCache', () => {
  it('evicts the least recently used entry past the cap', () => {
    const cache = new LruCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Touch `a` so `b` is now the oldest.
    expect(cache.get('a')).toBe(1);
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.has('b')).toBe(false);
    expect(cache.keys()).toEqual(['c', 'a', 'd']);
    // Re-setting an existing key refreshes it without growing.
    cache.set('c', 30);
    expect(cache.keys()).toEqual(['a', 'd', 'c']);
    expect(cache.get('c')).toBe(30);
    expect(cache.get('zzz')).toBeUndefined();
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('holds exactly the configured number of previews', () => {
    const cache = new LruCache<number, string>(PREVIEW_CACHE_MAX);
    for (let i = 0; i < PREVIEW_CACHE_MAX * 2; i++) cache.set(i, `p${i}`);
    expect(cache.size).toBe(PREVIEW_CACHE_MAX);
    expect(cache.has(PREVIEW_CACHE_MAX - 1)).toBe(false);
    expect(cache.has(PREVIEW_CACHE_MAX)).toBe(true);
  });
});

describe('frameFor', () => {
  it('centres on the box and covers the tallest dimension plus the margin', () => {
    const f = frameFor({ minX: -0.3, minY: 0, minZ: -0.2, maxX: 0.3, maxY: 1.45, maxZ: 0.2 });
    expect(f.centre).toEqual({ x: 0, y: 0.725, z: 0 });
    expect(f.halfExtent).toBeCloseTo((1.45 / 2) * (1 + 2 * PREVIEW_MARGIN), 9);
    // The whole box fits inside the square frustum.
    expect(f.halfExtent).toBeGreaterThan(0.725);
    expect(f.halfExtent).toBeGreaterThan(Math.hypot(0.6, 0.4) / 2);
  });

  it('uses the XZ diagonal when the body is wider than tall', () => {
    const f = frameFor({ minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 0.5, maxZ: 1 }, 0);
    expect(f.halfExtent).toBeCloseTo(Math.hypot(2, 2) / 2, 9);
  });

  it('falls back to a standing body for empty or broken boxes', () => {
    const fallback = frameFor(null);
    expect(fallback.centre).toEqual({ x: 0, y: PREVIEW_FALLBACK_HEIGHT / 2, z: 0 });
    expect(fallback.halfExtent).toBeCloseTo(
      (PREVIEW_FALLBACK_HEIGHT / 2) * (1 + 2 * PREVIEW_MARGIN),
      9,
    );
    const nan = { minX: 0, minY: 0, minZ: 0, maxX: Number.NaN, maxY: 1, maxZ: 0 };
    expect(frameFor(nan)).toEqual(fallback);
    const flat = { minX: 0, minY: 1, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
    expect(frameFor(flat)).toEqual(fallback);
    const inf = { minX: Number.POSITIVE_INFINITY, minY: 0, minZ: 0, maxX: 0, maxY: 1, maxZ: 0 };
    expect(frameFor(inf)).toEqual(fallback);
  });
});

describe('preview view', () => {
  it('looks from in front and slightly above, with a three-quarter turn', () => {
    const d = previewViewDirection();
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
    expect(d.z).toBeGreaterThan(0.9);
    expect(d.y).toBeGreaterThan(0);
    expect(d.y).toBeLessThan(0.5);
    expect(PREVIEW_TURN_RAD).toBeCloseTo(Math.PI / 6, 9);
  });
});
