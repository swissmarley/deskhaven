import type { Avatar, Facing, FurnitureKind } from '@deskhaven/shared';
import type { Graphics } from 'pixi.js';
import type { AvatarSheetTextures } from './generated.js';
import { ASSET_MANIFEST, type AssetKey } from './manifest.js';

/** Resolved avatar colours (already parsed from the DTO's hex strings). `hair` null = bald. */
export interface AvatarPalette {
  skin: number;
  hair: number | null;
  shirt: number;
  pants: number;
}

export interface PrismShape {
  /** Flat polygon (local coordinates) usable as a hit area. */
  outline: number[];
  /** Where to centre the label. */
  labelX: number;
  labelY: number;
}

/**
 * The rendering seam. `room.ts` and `avatar.ts` draw through these functions; swapping the
 * manifest entries to `sheet` will route to texture-backed painters without changing `world.ts`.
 */
export interface Painters {
  floorTile(g: Graphics, x: number, y: number, style: number): void;
  wallSegment(g: Graphics, side: 'north' | 'west', index: number, style: number): void;
  /** Draws a placed piece with its origin tile at the local origin; returns label/hit geometry. */
  furniture(g: Graphics, kind: FurnitureKind, rotation: number): PrismShape;
  /** Draws the placeholder body with the feet at the local origin. */
  avatarBody(g: Graphics, palette: AvatarPalette, facing: Facing, intern: boolean): void;
  /**
   * Present when `ASSET_MANIFEST.avatar.kind === 'generated'`: the cached procedural sprite sheet
   * for an avatar. `AvatarSprite` then shows texture frames instead of calling `avatarBody`.
   */
  avatarSheet?: (avatar: Avatar) => AvatarSheetTextures;
}

export type RenderMode = 'placeholder' | 'sheet' | 'generated';

export function renderModeFor(key: AssetKey): RenderMode {
  return ASSET_MANIFEST[key].kind;
}

/**
 * Pick the painter set for the current manifest. Placeholders draw everything; a `generated`
 * avatar entry adds the procedural sheet provider. A manifest that asks for file-backed sheets
 * fails loudly here rather than drawing nothing.
 */
export async function loadPainters(): Promise<Painters> {
  const sheetKeys = (Object.keys(ASSET_MANIFEST) as AssetKey[]).filter(
    (k) => ASSET_MANIFEST[k].kind === 'sheet',
  );
  if (sheetKeys.length > 0) {
    throw new Error(
      `Sprite-sheet rendering is not implemented yet (manifest entries: ${sheetKeys.join(', ')})`,
    );
  }
  const { placeholderPainters } = await import('./placeholder.js');
  if (ASSET_MANIFEST.avatar.kind !== 'generated') return placeholderPainters;
  const { avatarSheetTextures } = await import('./generated.js');
  return { ...placeholderPainters, avatarSheet: (avatar) => avatarSheetTextures(avatar) };
}

export type { AvatarSheetTextures } from './generated.js';
export type { AssetEntry, AssetKey, SheetFrames } from './manifest.js';
export { ASSET_MANIFEST, assetEntry, furnitureAssetKey } from './manifest.js';
