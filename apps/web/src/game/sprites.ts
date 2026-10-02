import type { Avatar, Facing } from '@agenthotel/shared';
import { contrastColor, parseHex, shade, toHex } from './color.js';

/**
 * Procedural pixel-art avatars.
 *
 * Every frame is planned on a 16 × 28 logical grid (`planAvatarPixels`, pure) and painted at an
 * integer scale into a sheet (`generateAvatarSheet`) laid out by `layoutAvatarSheet` (pure):
 * one row per facing, one column per pose frame. The HR desk picker uses `renderAvatarPreview`.
 *
 * Grid (logical rows, feet on the last row):
 *   0–2 headroom (bun, raised hand) · 3 hair · 4–11 head · 12 neck · 13–20 torso ·
 *   21–23 hips · 24–25 shins · 26–27 shoes.
 *
 * Facings follow `Facing`: 0 N (up-right, back view), 1 E (down-right, front, facing right),
 * 2 S (down-left, front, facing left), 3 W (up-left, back view, facing left).
 */

/** Logical frame size in pixels before scaling. */
export const FRAME_W = 16;
export const FRAME_H = 28;
/** Default integer scale for in-game sheets (2 → 32 × 56 px frames beside 64 × 32 px tiles). */
export const SHEET_SCALE = 2;

export type SheetPose = 'idle' | 'walk' | 'sit' | 'type' | 'read' | 'raise' | 'nap';
export const SHEET_POSES: readonly SheetPose[] = [
  'idle',
  'walk',
  'sit',
  'type',
  'read',
  'raise',
  'nap',
];
export const POSE_FRAME_COUNT: Readonly<Record<SheetPose, number>> = {
  idle: 1,
  walk: 4,
  sit: 1,
  type: 2,
  read: 1,
  raise: 1,
  nap: 1,
};
export const FACINGS: readonly Facing[] = [0, 1, 2, 3];

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLayout {
  scale: number;
  /** Frame size in sheet pixels (logical size × scale). */
  frameW: number;
  frameH: number;
  columns: number;
  rows: number;
  width: number;
  height: number;
  /** `frameKey(pose, facing, index)` → rectangle in the sheet. */
  frames: Record<string, FrameRect>;
}

export interface AvatarSheet extends SheetLayout {
  canvas: HTMLCanvasElement | OffscreenCanvas;
}

export type PixelPart = 'skin' | 'hair' | 'eye' | 'shirt' | 'pants' | 'shoe' | 'accessory' | 'prop';

export interface PlannedPixel {
  x: number;
  y: number;
  /** CSS `#rrggbb`. */
  color: string;
  part: PixelPart;
}

export function frameKey(pose: SheetPose, facing: Facing, index = 0): string {
  return `${pose}_${facing}_${index}`;
}

function normaliseScale(scale: number | undefined): number {
  const s = Math.round(scale ?? SHEET_SCALE);
  return Number.isFinite(s) && s >= 1 ? s : SHEET_SCALE;
}

/** Pure frame table: facings as rows, pose frames as columns, in `SHEET_POSES` order. */
export function layoutAvatarSheet(scale: number = SHEET_SCALE): SheetLayout {
  const s = normaliseScale(scale);
  const frameW = FRAME_W * s;
  const frameH = FRAME_H * s;
  const columns = SHEET_POSES.reduce((n, p) => n + POSE_FRAME_COUNT[p], 0);
  const frames: Record<string, FrameRect> = {};
  for (const facing of FACINGS) {
    let col = 0;
    for (const pose of SHEET_POSES) {
      for (let i = 0; i < POSE_FRAME_COUNT[pose]; i++, col++) {
        frames[frameKey(pose, facing, i)] = {
          x: col * frameW,
          y: facing * frameH,
          w: frameW,
          h: frameH,
        };
      }
    }
  }
  return {
    scale: s,
    frameW,
    frameH,
    columns,
    rows: FACINGS.length,
    width: columns * frameW,
    height: FACINGS.length * frameH,
    frames,
  };
}

// ---- palette --------------------------------------------------------------------------------------

