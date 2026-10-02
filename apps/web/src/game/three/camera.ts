import { OrthographicCamera, Vector3 } from 'three';
import type { CameraView } from '../camera.js';
import { screenToTileF, TILE_W } from '../iso.js';

/**
 * Orthographic camera that reproduces the 64×32 isometric projection of `iso.ts` exactly.
 *
 * World mapping: tile (x, y) → world (x, 0, y), up = +Y. A 64×32 diamond is an orthographic view
 * at yaw 45° and elevation 30° (sin 30° = 0.5 gives the 2:1 ratio) with 64/√2 ≈ 45.25 px per world
 * unit at zoom 1; heights project at cos 30° × 45.25 ≈ 39.19 px per unit.
 *
 * Sign convention: the eye sits on the +x +z side of the room (direction `VIEW_DIR`), looking
 * towards −x −z. The camera's right vector is then (1, 0, −1)/√2, so +x tiles move down-right on
 * screen and +y (world +z) tiles move down-left, exactly like `tileToScreen`.
 *
 * The frustum is shifted so that canvas pixel = world-screen px × zoom + (x, y), with world-screen
 * px of the ground point (tx, 0, ty) equal to `tileToScreen(tx, ty)`. Pan therefore moves the
 * frustum, never the camera.
 */
export const PX_PER_UNIT = TILE_W / Math.SQRT2;
export const YAW_RAD = Math.PI / 4;
export const ELEVATION_RAD = Math.PI / 6;
/** Pixels one world unit of height projects to at zoom 1. */
export const PX_PER_HEIGHT_UNIT = Math.cos(ELEVATION_RAD) * PX_PER_UNIT;
/** Unit vector from the look target towards the eye. */
export const VIEW_DIR = new Vector3(
  Math.cos(ELEVATION_RAD) * Math.cos(YAW_RAD),
  Math.sin(ELEVATION_RAD),
  Math.cos(ELEVATION_RAD) * Math.sin(YAW_RAD),
);
/** Distance of the eye from the origin along `VIEW_DIR`; irrelevant for the projection. */
const EYE_DIST = 100;
/** Depth range around the eye, generous enough for any room (−NEAR … FAR along the view axis). */
const NEAR = -200;
const FAR = 400;

export interface CanvasPoint {
  sx: number;
  sy: number;
}

export class IsoCamera implements CameraView {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, NEAR, FAR);
  private zoom = 1;
  private offsetX = 0;
  private offsetY = 0;
  private width = 1;
  private height = 1;
  private readonly tmp = new Vector3();

  constructor() {
    this.camera.up.set(0, 1, 0);
    this.camera.position.copy(VIEW_DIR).multiplyScalar(EYE_DIST);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.updateFrustum();
  }

  /** Canvas size in CSS pixels (what `setTransform` offsets are expressed in). */
  setScreen(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.updateFrustum();
  }

  setTransform(zoom: number, x: number, y: number): void {
    this.zoom = zoom;
    this.offsetX = x;
    this.offsetY = y;
    this.updateFrustum();
  }

  /** Canvas pixel of any world point. */
  project(point: { x: number; y: number; z: number }): CanvasPoint {
    const v = this.tmp.set(point.x, point.y, point.z).project(this.camera);
    return { sx: ((v.x + 1) / 2) * this.width, sy: ((1 - v.y) / 2) * this.height };
  }

  /** Fractional tile under a canvas pixel on the ground plane (y = 0). */
  unprojectGround(sx: number, sy: number): { tx: number; ty: number } {
    const t = screenToTileF((sx - this.offsetX) / this.zoom, (sy - this.offsetY) / this.zoom);
    return { tx: t.x, ty: t.y };
  }

  /**
   * Camera-space x/y are world-screen px / PX_PER_UNIT (x right, y up). With canvas px =
   * cam · PX_PER_UNIT · zoom + offset, pixel 0 corresponds to cam = −offset / (PX · zoom) and the
   * far edge to (size − offset) / (PX · zoom); y is flipped because canvas y grows downwards.
   */
  private updateFrustum(): void {
    const s = PX_PER_UNIT * this.zoom;
    const c = this.camera;
    c.left = -this.offsetX / s;
    c.right = (this.width - this.offsetX) / s;
    c.top = this.offsetY / s;
    c.bottom = (this.offsetY - this.height) / s;
    c.updateProjectionMatrix();
  }
}
