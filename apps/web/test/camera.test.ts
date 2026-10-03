import { describe, expect, it } from 'vitest';
import {
  Camera,
  type CameraView,
  EASE_MS,
  easeOutCubic,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from '../src/game/camera.js';
import { roomBounds } from '../src/game/iso.js';

interface Transform {
  zoom: number;
  x: number;
  y: number;
}

function makeCamera(): {
  camera: Camera;
  view: CameraView;
  calls: Transform[];
  last: () => Transform;
  settle: () => void;
} {
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
  /** Run the easing to completion in 16 ms frames. */
  const settle = (): void => {
    for (let i = 0; i < 100 && camera.animating; i++) camera.tick(16);
  };
  return { camera, view, calls, last, settle };
}

const BOUNDS = roomBounds(14, 10); // 768 × 480 px at zoom 1

describe('Camera', () => {
  it('fit picks the largest zoom step that fits with the margin', () => {
    const { camera, last, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    // min((1000-48)/768, (600-48)/480) = 1.15 → floored to the 0.25 step → 1.
    expect(camera.zoom).toBe(1);
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    expect(last()).toEqual({ zoom: 1, x: Math.round(500 - cx), y: Math.round(300 - cy) });

    camera.setScreen(2000, 1300);
    camera.fit();
    settle();
    // min(1952/768, 1252/480) = 2.54 → 2.5 (also the max).
    expect(camera.zoom).toBe(2.5);
  });

  it('fit clamps to the zoom range', () => {
    const { camera, settle } = makeCamera();
    camera.setScreen(200, 200);
    camera.setBounds(BOUNDS, true);
    settle();
    expect(camera.zoom).toBe(ZOOM_MIN);
    camera.setScreen(10000, 10000);
    camera.fit();
    settle();
    expect(camera.zoom).toBe(ZOOM_MAX);
  });

  it('an immediate fit snaps without any easing frames', () => {
    const { camera, calls } = makeCamera();
    camera.setScreen(1000, 600);
    const n = calls.length;
    camera.setBounds(BOUNDS, true, true);
    expect(camera.animating).toBe(false);
    expect(calls.length).toBe(n + 1);
    expect(camera.zoom).toBe(1);
    expect(camera.targetZoom).toBe(1);
  });

  it('setBounds without refit keeps the zoom', () => {
    const { camera, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.zoomAt(2, 500, 300);
    settle();
    const z = camera.zoom;
    camera.setBounds(roomBounds(20, 20), false);
    expect(camera.zoom).toBe(z);
  });

  it('zoomAt keeps the world point under the cursor fixed', () => {
    const { camera, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    const sx = 731;
    const sy = 157;
    const before = camera.screenToWorld(sx, sy);
    camera.zoomAt(1, sx, sy);
    settle();
    expect(camera.zoom).toBe(1 + ZOOM_STEP);
    const after = camera.screenToWorld(sx, sy);
    // The view offset is rounded to whole pixels, so the drift is below half a screen pixel.
    const tol = 0.5 / camera.zoom + 1e-9;
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(tol);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(tol);

    camera.zoomAt(-3, sx, sy);
    settle();
    expect(camera.zoom).toBe(0.5);
    const out = camera.screenToWorld(sx, sy);
    expect(Math.abs(out.x - before.x)).toBeLessThanOrEqual(0.5 / camera.zoom + 1e-9);
    expect(Math.abs(out.y - before.y)).toBeLessThanOrEqual(0.5 / camera.zoom + 1e-9);
  });

  it('zoomAt clamps and does nothing at the limits', () => {
    const { camera, last, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.zoomAt(100, 0, 0);
    settle();
    expect(camera.zoom).toBe(ZOOM_MAX);
    const t = last();
    camera.zoomAt(1, 0, 0);
    expect(camera.animating).toBe(false);
    settle();
    expect(last()).toEqual(t);
  });

  it('panBy shifts the view by whole pixels', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    const t0 = last();
    camera.panBy(13, -7);
    expect(camera.panX).toBe(13);
    expect(camera.panY).toBe(-7);
    expect(last()).toEqual({ zoom: t0.zoom, x: t0.x + 13, y: t0.y - 7 });
  });

  it('setScreen resets the pan and re-centres', () => {
    const { camera, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.panBy(40, 40);
    camera.setScreen(800, 500);
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
    const cx = (BOUNDS.minX + BOUNDS.maxX) / 2;
    const cy = (BOUNDS.minY + BOUNDS.maxY) / 2;
    expect(last()).toEqual({ zoom: 1, x: Math.round(400 - cx), y: Math.round(250 - cy) });
  });

  it('screenToWorld inverts the transform pushed to the view', () => {
    const { camera, last, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.zoomAt(2, 500, 300);
    settle();
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

describe('Camera easing', () => {
  it('easeOutCubic starts fast, lands softly and is clamped', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
    // The first half covers most of the distance.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.8);
  });

  it('zoomAt eases over EASE_MS and converges exactly to the targets', () => {
    const { camera, calls, last } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    const n = calls.length;
    camera.zoomAt(2, 731, 157);
    // Nothing is pushed until the next frame.
    expect(calls.length).toBe(n);
    expect(camera.animating).toBe(true);
    expect(camera.zoom).toBe(1);
    expect(camera.targetZoom).toBe(1.5);
    const zooms: number[] = [];
    let elapsed = 0;
    while (camera.animating) {
      camera.tick(16);
      elapsed += 16;
      zooms.push(camera.zoom);
      expect(elapsed).toBeLessThanOrEqual(EASE_MS + 16);
    }
    expect(elapsed).toBe(Math.ceil(EASE_MS / 16) * 16);
    // Monotonic, strictly between start and target until the last frame, then exact.
    for (let i = 1; i < zooms.length; i++)
      expect(zooms[i] ?? 0).toBeGreaterThanOrEqual(zooms[i - 1] ?? 0);
    expect(zooms[0] ?? 0).toBeGreaterThan(1);
    expect(zooms[0] ?? 0).toBeLessThan(1.5);
    expect(camera.zoom).toBe(1.5);
    expect(camera.panX).toBe(camera.targetPanX);
    expect(camera.panY).toBe(camera.targetPanY);
    // The final transform pushed to the view is the steady state of an instant zoom.
    const direct = makeCamera();
    direct.camera.setScreen(1000, 600);
    direct.camera.setBounds(BOUNDS, true, true);
    direct.camera.zoomAt(2, 731, 157);
    direct.camera.tick(10_000);
    expect(last()).toEqual(direct.last());
    expect(last().zoom).toBe(1.5);
    // Idle afterwards: ticking pushes nothing more.
    const m = calls.length;
    camera.tick(16);
    expect(calls.length).toBe(m);
  });

  it('wheel steps accumulate into the target while easing', () => {
    const { camera, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    const before = camera.screenToWorld(600, 400);
    camera.zoomAt(1, 600, 400);
    camera.tick(40);
    camera.zoomAt(1, 600, 400);
    camera.tick(40);
    camera.zoomAt(1, 600, 400);
    expect(camera.targetZoom).toBe(1.75);
    settle();
    expect(camera.zoom).toBe(1.75);
    // The cursor anchor holds in the final frame as if the three steps were one instant zoom.
    const after = camera.screenToWorld(600, 400);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(0.5 / camera.zoom + 1e-9);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(0.5 / camera.zoom + 1e-9);
  });

  it('a pan drag during the easing applies at once and carries into the target', () => {
    const { camera, last, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.zoomAt(1, 500, 300);
    camera.tick(30);
    const t = last();
    camera.panBy(10, -5);
    expect(last()).toEqual({ zoom: t.zoom, x: t.x + 10, y: t.y - 5 });
    const targetX = camera.targetPanX;
    settle();
    expect(camera.panX).toBe(targetX);
    // Compared with the same zoom without the drag, the end state is shifted by the drag.
    const other = makeCamera();
    other.camera.setScreen(1000, 600);
    other.camera.setBounds(BOUNDS, true, true);
    other.camera.zoomAt(1, 500, 300);
    other.settle();
    expect(last()).toEqual({
      zoom: other.last().zoom,
      x: other.last().x + 10,
      y: other.last().y - 5,
    });
  });

  it('fit eases the zoom and the pan back to the centre', () => {
    const { camera, settle } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.zoomAt(3, 900, 100);
    settle();
    camera.panBy(50, 50);
    camera.fit();
    expect(camera.animating).toBe(true);
    expect(camera.targetZoom).toBe(1);
    expect(camera.targetPanX).toBe(0);
    camera.tick(16);
    expect(camera.zoom).toBeLessThan(1.75);
    expect(camera.zoom).toBeGreaterThan(1);
    settle();
    expect(camera.zoom).toBe(1);
    expect(camera.panX).toBe(0);
    expect(camera.panY).toBe(0);
  });

  it('a huge frame finishes the easing in one tick', () => {
    const { camera, calls } = makeCamera();
    camera.setScreen(1000, 600);
    camera.setBounds(BOUNDS, true, true);
    camera.zoomAt(-1, 0, 0);
    const n = calls.length;
    camera.tick(5000);
    expect(calls.length).toBe(n + 1);
    expect(camera.animating).toBe(false);
    expect(camera.zoom).toBe(0.75);
  });
});