const FALLBACK = { skin: 0xf1c27d, hair: 0x4a2c17, shirt: 0x3a86ff, pants: 0x3d405b } as const;

interface SpritePalette {
  skin: string;
  skinDark: string;
  /** null = bald. */
  hair: string | null;
  hairDark: string | null;
  shirt: string;
  shirtDark: string;
  pants: string;
  pantsDark: string;
  cap: string;
  capDark: string;
  /** Tie / scarf colour, contrasting with the shirt. */
  accent: string;
  accentDark: string;
  shoe: string;
  eye: string;
  dark: string;
  metal: string;
  lens: string;
  bookCover: string;
  bookPage: string;
}

function resolvePalette(a: Avatar): SpritePalette {
  const skin = parseHex(a.skin, FALLBACK.skin);
  const hair = parseHex(a.hair, FALLBACK.hair);
  const shirt = parseHex(a.shirt, FALLBACK.shirt);
  const pants = parseHex(a.pants, FALLBACK.pants);
  const accent = contrastColor(shirt);
  const bald = a.hairStyle === 'bald';
  return {
    skin: toHex(skin),
    skinDark: toHex(shade(skin, 0.8)),
    hair: bald ? null : toHex(hair),
    hairDark: bald ? null : toHex(shade(hair, 0.72)),
    shirt: toHex(shirt),
    shirtDark: toHex(shade(shirt, 0.74)),
    pants: toHex(pants),
    pantsDark: toHex(shade(pants, 0.74)),
    cap: toHex(shade(shirt, 0.6)),
    capDark: toHex(shade(shirt, 0.45)),
    accent: toHex(accent),
    accentDark: toHex(shade(accent, 0.78)),
    shoe: '#26242e',
    eye: '#1b1b22',
    dark: '#2b2d33',
    metal: '#6c7078',
    lens: '#d7f0ff',
    bookCover: '#8d5a2b',
    bookPage: '#f4efe6',
  };
}

// ---- pixel planning -------------------------------------------------------------------------------

/** Last write wins, clipped to the frame; output is sorted so plans are canonical. */
class Plotter {
  private readonly cells = new Map<number, PlannedPixel>();

  px(x: number, y: number, color: string, part: PixelPart): void {
    if (x < 0 || y < 0 || x >= FRAME_W || y >= FRAME_H) return;
    this.cells.set(y * FRAME_W + x, { x, y, color, part });
  }

  rect(x: number, y: number, w: number, h: number, color: string, part: PixelPart): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, color, part);
  }

  /** Rect whose columns at or right of `splitX` use `dark` (the shaded side). */
  shaded(
    x: number,
    y: number,
    w: number,
    h: number,
    base: string,
    dark: string,
    splitX: number,
    part: PixelPart,
  ): void {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) this.px(x + i, y + j, x + i >= splitX ? dark : base, part);
  }

  pixels(): PlannedPixel[] {
    return [...this.cells.values()].sort((a, b) => a.y - b.y || a.x - b.x);
  }
}

interface View {
  facing: Facing;
  /** Eyes visible (facings 1 and 2). */
  front: boolean;
  /** Screen side the avatar looks towards: +1 right (facings 0, 1), −1 left (facings 2, 3). */
  side: 1 | -1;
}

function viewFor(facing: Facing): View {
  return {
    facing,
    front: facing === 1 || facing === 2,
    side: facing === 0 || facing === 1 ? 1 : -1,
  };
}

type Legs = 'stand' | 'spread' | 'pass' | 'sit';
type Arms = 'down' | 'swing' | 'type' | 'book' | 'raise';

interface FrameSpec {
  /** Vertical shift of everything above the hips (negative = up). */
  bob: number;
  legs: Legs;
  /** `spread`: +1 near leg forward, −1 far leg forward. `pass`: which foot lifts. */
  stride: 1 | -1;
  arms: Arms;
  /** Typing hand alternation. */
  phase: 0 | 1;
  eyes: 'open' | 'closed';
  /** Head offset (nap tilt), in logical pixels. */
  headDx: number;
  headDy: number;
}

