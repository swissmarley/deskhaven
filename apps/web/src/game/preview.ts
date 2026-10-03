import type { Avatar } from '@deskhaven/shared';
import type { PreviewOptions } from './three/preview-math.js';

export type { PreviewOptions } from './three/preview-math.js';

/**
 * Lazy entry point for the offscreen 3D avatar preview (`three/preview.ts`). The Three chunk is
 * only fetched on the first call, so importing this module (or `game/index.ts`) never pulls
 * three.js into the entry bundle. Resolves null whenever 3D previews are unavailable (no WebGL,
 * model missing, chunk failed to load): the UI then keeps the pixel preview from `sprites.ts`.
 *
 * Usage from the UI:
 *   const url = await renderAvatarPreview3d(avatar);          // 96 × 96 PNG data URL | null
 *   const url = await renderAvatarPreview3d(avatar, { size: 144, intern: true });
 */
export async function renderAvatarPreview3d(
  avatar: Avatar,
  opts?: PreviewOptions,
): Promise<string | null> {
  try {
    const mod = await import('./three/preview.js');
    return await mod.renderAvatarPreview3d(avatar, opts);
  } catch (err) {
    console.warn('[game] 3D avatar preview unavailable', err);
    return null;
  }
}

/** Release the shared preview renderer (if it was ever created) and its cache. */
export async function disposePreviewRenderer(): Promise<void> {
  try {
    const mod = await import('./three/preview.js');
    mod.disposePreviewRenderer();
  } catch {
    // The chunk never loaded: nothing to release.
  }
}
