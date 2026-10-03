import type { Facing } from '@agenthotel/shared';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { internTint } from '../src/game/color.js';
import { FACING_DIR } from '../src/game/iso.js';
import { IsoCamera } from '../src/game/three/camera.js';
import { canvasToNdc, facingDirection, facingYaw, yawDelta } from '../src/game/three/math.js';

const GROUND = new Plane(new Vector3(0, 1, 0), 0);
const SCREENS = [
  { zoom: 1, x: 0, y: 0, w: 800, h: 600 },
  { zoom: 2, x: -37, y: 91, w: 1280, h: 720 },
  { zoom: 0.5, x: 300, y: 200, w: 640, h: 480 },
];
const POINTS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [3, 0, 2],
  [1.25, 0, 4.5],
  [-1, 0, 0.5],
  [6, 0, 6],
];

describe('canvasToNdc', () => {
  it('maps the canvas corners to the NDC corners', () => {
    expect(canvasToNdc(0, 0, 800, 600)).toEqual({ x: -1, y: 1 });
    expect(canvasToNdc(800, 600, 800, 600)).toEqual({ x: 1, y: -1 });
    expect(canvasToNdc(400, 300, 800, 600)).toEqual({ x: 0, y: 0 });
  });

  it('round-trips a projected ground point through a raycast (what pick does)', () => {
    for (const { zoom, x, y, w, h } of SCREENS) {
      const cam = new IsoCamera();
      cam.setScreen(w, h);
      cam.setTransform(zoom, x, y);
      const ray = new Raycaster();
      for (const [px, py, pz] of POINTS) {
        const pixel = cam.project({ x: px, y: py, z: pz });
        const ndc = canvasToNdc(pixel.sx, pixel.sy, w, h);
        ray.setFromCamera(new Vector2(ndc.x, ndc.y), cam.camera);
        const hit = ray.ray.intersectPlane(GROUND, new Vector3());
        expect(hit).not.toBeNull();
        if (!hit) return;
        expect(hit.x).toBeCloseTo(px, 4);
        expect(hit.z).toBeCloseTo(pz, 4);
        // And the raycast agrees with the camera's own ground unprojection.
        const tile = cam.unprojectGround(pixel.sx, pixel.sy);
        expect(tile.tx).toBeCloseTo(hit.x, 4);
        expect(tile.ty).toBeCloseTo(hit.z, 4);
      }
    }
  });

  it('raycasts hit a raised point where the camera projects it (not its ground tile)', () => {
    const cam = new IsoCamera();
    cam.setScreen(800, 600);
    cam.setTransform(1, 400, 300);
    const raised = { x: 2, y: 1.2, z: 3 };
    const pixel = cam.project(raised);
    const ndc = canvasToNdc(pixel.sx, pixel.sy, 800, 600);
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(ndc.x, ndc.y), cam.camera);
    const d = ray.ray.distanceToPoint(new Vector3(raised.x, raised.y, raised.z));
    expect(d).toBeLessThan(1e-4);
    const ground = ray.ray.intersectPlane(GROUND, new Vector3());
    expect(ground?.x ?? 0).not.toBeCloseTo(raised.x, 1);
  });
});

describe('facing', () => {
  it('maps the four facings onto the FACING_DIR screen vectors when projected', () => {
    const cam = new IsoCamera();
    cam.setScreen(800, 600);
    cam.setTransform(1, 400, 300);
    const origin = cam.project({ x: 0, y: 0, z: 0 });
    for (const facing of [0, 1, 2, 3] as Facing[]) {
      const dir = facingDirection(facing);
      const tip = cam.project({ x: dir.x, y: 0, z: dir.z });
      const dx = tip.sx - origin.sx;
      const dy = tip.sy - origin.sy;
      const len = Math.hypot(dx, dy);
      const want = FACING_DIR[facing];
      expect(want).toBeDefined();
      if (!want) return;
      expect(dx / len, `facing ${facing} x`).toBeCloseTo(want[0], 6);
      expect(dy / len, `facing ${facing} y`).toBeCloseTo(want[1], 6);
      // The yaw turns local +Z onto that same world direction.
      const yaw = facingYaw(facing);
      expect(Math.sin(yaw), `facing ${facing} yaw x`).toBeCloseTo(dir.x, 9);
      expect(Math.cos(yaw), `facing ${facing} yaw z`).toBeCloseTo(dir.z, 9);
    }
  });

  it('measures the shortest turn between yaws', () => {
    expect(yawDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 9);
    expect(yawDelta(Math.PI / 2, -Math.PI / 2)).toBeCloseTo(Math.PI, 9);
    expect(yawDelta(-Math.PI / 2 + 0.1, Math.PI)).toBeCloseTo(-Math.PI / 2 - 0.1, 9);
    expect(Math.abs(yawDelta(facingYaw(0), facingYaw(1)))).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('internTint', () => {
  it('desaturates and lightens without leaving the gamut', () => {
    const tinted = internTint(0x3a86ff);
    expect(tinted).toBeGreaterThanOrEqual(0);
    expect(tinted).toBeLessThanOrEqual(0xffffff);
    const r = (tinted >> 16) & 0xff;
    const g = (tinted >> 8) & 0xff;
    const b = tinted & 0xff;
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0xff - 0x3a);
    expect((r + g + b) / 3).toBeGreaterThan((0x3a + 0x86 + 0xff) / 3);
  });
});