const BASE_FRAME: FrameSpec = {
  bob: 0,
  legs: 'stand',
  stride: 1,
  arms: 'down',
  phase: 0,
  eyes: 'open',
  headDx: 0,
  headDy: 0,
};

function frameSpec(pose: SheetPose, index: number, view: View): FrameSpec {
  switch (pose) {
    case 'idle':
      return BASE_FRAME;
    case 'walk': {
      const i = ((index % 4) + 4) % 4;
      if (i === 0) return { ...BASE_FRAME, legs: 'spread', stride: 1, arms: 'swing' };
      if (i === 1) return { ...BASE_FRAME, legs: 'pass', stride: 1, bob: -1 };
      if (i === 2) return { ...BASE_FRAME, legs: 'spread', stride: -1, arms: 'swing' };
      return { ...BASE_FRAME, legs: 'pass', stride: -1, bob: -1 };
    }
    case 'sit':
      return { ...BASE_FRAME, legs: 'sit' };
    case 'type':
      return { ...BASE_FRAME, legs: 'sit', arms: 'type', phase: index % 2 === 0 ? 0 : 1 };
    case 'read':
      return { ...BASE_FRAME, arms: 'book' };
    case 'raise':
      return { ...BASE_FRAME, arms: 'raise' };
    case 'nap':
      return { ...BASE_FRAME, legs: 'sit', eyes: 'closed', headDx: view.side, headDy: 1 };
  }
}

// Logical anchors (see the header comment).
const HEAD_X = 4;
const HEAD_Y = 4;
const HEAD_W = 8;
const HEAD_H = 8;
const NECK_Y = 12;
const TORSO_X = 4;
const TORSO_Y = 13;
const TORSO_W = 8;
const TORSO_H = 8;
const HIP_Y = 21;
const SHIN_Y = 24;
const SHOE_Y = 26;
const ARM_L_X = 3;
const ARM_R_X = 12;

/**
 * Pure pixel plan for one frame: the visible pixels (after overdraw) of `pose` frame `frameIndex`
 * seen from `facing`, in logical frame coordinates. Deterministic for the same input.
 */
export function planAvatarPixels(
  avatar: Avatar,
  facing: Facing,
  pose: SheetPose,
  frameIndex = 0,
): PlannedPixel[] {
  const pal = resolvePalette(avatar);
  const view = viewFor(facing);
  const f = frameSpec(pose, frameIndex, view);
  const p = new Plotter();
  const { side, front } = view;
  const bob = f.bob;

  // Far arm first so the torso overlaps it.
  drawArms(p, pal, view, f, 'far');
  drawLegs(p, pal, view, f);
  // Torso + neck.
  p.shaded(
    TORSO_X,
    TORSO_Y + bob,
    TORSO_W,
    TORSO_H,
    pal.shirt,
    pal.shirtDark,
    TORSO_X + 6,
    'shirt',
  );
  p.rect(7, NECK_Y + bob, 2, 1, pal.skin, 'skin');
  // Head.
  const hx = HEAD_X + f.headDx;
  const hy = HEAD_Y + f.headDy + bob;
  p.shaded(hx, hy, HEAD_W, HEAD_H, pal.skin, pal.skinDark, hx + 6, 'skin');
  drawHair(p, pal, view, avatar.hairStyle, hx, hy);
  // Eyes: front views only.
  const eyeL = hx + 2 + side;
  const eyeR = eyeL + 3;
  if (front) {
    if (f.eyes === 'open') {
      p.rect(eyeL, hy + 4, 1, 2, pal.eye, 'eye');
      p.rect(eyeR, hy + 4, 1, 2, pal.eye, 'eye');
    } else {
      p.px(eyeL, hy + 5, pal.eye, 'eye');
      p.px(eyeR, hy + 5, pal.eye, 'eye');
    }
  }
  drawAccessory(p, pal, view, avatar.accessory, f, hx, hy, eyeL, eyeR);
  // Near arm and hand-held props over everything.
  drawArms(p, pal, view, f, 'near');
  drawProps(p, pal, view, f);
  return p.pixels();
}

