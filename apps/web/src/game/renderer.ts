import { LazyWorld } from './lazy-world.js';
import type { World } from './types.js';
import type { WorldExtras } from './world-extras.js';

export type RendererKind = 'pixi' | 'three';

/** `localStorage` key that overrides the build-time renderer choice (handy for A/B in the browser). */
export const RENDERER_STORAGE_KEY = 'agenthotel.renderer';

const KINDS: readonly RendererKind[] = ['pixi', 'three'];

function isRendererKind(v: unknown): v is RendererKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v);
}

/**
 * Which renderer to load: the stored override when valid, else the build-time `VITE_RENDERER`
 * when valid, else Pixi. Pure so it can be tested without a browser.
 */
export function resolveRendererKind(
  stored: string | null | undefined,
  env: string | undefined,
): RendererKind {
  if (isRendererKind(stored)) return stored;
  if (isRendererKind(env)) return env;
  return 'pixi';
}

export function rendererKind(): RendererKind {
  let stored: string | null | undefined;
  try {
    stored = globalThis.localStorage?.getItem(RENDERER_STORAGE_KEY);
  } catch {
    stored = undefined;
  }
  return resolveRendererKind(stored, import.meta.env?.VITE_RENDERER);
}

/**
 * Loads a renderer on demand. Dynamic imports keep Three out of the Pixi bundle and vice versa;
 * neither renderer module is evaluated until `mount()`.
 */
export function worldFactory(kind: RendererKind): () => Promise<World & WorldExtras> {
  if (kind === 'three') return () => import('./three/world.js').then((m) => m.createThreeWorld());
  return () => import('./world.js').then((m) => m.createPixiWorld());
}

/** The world the UI mounts. Calls made before the renderer has loaded are queued and replayed. */
export function createWorld(kind: RendererKind = rendererKind()): World & WorldExtras {
  return new LazyWorld(worldFactory(kind));
}
