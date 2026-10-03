import type { FurnitureKind } from '@deskhaven/shared';

/**
 * Asset manifest. Every drawable thing has an entry; `placeholder` means "draw coloured iso boxes",
 * `generated` means "paint a procedural pixel-art sheet at runtime" (avatars, see `../sprites.ts`),
 * `sheet` means "load this sprite sheet and play its frames". The painters in `./index.ts` are the
 * seam where each implementation plugs in without touching `world.ts`.
 */
export interface SheetFrames {
  frameWidth: number;
  frameHeight: number;
  /** Animation name (pose) → frame indices, row-major in the sheet. */
  animations: Record<string, number[]>;
  /** Row offset per facing for 4-direction sheets (0 N, 1 E, 2 S, 3 W). */
  facingRows?: Record<0 | 1 | 2 | 3, number>;
}

export type AssetEntry =
  | { kind: 'placeholder'; url?: undefined; frames?: undefined }
  | { kind: 'generated'; url?: undefined; frames?: undefined }
  | { kind: 'sheet'; url: string; frames: SheetFrames };

export type AssetKey = 'avatar' | 'floor' | 'wall' | `furniture:${FurnitureKind}`;

export const ASSET_MANIFEST: Record<AssetKey, AssetEntry> = {
  avatar: { kind: 'generated' },
  floor: { kind: 'placeholder' },
  wall: { kind: 'placeholder' },
  'furniture:desk': { kind: 'placeholder' },
  'furniture:chair': { kind: 'placeholder' },
  'furniture:bookshelf': { kind: 'placeholder' },
  'furniture:server_rack': { kind: 'placeholder' },
  'furniture:coffee_machine': { kind: 'placeholder' },
  'furniture:sofa': { kind: 'placeholder' },
  'furniture:plant': { kind: 'placeholder' },
  'furniture:whiteboard': { kind: 'placeholder' },
  'furniture:library_pc': { kind: 'placeholder' },
  'furniture:door': { kind: 'placeholder' },
  'furniture:rug': { kind: 'placeholder' },
};

export function furnitureAssetKey(kind: FurnitureKind): AssetKey {
  return `furniture:${kind}`;
}

export function assetEntry(key: AssetKey): AssetEntry {
  return ASSET_MANIFEST[key];
}