function drawLegs(p: Plotter, pal: SpritePalette, view: View, f: FrameSpec): void {
  const { side, front } = view;
  switch (f.legs) {
    case 'stand': {
      p.shaded(5, HIP_Y, 6, 3, pal.pants, pal.pantsDark, 10, 'pants');
      p.rect(5, SHIN_Y, 2, 2, pal.pants, 'pants');
      p.rect(9, SHIN_Y, 2, 2, pal.pantsDark, 'pants');
      p.rect(4, SHOE_Y, 3, 2, pal.shoe, 'shoe');
      p.rect(9, SHOE_Y, 3, 2, pal.shoe, 'shoe');
      return;
    }
    case 'pass': {
      // Passing frame: legs together, one foot off the ground.
      p.shaded(5, HIP_Y, 6, 3, pal.pants, pal.pantsDark, 10, 'pants');
      const liftLeft = f.stride === 1;
      p.rect(5, SHIN_Y, 2, liftLeft ? 1 : 2, pal.pants, 'pants');
      p.rect(9, SHIN_Y, 2, liftLeft ? 2 : 1, pal.pantsDark, 'pants');
      p.rect(4, liftLeft ? SHOE_Y - 1 : SHOE_Y, 3, 2, pal.shoe, 'shoe');
      p.rect(9, liftLeft ? SHOE_Y : SHOE_Y - 1, 3, 2, pal.shoe, 'shoe');
      return;
    }
    case 'spread': {
      // Stride along the facing axis: one leg ahead (towards `side`), the other behind.
      p.shaded(5, HIP_Y, 6, 2, pal.pants, pal.pantsDark, 10, 'pants');
      p.rect(4, HIP_Y + 2, 8, 1, pal.pants, 'pants');
      const aheadX = side > 0 ? 11 : 3;
      const behindX = side > 0 ? 4 : 10;
      const aheadColor = f.stride === 1 ? pal.pants : pal.pantsDark;
      const behindColor = f.stride === 1 ? pal.pantsDark : pal.pants;
      p.rect(aheadX, SHIN_Y, 2, 2, aheadColor, 'pants');
      p.rect(behindX, SHIN_Y, 2, 2, behindColor, 'pants');
      p.rect(side > 0 ? 11 : 2, SHOE_Y, 3, 2, pal.shoe, 'shoe');
      p.rect(side > 0 ? 3 : 10, SHOE_Y, 3, 2, pal.shoe, 'shoe');
      return;
    }
    case 'sit': {
      p.shaded(5, HIP_Y, 6, 2, pal.pants, pal.pantsDark, 10, 'pants');
      if (front) {
        // Thighs reach towards the viewer-side, shins drop at their end.
        p.rect(side > 0 ? 11 : 2, HIP_Y, 3, 2, side > 0 ? pal.pantsDark : pal.pants, 'pants');
        p.rect(side > 0 ? 12 : 2, HIP_Y + 2, 2, 3, pal.pants, 'pants');
        p.rect(side > 0 ? 12 : 1, SHOE_Y, 3, 2, pal.shoe, 'shoe');
      } else {
        // Legs point away from the viewer: only short shins and the heels show.
        p.rect(5, HIP_Y + 2, 2, 2, pal.pants, 'pants');
        p.rect(9, HIP_Y + 2, 2, 2, pal.pantsDark, 'pants');
        p.rect(4, SHOE_Y - 1, 3, 2, pal.shoe, 'shoe');
        p.rect(9, SHOE_Y - 1, 3, 2, pal.shoe, 'shoe');
      }
      return;
    }
  }
}

/**
 * Arms are drawn in two passes: the arm on the far side of the body goes under the torso, the
 * near one over it. "Near" is the arm on the `side` the avatar looks towards.
 */
