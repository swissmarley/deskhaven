import { DirectionalLight, HemisphereLight, type Object3D, Vector3 } from 'three';

/** Lighting tunables. */
export const HEMI_SKY = 0xdfe8f5;
export const HEMI_GROUND = 0x6b6f78;
export const HEMI_INTENSITY = 0.55;
export const SUN_COLOR = 0xffffff;
export const SUN_INTENSITY = 1.6;
/** Direction from the room centre towards the sun (up-left-front), normalised on use. */
export const SUN_DIR = new Vector3(-0.6, 1.0, 0.35).normalize();
export const SUN_DISTANCE = 20;
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_BIAS = -0.0005;
export const SHADOW_NORMAL_BIAS = 0.02;
export const SHADOW_RADIUS = 4;
export const SHADOW_NEAR = 0.1;
export const SHADOW_FAR = 60;

export interface Lights {
  readonly hemi: HemisphereLight;
  readonly sun: DirectionalLight;
  /** Re-aim the sun and refit its shadow frustum to a room of this size (tiles). */
  fit(width: number, height: number): void;
  dispose(): void;
}

export function createLights(parent: Object3D): Lights {
  const hemi = new HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY);
  const sun = new DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  sun.shadow.bias = SHADOW_BIAS;
  sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
  sun.shadow.radius = SHADOW_RADIUS;
  sun.shadow.camera.near = SHADOW_NEAR;
  sun.shadow.camera.far = SHADOW_FAR;
  parent.add(hemi, sun, sun.target);

  return {
    hemi,
    sun,
    fit(width, height) {
      const cx = (width - 1) / 2;
      const cz = (height - 1) / 2;
      sun.target.position.set(cx, 0, cz);
      sun.position.set(cx, 0, cz).addScaledVector(SUN_DIR, SUN_DISTANCE);
      const extent = width + height;
      const cam = sun.shadow.camera;
      cam.left = -extent;
      cam.right = extent;
      cam.top = extent;
      cam.bottom = -extent;
      cam.updateProjectionMatrix();
      sun.target.updateMatrixWorld();
    },
    dispose() {
      parent.remove(hemi, sun, sun.target);
      sun.dispose();
      hemi.dispose();
    },
  };
}
