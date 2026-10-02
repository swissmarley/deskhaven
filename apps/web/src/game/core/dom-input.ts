import { type Camera, isTypingTarget } from '../camera.js';

/** Pointer / keyboard sink the DOM adapter feeds; `WorldCore` implements it. */
export interface InputTarget {
  pointerDown(p: { x: number; y: number; button: number }): void;
  pointerMove(p: { x: number; y: number; buttons: number }): void;
  pointerUp(p: { x: number; y: number }): void;
  /** The press ended somewhere the canvas cannot classify (released outside, cancelled). */
  pointerCancel(): void;
  pointerLeave(): void;
  /** Returns true when the key was consumed (the adapter then prevents the default). */
  keyDown(key: string, typingTarget: boolean): boolean;
}

/**
 * Installs listeners for a mounted canvas (including the camera's wheel / pan / Space handling);
 * returns the function that removes them. Injectable so the core runs under plain Node in tests.
 */
export type InputBinder = (
  canvas: HTMLCanvasElement,
  container: HTMLElement,
  target: InputTarget,
  camera: Camera,
) => () => void;

/**
 * DOM listeners that reproduce what Pixi's EventSystem used to deliver to the stage: `pointerdown`
 * on the canvas; `pointermove` on the document, classified by the canvas rect (a move outside is
 * the stage's `pointerleave`); `pointerup` on the window, classified by its target (released on
 * the canvas → `pointerup`, anywhere else → `pointerupoutside`, which the core treats as a cancel
 * so a furniture drag released over the side panel snaps back). Capture phase, like Pixi, so these
 * run before the `Camera`'s own canvas listeners.
 */
export const bindDomInput: InputBinder = (canvas, container, target, camera) => {
  camera.attach(canvas);
  const cleanup: (() => void)[] = [() => camera.detach()];
  const on = <K extends keyof GlobalEventHandlersEventMap>(
    el: EventTarget,
    type: K,
    fn: (e: GlobalEventHandlersEventMap[K]) => void,
    capture = true,
  ): void => {
    const listener = fn as EventListener;
    el.addEventListener(type, listener, capture);
    cleanup.push(() => el.removeEventListener(type, listener, capture));
  };
  const local = (e: PointerEvent): { x: number; y: number; w: number; h: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };
  let inside = false;

  on(canvas, 'pointerdown', (e) => {
    const p = local(e);
    target.pointerDown({ x: p.x, y: p.y, button: e.button });
  });
  on(document, 'pointermove', (e) => {
    const p = local(e);
    if (p.x >= 0 && p.y >= 0 && p.x < p.w && p.y < p.h) {
      inside = true;
      target.pointerMove({ x: p.x, y: p.y, buttons: e.buttons });
    } else if (inside) {
      inside = false;
      target.pointerLeave();
    }
  });
  on(canvas, 'pointerleave', () => {
    if (!inside) return;
    inside = false;
    target.pointerLeave();
  });
  on(window, 'pointerup', (e) => {
    const path = e.composedPath();
    const released = path.length > 0 ? path[0] : e.target;
    if (released !== canvas) {
      target.pointerCancel();
      return;
    }
    const p = local(e);
    target.pointerUp({ x: p.x, y: p.y });
  });
  on(window, 'pointercancel', () => target.pointerCancel());
  // Bubble phase, as before the split (editor shortcuts; the Camera handles Space on the window).
  on(
    container,
    'keydown',
    (e) => {
      if (target.keyDown(e.key, isTypingTarget(e.target))) e.preventDefault();
    },
    false,
  );

  return () => {
    for (const fn of cleanup) fn();
    cleanup.length = 0;
  };
};