function drawArms(
  p: Plotter,
  pal: SpritePalette,
  view: View,
  f: FrameSpec,
  pass: 'far' | 'near',
): void {
  const { side, front } = view;
  const bob = f.bob;
  const nearX = side > 0 ? ARM_R_X : ARM_L_X;
  const farX = side > 0 ? ARM_L_X : ARM_R_X;
  const x = pass === 'near' ? nearX : farX;
  const sleeve = x === ARM_R_X ? pal.shirtDark : pal.shirt;
  const hand = x === ARM_R_X ? pal.skinDark : pal.skin;
  const armDown = (dx: number, dy: number): void => {
    p.rect(x + dx, TORSO_Y + bob + dy, 1, 5, sleeve, 'shirt');
    p.rect(x + dx, TORSO_Y + 5 + bob + dy, 1, 2, hand, 'skin');
  };
  switch (f.arms) {
    case 'down':
      armDown(0, 0);
      return;
    case 'swing': {
      // Opposite arms swing opposite ways: the leading arm is foreshortened with its hand ahead,
      // the trailing arm hangs full length with its hand behind. Sleeves stay on the shoulder.
      const lead = (pass === 'near' ? 1 : -1) * f.stride;
      if (lead > 0) {
        p.rect(x, TORSO_Y + bob, 1, 4, sleeve, 'shirt');
        p.rect(x + side, TORSO_Y + 4 + bob, 1, 2, hand, 'skin');
      } else {
        p.rect(x, TORSO_Y + bob, 1, 5, sleeve, 'shirt');
        p.rect(x - side, TORSO_Y + 5 + bob, 1, 2, hand, 'skin');
      }
      return;
    }
    case 'type': {
      // Upper arm down, forearm forward towards the desk; hands alternate rows while typing.
      p.rect(x, TORSO_Y + bob, 1, 3, sleeve, 'shirt');
      if (front) {
        // Forearms reach towards the desk (the facing side); the far one sits a row higher.
        // Hands tap alternately: the far hand lifts while the near one drops, and vice versa.
        const fx = side > 0 ? ARM_R_X : ARM_L_X - 1;
        const row = pass === 'near' ? 17 : 16;
        p.rect(fx, row + bob, 2, 1, sleeve, 'shirt');
        const handRow = pass === 'near' ? 18 - f.phase : 15 + f.phase;
        p.px(side > 0 ? fx + 2 : fx - 1, handRow + bob, hand, 'skin');
      } else {
        // From behind only the elbows show; a knuckle peeks out as the hands alternate.
        p.rect(x, TORSO_Y + 3 + bob, 1, 2, sleeve, 'shirt');
        const peek = pass === 'near' ? f.phase : 1 - f.phase;
        if (peek === 1) p.px(x, TORSO_Y + 5 + bob, hand, 'skin');
      }
      return;
    }
    case 'book': {
      // Both arms bent forward holding the book (drawn in `drawProps`).
      p.rect(x, TORSO_Y + bob, 1, 4, sleeve, 'shirt');
      if (!front) p.rect(x, TORSO_Y + 4 + bob, 1, 1, hand, 'skin');
      return;
    }
    case 'raise': {
      if (pass === 'near') {
        // Near arm straight up beside the head, hand open above the hairline.
        p.rect(x, HEAD_Y + bob, 1, 9, sleeve, 'shirt');
        p.rect(side > 0 ? x : x - 1, HEAD_Y - 2 + bob, 2, 2, hand, 'skin');
      } else {
        armDown(0, 0);
      }
      return;
    }
  }
}

