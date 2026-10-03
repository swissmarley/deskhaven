import { WorldCore } from './core/world-core.js';
import { LazyWorld } from './lazy-world.js';
import type { SceneFactory } from './scene.js';
import type { World } from './types.js';
import type { WorldExtras } from './world-extras.js';

export type RendererKind = 'pixi' | 'three';

/** `localStorage` key that overrides the build-time renderer choice (handy for A/B in the browser). */
export const RENDERER_STORAGE_KEY = 'deskhaven.renderer';
/** Key used before the rename; read as a fallback so the user's choice survives the upgrade. */
export const LEGACY_RENDERER_STORAGE_KEY = 'agenthotel.renderer';

const KINDS: readonly RendererKind[] = ['pixi', 'three'];

function isRendererKind(v: unknown): v is RendererKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/** The renderer used when neither the stored override nor `VITE_RENDERER` picks one (G3: Three). */
export const DEFAULT_RENDERER: RendererKind = 'three';

/**
 * Which renderer to load: the stored override when valid, else the build-time `VITE_RENDERER`
 * when valid, else `DEFAULT_RENDERER`. Pure so it can be tested without a browser.
 */
export function resolveRendererKind(
  stored: string | null | undefined,
  env: string | undefined,
): RendererKind {
  if (isRendererKind(stored)) return stored;
  if (isRendererKind(env)) return env;
  return DEFAULT_RENDERER;
}

export function rendererKind(): RendererKind {
  let stored: string | null | undefined;
  try {
    stored =
      globalThis.localStorage?.getItem(RENDERER_STORAGE_KEY) ??
      globalThis.localStorage?.getItem(LEGACY_RENDERER_STORAGE_KEY);
  } catch {
    stored = undefined;
  }
  return resolveRendererKind(stored, import.meta.env?.VITE_RENDERER);
}

/**
 * The scene backend for a renderer, loaded on demand. Dynamic imports keep Three out of the Pixi
 * bundle and vice versa; neither backend module is evaluated until `mount()`.
 */
export function sceneFactory(kind: RendererKind): SceneFactory {
  if (kind === 'three') return () => import('./three/scene.js').then((m) => m.createThreeScene());
  return () => import('./pixi/scene.js').then((m) => m.createPixiScene());
}

/** One simulation (`WorldCore`) over the chosen backend. */
export function worldFactory(kind: RendererKind): () => Promise<World & WorldExtras> {
  return () => Promise.resolve(new WorldCore(sceneFactory(kind)));
}

/** The world the UI mounts. Calls made before the renderer has loaded are queued and replayed. */
export function createWorld(kind: RendererKind = rendererKind()): World & WorldExtras {
  return new LazyWorld(worldFactory(kind));
}
