import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { tileToScreen } from '../src/game/iso.js';
import { IsoCamera, PX_PER_HEIGHT_UNIT, PX_PER_UNIT } from '../src/game/three/camera.js';

const TILES: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [3, 2],
  [-1, 4],
];
const CASES: readonly { zoom: number; x: number; y: number; w: number; h: number }[] = [
  { zoom: 1, x: 0, y: 0, w: 800, h: 600 },
  { zoom: 1, x: 412, y: 233, w: 1000, h: 640 },
  { zoom: 2, x: -37, y: 91, w: 1280, h: 720 },
  { zoom: 2, x: 640, y: 360, w: 1280, h: 720 },
  { zoom: 0.5, x: 300, y: 200, w: 640, h: 480 },
];

/** Pixel of a world point via three's own projection (NDC → canvas done here, not in the class). */
function projectVia(cam: IsoCamera, w: number, h: number, p: Vector3): { sx: number; sy: number } {
  const v = p.clone().project(cam.camera);
  return { sx: ((v.x + 1) / 2) * w, sy: ((1 - v.y) / 2) * h };
}

describe('IsoCamera', () => {
  it('matches the 64×32 isometric projection of iso.ts for ground points', () => {
    expect(PX_PER_UNIT).toBeCloseTo(45.2548, 3);
    for (const { zoom, x, y, w, h } of CASES) {
      const cam = new IsoCamera();
      cam.setScreen(w, h);
      cam.setTransform(zoom, x, y);
      for (const [tx, ty] of TILES) {
        const want = tileToScreen(tx, ty);
        const got = projectVia(cam, w, h, new Vector3(tx, 0, ty));
        expect(Math.abs(got.sx - (want.sx * zoom + x))).toBeLessThan(0.01);
        expect(Math.abs(got.sy - (want.sy * zoom + y))).toBeLessThan(0.01);
        const own = cam.project({ x: tx, y: 0, z: ty });
        expect(Math.abs(own.sx - got.sx)).toBeLessThan(1e-6);
        expect(Math.abs(own.sy - got.sy)).toBeLessThan(1e-6);
      }
    }
  });

  it('projects height straight up at cos 30° × 45.25 px per unit', () => {
    expect(PX_PER_HEIGHT_UNIT).toBeCloseTo(39.19, 2);
    for (const { zoom, x, y, w, h } of CASES) {
      const cam = new IsoCamera();
      cam.setScreen(w, h);
      cam.setTransform(zoom, x, y);
      for (const [tx, ty] of TILES) {
        const ground = projectVia(cam, w, h, new Vector3(tx, 0, ty));
        const raised = projectVia(cam, w, h, new Vector3(tx, 1, ty));
        expect(Math.abs(raised.sx - ground.sx)).toBeLessThan(0.01);
        expect(Math.abs(ground.sy - raised.sy - PX_PER_HEIGHT_UNIT * zoom)).toBeLessThan(0.01);
      }
    }
  });

  it('unprojectGround inverts project on the ground plane', () => {
    for (const { zoom, x, y, w, h } of CASES) {
      const cam = new IsoCamera();
      cam.setScreen(w, h);
      cam.setTransform(zoom, x, y);
      for (const [tx, ty] of [...TILES, [2.25, 0.75], [-0.5, 3.5]] as const) {
        const px = cam.project({ x: tx, y: 0, z: ty });
        const back = cam.unprojectGround(px.sx, px.sy);
        expect(back.tx).toBeCloseTo(tx, 6);
        expect(back.ty).toBeCloseTo(ty, 6);
      }
    }
  });

  it('moves +x tiles down-right and +y tiles down-left, with +Y up', () => {
    const cam = new IsoCamera();
    cam.setScreen(800, 600);
    cam.setTransform(1, 400, 300);
    const o = cam.project({ x: 0, y: 0, z: 0 });
    const px = cam.project({ x: 1, y: 0, z: 0 });
    const py = cam.project({ x: 0, y: 0, z: 1 });
    const up = cam.project({ x: 0, y: 1, z: 0 });
    expect(px.sx).toBeGreaterThan(o.sx);
    expect(px.sy).toBeGreaterThan(o.sy);
    expect(py.sx).toBeLessThan(o.sx);
    expect(py.sy).toBeGreaterThan(o.sy);
    expect(up.sy).toBeLessThan(o.sy);
  });
});
