/**
 * Pure helpers for the DOM overlay (`overlay.ts`): where a label / bubble goes relative to the
 * projected head anchor, the CSS transform string, and the "only touch the DOM when it moved"
 * rule. No DOM here so the rules run under Node.
 *
 * Pixi reference (`pixi/avatar.ts`, `pixi/scene.ts`): the name label's bottom sits 4 px above the
 * sprite's top (`labelBaseY = −(frameH + 4)`), the bubble's tail tip 62 px above the feet when
 * standing (56 seated), i.e. a little above the label. Here both hang off the projected top of the
 * head: the label `LABEL_LIFT_PX` above it, the bubble tail `BUBBLE_LIFT_PX` above it.
 */

export interface ScreenPos {
  sx: number;
  sy: number;
}

/** Gap between the top of the head and the bottom of the name label (CSS px). */
export const LABEL_LIFT_PX = 4;
/** Gap between the top of the head and the bubble's tail tip (CSS px): clears the label. */
export const BUBBLE_LIFT_PX = 22;
/** Elements whose anchor is further than this outside the canvas are hidden. */
export const OFFSCREEN_MARGIN_PX = 160;
/** Minimum change of either coordinate before `style.transform` is rewritten. */
export const MOVE_EPSILON_PX = 0.5;

/** Round to 1/100 px so the transform string stays short and stable. */
function px(v: number): string {
  const r = Math.round(v * 100) / 100;
  return `${r === 0 ? 0 : r}px`;
}

/**
 * CSS transform that puts an element's bottom-centre at canvas pixel (sx, sy): the percentage
 * translate uses the element's own box, the pixel translate the anchor.
 */
export function overlayTransform(sx: number, sy: number): string {
  return `translate(-50%, -100%) translate(${px(sx)}, ${px(sy)})`;
}

/** Whether a new anchor differs from the last written one by at least `epsilon` on either axis. */
export function movedEnough(
  prev: ScreenPos | null,
  sx: number,
  sy: number,
  epsilon = MOVE_EPSILON_PX,
): boolean {
  if (!prev) return true;
  return Math.abs(sx - prev.sx) >= epsilon || Math.abs(sy - prev.sy) >= epsilon;
}

/** Whether an anchor is within the canvas plus a margin (hide elements far outside). */
export function anchorVisible(
  sx: number,
  sy: number,
  width: number,
  height: number,
  margin = OFFSCREEN_MARGIN_PX,
): boolean {
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return false;
  return sx >= -margin && sx <= width + margin && sy >= -margin && sy <= height + margin;
}

/** Anchor of the name label (bottom-centre) for a projected head top. */
export function labelAnchor(head: ScreenPos): ScreenPos {
  return { sx: head.sx, sy: head.sy - LABEL_LIFT_PX };
}

/** Anchor of the bubble's tail tip for a projected head top. */
export function bubbleAnchor(head: ScreenPos): ScreenPos {
  return { sx: head.sx, sy: head.sy - BUBBLE_LIFT_PX };
}