function drawHair(
  p: Plotter,
  pal: SpritePalette,
  view: View,
  style: Avatar['hairStyle'],
  hx: number,
  hy: number,
): void {
  const { side, front } = view;
  const hair = pal.hair;
  const hairDark = pal.hairDark ?? pal.dark;
  if (style === 'bald') return;
  const split = hx + 6;
  const h = (x: number, y: number, w: number, hgt: number): void => {
    if (hair) p.shaded(x, y, w, hgt, hair, hairDark, split, 'hair');
  };
  if (style === 'cap') {
    // Crown + brim in a darker shirt tone; the hair shows beneath the band.
    p.shaded(hx + 1, hy - 1, 6, 1, pal.cap, pal.capDark, split, 'hair');
    p.shaded(hx, hy, HEAD_W, 2, pal.cap, pal.capDark, split, 'hair');
    if (front) p.rect(side > 0 ? hx + 6 : hx - 2, hy + 2, 4, 1, pal.capDark, 'hair');
    else p.px(side > 0 ? hx + 8 : hx - 1, hy + 2, pal.capDark, 'hair');
    if (front) {
      h(hx, hy + 3, 1, 2);
      h(hx + 7, hy + 3, 1, 2);
    } else {
      h(hx, hy + 2, HEAD_W, 4);
    }
    return;
  }
  // Common cap of hair: top row and the full row 4.
  h(hx + 1, hy - 1, 6, 1);
  h(hx, hy, HEAD_W, 1);
  if (front) {
    // Sideburns and a fringe leaning the way the avatar looks.
    h(hx, hy + 1, 1, 2);
    h(hx + 7, hy + 1, 1, 2);
    h(side > 0 ? hx + 4 : hx + 1, hy + 1, 3, 1);
  } else {
    h(hx, hy + 1, HEAD_W, 4);
  }
  if (style === 'long') {
    if (front) {
      h(hx - 1, hy + 1, 2, 8);
      h(hx + 7, hy + 1, 2, 8);
    } else {
      h(hx - 1, hy + 1, HEAD_W + 2, 9);
    }
  } else if (style === 'bun') {
    h(hx + 2, hy - 3, 4, 2);
  }
}

function drawAccessory(
  p: Plotter,
  pal: SpritePalette,
  view: View,
  accessory: Avatar['accessory'],
  f: FrameSpec,
  hx: number,
  hy: number,
  eyeL: number,
  eyeR: number,
): void {
  const { side, front } = view;
  const bob = f.bob;
  switch (accessory) {
    case 'none':
      return;
    case 'glasses': {
      if (!front) return;
      // Two lenses (outer column + eye column) and a bridge; the eyes stay visible through them.
      p.rect(eyeL - 1, hy + 4, 1, 2, pal.lens, 'accessory');
      p.rect(eyeR + 1, hy + 4, 1, 2, pal.lens, 'accessory');
      p.rect(eyeL, hy + 4, 1, 2, pal.lens, 'accessory');
      p.rect(eyeR, hy + 4, 1, 2, pal.lens, 'accessory');
      p.rect(eyeL + 1, hy + 4, eyeR - eyeL - 1, 1, pal.dark, 'accessory');
      // Re-plot the eyes on top of the lenses.
      if (f.eyes === 'open') {
        p.rect(eyeL, hy + 4, 1, 2, pal.eye, 'eye');
        p.rect(eyeR, hy + 4, 1, 2, pal.eye, 'eye');
      } else {
        p.px(eyeL, hy + 5, pal.eye, 'eye');
        p.px(eyeR, hy + 5, pal.eye, 'eye');
      }
      return;
    }
    case 'headset': {
      // Band over the hair, ear cups both sides, a mic boom on the viewer side.
      p.rect(hx + 1, hy - 1, 6, 1, pal.dark, 'accessory');
      p.px(hx, hy, pal.dark, 'accessory');
      p.px(hx + 7, hy, pal.dark, 'accessory');
      p.rect(hx - 2, hy + 3, 2, 3, pal.dark, 'accessory');
      p.rect(hx + 8, hy + 3, 2, 3, pal.dark, 'accessory');
      p.px(hx - 1, hy + 4, pal.metal, 'accessory');
      p.px(hx + 8, hy + 4, pal.metal, 'accessory');
      if (front) {
        p.px(side > 0 ? hx + 8 : hx - 1, hy + 6, pal.metal, 'accessory');
        p.px(side > 0 ? hx + 7 : hx, hy + 7, pal.dark, 'accessory');
      }
      return;
    }
    case 'tie': {
      if (!front) return;
      p.rect(7, TORSO_Y + bob, 2, 1, pal.accentDark, 'accessory');
      p.rect(side > 0 ? 8 : 7, TORSO_Y + 1 + bob, 1, 5, pal.accent, 'accessory');
      return;
    }
    case 'scarf': {
      p.rect(TORSO_X, NECK_Y + bob, TORSO_W, 1, pal.accent, 'accessory');
      p.rect(TORSO_X, NECK_Y + 1 + bob, TORSO_W, 1, pal.accentDark, 'accessory');
      if (front) {
        const tx = side > 0 ? 9 : 5;
        p.rect(tx, NECK_Y + 2 + bob, 2, 4, pal.accent, 'accessory');
        p.px(tx + (side > 0 ? 1 : 0), NECK_Y + 5 + bob, pal.accentDark, 'accessory');
      } else {
        p.rect(side > 0 ? 10 : 4, NECK_Y + 2 + bob, 2, 3, pal.accentDark, 'accessory');
      }
      return;
    }
  }
}

