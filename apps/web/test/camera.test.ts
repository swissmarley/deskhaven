import { describe, expect, it } from 'vitest';
import { Camera, type CameraView, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../src/game/camera.js';
import { roomBounds } from '../src/game/iso.js';

interface Transform {
  zoom: number;
  x: number;
  y: number;
}

function makeCamera(): { camera: Camera; view: CameraView; last: () => Transform } {
  const calls: Transform[] = [];
  const view: CameraView = {
    setTransform(zoom, x, y) {
      calls.push({ zoom, x, y });
    },
  };
  const camera = new Camera(view);
  const last = (): Transform => {
    const t = calls.at(-1);
    if (!t) throw new Error('no transform applied');
    return t;
  };
  return { camera, view, last };
}

const BOUNDS = roomBounds(14, 10); // 768 × 480 px at zoom 1

describe('Camera', () => {
  it('fit picks the largest zoom step that fits with the margin', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    // min((1000-48)/768, (600-48)/480) = 1.15 → floored to the 0.25 step → 1.
    expect(camera.zoom).toBe(1);
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    expect(last()).toEqual({ zoom: 1, x: Math.round(500 - cx), y: Math.round(300 - cy) });

    camera.setScreen(2000, 1300);
    camera.fit();
    // min(1952/768, 1252/480) = 2.54 → 2.5 (also the max).
    expect(camera.zoom).toBe(2.5);
  });

  it('fit clamps to the zoom range', () => {
    const { camera } = makeCamera();
    camera.setScreen(200, 200);
    camera.setBounds(BOUNDS, true);
    expect(camera.zoom).toBe(ZOOM_MIN);
    camera.setScreen(10000, 10000);
    camera.fit();
    expect(camera.zoom).toBe(ZOOM_MAX);
  });

  it('setBounds without refit keeps the zoom', () => {
    const { camera } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    camera.zoomAt(2, 500, 300);
    const z = camera.zoom;
    camera.setBounds(roomBounds(20, 20), false);
    expect(camera.zoom).toBe(z);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const { camera } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    const sx = 731;
    const sy = 157;
    const before = camera.screenToWorld(sx, sy);
    camera.zoomAt(1, sx, sy);
    expect(camera.zoom).toBe(1 + ZOOM_STEP);
    const after = camera.screenToWorld(sx, sy);
    // The view offset is rounded to whole pixels, so the drift is below half a screen pixel.
    const tol = 0.5 / camera.zoom + 1e-9;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(tol);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(tol);

    camera.zoomAt(-3, sx, sy);
    expect(camera.zoom).toBe(0.5);
    const out = camera.screenToWorld(sx, sy);
    expect(Math.abs(out.x - before.x)).toBeLessThanOrEqual(0.5 / camera.zoom + 1e-9);
    expect(Math.abs(out.y - before.y)).toBeLessThanOrEqual(0.5 / camera.zoom + 1e-9);
  });

  it('zoomAt clamps and does nothing at the limits', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    camera.zoomAt(100, 0, 0);
    expect(camera.zoom).toBe(ZOOM_MAX);
    const t = last();
    camera.zoomAt(1, 0, 0);
    expect(last()).toEqual(t);
  });

  it('panBy shifts the view by whole pixels', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    const t0 = last();
    camera.panBy(13, -7);
    expect(camera.panX).toBe(13);
    expect(camera.panY).toBe(-7);
    expect(last()).toEqual({ zoom: t0.zoom, x: t0.x + 13, y: t0.y - 7 });
  });

  it('setScreen resets the pan and re-centres', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    camera.panBy(40, 40);
    camera.setScreen(800, 500);
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    expect(last()).toEqual({ zoom: 1, x: Math.round(400 - cx), y: Math.round(250 - cy) });
  });

  it('screenToWorld inverts the transform pushed to the view', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true);
    camera.zoomAt(2, 500, 300);
    camera.panBy(-33, 21);
    const t = last();
    for (const [wx, wy] of [
      [0, 0],
      [32, 16],
      [-320, 100],
      [448, 368],
    ] as const) {
      const sx = wx * t.zoom + t.x;
      const sy = wy * t.zoom + t.y;
      const w = camera.screenToWorld(sx, sy);
      expect(w.x).toBeCloseTo(wx, 9);
      expect(w.y).toBeCloseTo(wy, 9);
    }
  });
});
