import type { Bounds } from './iso.js';

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.25;
const FIT_MARGIN = 48;

/**
 * What the camera drives: a renderer-specific view that maps world-screen pixels (the `iso.ts`
 * space, where `tileToScreen` lives) to canvas pixels as `canvas = world · zoom + (x, y)`.
 * `x`/`y` are already rounded to whole pixels.
 */
export interface CameraView {
  setTransform(zoom: number, x: number, y: number): void;
}

/**
 * Pan/zoom for the world view. The room's bounding box is centred in the canvas; `pan` is an
 * offset from that centre in screen pixels. Wheel zooms in 0.25 steps around the cursor; middle
 * button or space + left drag pans. Renderer-agnostic: it only talks to a `CameraView`.
 */
export class Camera {
  zoom = 1;
  panX = 0;
  panY = 0;
  /** Canvas-pixel offset of the world-screen origin, as last pushed to the view. */
  private offsetX = 0;
  private offsetY = 0;
  private bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private screenW = 1;
  private screenH = 1;
  private spaceHeld = false;
  private hovering = false;
  private drag: { pointerId: number; lastX: number; lastY: number } | null = null;
  private cleanup: (() => void)[] = [];

  constructor(private readonly view: CameraView) {}

  /** True while a pan drag is in progress (the world suppresses clicks). */
  get dragging(): boolean {
    return this.drag !== null;
  }

  /** True while the space bar is held (left drag pans instead of clicking). */
  get panModifier(): boolean {
    return this.spaceHeld;
  }

  setBounds(bounds: Bounds, refit: boolean): void {
    this.bounds = bounds;
    if (refit) this.fit();
    else this.apply();
  }

  /** Canvas size changed: keep the zoom, re-centre the room. */
  setScreen(width: number, height: number): void {
    this.screenW = Math.max(1, width);
    this.screenH = Math.max(1, height);
    this.panX = 0;
    this.panY = 0;
    this.apply();
  }

  /** Largest zoom step at which the whole room (with margin) fits, clamped to the zoom range. */
  fit(): void {
    const w = this.bounds.maxX - this.bounds.minX;
    const h = this.bounds.maxY - this.bounds.minY;
    const z = Math.min(
      (this.screenW - FIT_MARGIN) / Math.max(1, w),
      (this.screenH - FIT_MARGIN) / Math.max(1, h),
    );
    this.zoom = clampZoom(Math.floor(z / ZOOM_STEP) * ZOOM_STEP);
    this.panX = 0;
    this.panY = 0;
    this.apply();
  }

  apply(): void {
    const cx = (this.bounds.minX + this.bounds.maxX) / 2;
    const cy = (this.bounds.minY + this.bounds.maxY) / 2;
    this.offsetX = Math.round(this.screenW / 2 - cx * this.zoom + this.panX);
    this.offsetY = Math.round(this.screenH / 2 - cy * this.zoom + this.panY);
    this.view.setTransform(this.zoom, this.offsetX, this.offsetY);
  }

  /** Canvas pixel → world-screen pixel (the inverse of the transform pushed to the view). */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.offsetX) / this.zoom, y: (sy - this.offsetY) / this.zoom };
  }

  /** Zoom by whole steps keeping the world point under (sx, sy) fixed. */
  zoomAt(steps: number, sx: number, sy: number): void {
    const before = this.screenToWorld(sx, sy);
    const next = clampZoom(Math.round((this.zoom + steps * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP);
    if (next === this.zoom) return;
    this.zoom = next;
    this.apply();
    const after = this.screenToWorld(sx, sy);
    this.panX += (after.x - before.x) * this.zoom;
    this.panY += (after.y - before.y) * this.zoom;
    this.apply();
  }

  panBy(dx: number, dy: number): void {
    this.panX += dx;
    this.panY += dy;
    this.apply();
  }

  /** Install DOM listeners on the canvas (wheel zoom, drag pan, space modifier). */
  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void => {
      el.addEventListener(type, fn, opts);
      this.cleanup.push(() => el.removeEventListener(type, fn, opts));
    };
    const onWin = <K extends keyof WindowEventMap>(
      type: K,
      fn: (e: WindowEventMap[K]) => void,
    ): void => {
      window.addEventListener(type, fn);
      this.cleanup.push(() => window.removeEventListener(type, fn));
    };

    on(
      canvas,
      'wheel',
      (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        this.zoomAt(e.deltaY < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    // Stop the browser's middle-button autoscroll.
    on(canvas, 'mousedown', (e) => {
      if (e.button === 1) e.preventDefault();
    });
    on(canvas, 'pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && this.spaceHeld)) {
        e.preventDefault();
        this.drag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
        canvas.setPointerCapture(e.pointerId);
        canvas.style.cursor = 'grabbing';
      }
    });
    on(canvas, 'pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.panBy(e.clientX - this.drag.lastX, e.clientY - this.drag.lastY);
      this.drag.lastX = e.clientX;
      this.drag.lastY = e.clientY;
    });
    const endDrag = (e: PointerEvent): void => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = this.spaceHeld ? 'grab' : '';
    };
    on(canvas, 'pointerup', endDrag);
    on(canvas, 'pointercancel', endDrag);
    on(canvas, 'pointerenter', () => {
      this.hovering = true;
    });
    on(canvas, 'pointerleave', () => {
      this.hovering = false;
    });
    onWin('keydown', (e) => {
      if (e.code !== 'Space' || isTypingTarget(e.target)) return;
      if (this.hovering) e.preventDefault();
      if (!this.spaceHeld) {
        this.spaceHeld = true;
        if (!this.drag) canvas.style.cursor = 'grab';
      }
    });
    onWin('keyup', (e) => {
      if (e.code !== 'Space') return;
      this.spaceHeld = false;
      if (!this.drag) canvas.style.cursor = '';
    });
    onWin('blur', () => {
      this.spaceHeld = false;
      this.drag = null;
      canvas.style.cursor = '';
    });
  }

  detach(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup = [];
    this.drag = null;
    this.spaceHeld = false;
  }
}

function clampZoom(z: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

/** True when a key event originated in a text field, where shortcuts must not fire. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t.isContentEditable
  );
}
