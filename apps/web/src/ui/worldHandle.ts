import type { World } from '../game/types.js';

/** The mounted Pixi world, for UI code that needs hit-testing (drag-and-drop onto avatars). */
let current: World | null = null;

export function setWorldHandle(world: World | null): void {
  current = world;
}

export function getWorldHandle(): World | null {
  return current;
}