function drawProps(p: Plotter, pal: SpritePalette, view: View, f: FrameSpec): void {
  const { side, front } = view;
  const bob = f.bob;
  if (f.arms !== 'book') return;
  if (front) {
    // A small open book held in front at chest height, hands at its lower corners.
    const bx = side > 0 ? 10 : 2;
    p.rect(bx, 15 + bob, 4, 4, pal.bookCover, 'prop');
    p.rect(bx + 1, 16 + bob, 2, 2, pal.bookPage, 'prop');
    p.px(bx, 18 + bob, side > 0 ? pal.skinDark : pal.skin, 'skin');
    p.px(bx + 3, 18 + bob, side > 0 ? pal.skinDark : pal.skin, 'skin');
  } else {
    // From behind only the book's edge peeks past the shoulder.
    p.rect(side > 0 ? 13 : 2, 15 + bob, 1, 3, pal.bookCover, 'prop');
  }
}

// ---- canvas painting ------------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function paintPlan(
  ctx: Ctx2D,
  pixels: PlannedPixel[],
  ox: number,
  oy: number,
  scale: number,
): void {
  let current = '';
  for (const px of pixels) {
    if (px.color !== current) {
      current = px.color;
      ctx.fillStyle = current;
    }
    ctx.fillRect(ox + px.x * scale, oy + px.y * scale, scale, scale);
  }
}

function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  throw new Error('generateAvatarSheet needs a canvas (DOM or OffscreenCanvas)');
}

function context2d(canvas: HTMLCanvasElement | OffscreenCanvas): Ctx2D {
  const ctx = canvas.getContext('2d') as Ctx2D | null;
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/**
 * Paint every facing × pose frame of `avatar` into one sheet at an integer `scale` (default 2).
 * The returned `frames` table is `layoutAvatarSheet(scale).frames`.
 */
export function generateAvatarSheet(avatar: Avatar, opts: { scale?: number } = {}): AvatarSheet {
  const layout = layoutAvatarSheet(opts.scale);
  const canvas = createCanvas(layout.width, layout.height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, layout.width, layout.height);
  for (const facing of FACINGS) {
    for (const pose of SHEET_POSES) {
      for (let i = 0; i < POSE_FRAME_COUNT[pose]; i++) {
        const rect = layout.frames[frameKey(pose, facing, i)];
        if (!rect) continue;
        paintPlan(ctx, planAvatarPixels(avatar, facing, pose, i), rect.x, rect.y, layout.scale);
      }
    }
  }
  return { ...layout, canvas };
}

/** True when a DOM canvas with a 2D context exists (needed for `renderAvatarPreview`). */
export function canRenderPreview(): boolean {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false;
  try {
    const c = document.createElement('canvas');
    return typeof c.getContext === 'function' && c.getContext('2d') !== null;
  } catch {
    return false;
  }
}

/**
 * PNG data URL of one `idle` frame for the HR desk avatar picker. Pure DOM; no Pixi. Throws when
 * no DOM canvas is available (check `canRenderPreview()` first in non-browser code).
 */
export function renderAvatarPreview(avatar: Avatar, facing: Facing = 2, scale = 4): string {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function')
    throw new Error('renderAvatarPreview needs a DOM canvas');
  const s = normaliseScale(scale);
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_W * s;
  canvas.height = FRAME_H * s;
  const ctx = context2d(canvas);
  paintPlan(ctx, planAvatarPixels(avatar, facing, 'idle', 0), 0, 0, s);
  return canvas.toDataURL('image/png');
}
