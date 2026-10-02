import type { Avatar } from '@agenthotel/shared';
import { Rectangle, Texture } from 'pixi.js';
import { generateAvatarSheet, SHEET_SCALE } from '../sprites.js';

/** Pixi textures for one avatar's procedural sheet (all facings × pose frames share one source). */
export interface AvatarSheetTextures {
  /** `frameKey(pose, facing, index)` → sub-texture of the sheet. */
  frames: Readonly<Record<string, Texture>>;
  /** Frame size in sheet pixels. */
  frameW: number;
  frameH: number;
  scale: number;
}

const cache = new Map<string, AvatarSheetTextures>();

/** Cache key: the avatar's visual fields in a fixed order, plus the scale. */
export function avatarSheetKey(a: Avatar, scale: number): string {
  return JSON.stringify([a.skin, a.hair, a.hairStyle, a.shirt, a.pants, a.accessory, scale]);
}

/**
 * Generate (once per distinct avatar + scale) the pixel-art sheet and wrap each frame in a
 * `Texture` sharing the sheet's `TextureSource` with nearest-neighbour sampling.
 */
export function avatarSheetTextures(
  avatar: Avatar,
  scale: number = SHEET_SCALE,
): AvatarSheetTextures {
  const key = avatarSheetKey(avatar, scale);
  const hit = cache.get(key);
  if (hit) return hit;
  const sheet = generateAvatarSheet(avatar, { scale });
  const base = Texture.from(sheet.canvas);
  base.source.scaleMode = 'nearest';
  base.source.label = `avatar-sheet:${key}`;
  const frames: Record<string, Texture> = {};
  for (const [k, r] of Object.entries(sheet.frames)) {
    frames[k] = new Texture({
      source: base.source,
      frame: new Rectangle(r.x, r.y, r.w, r.h),
      label: k,
    });
  }
  const out: AvatarSheetTextures = {
    frames,
    frameW: sheet.frameW,
    frameH: sheet.frameH,
    scale: sheet.scale,
  };
  cache.set(key, out);
  return out;
}

/** Number of cached sheets (diagnostics / tests). */
export function avatarSheetCacheSize(): number {
  return cache.size;
}

/** Drop every cached sheet and free its GPU resources. Only safe when no sprite still uses them. */
export function clearAvatarSheetCache(): void {
  for (const sheet of cache.values()) {
    const first = Object.values(sheet.frames)[0];
    for (const tex of Object.values(sheet.frames)) tex.destroy(false);
    first?.source.destroy();
  }
  cache.clear();
}
