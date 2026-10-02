import type { Avatar, Facing } from '@agenthotel/shared';
import { Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { AvatarPalette, AvatarSheetTextures, Painters } from './assets/index.js';
import { parseHex } from './color.js';
import { FACING_DIR, tileDiamond } from './iso.js';
import { frameKey, type SheetPose } from './sprites.js';

/** Visual poses. Behaviours map onto these in `world.ts`; `coffee` is the idle coffee-sip variant. */
export type Pose =
  | 'idle'
  | 'walk'
  | 'typing'
  | 'working'
  | 'reading'
  | 'terminal'
  | 'browsing'
  | 'thinking'
  | 'raise_hand'
  | 'sweat'
  | 'cooldown'
  | 'celebrate'
  | 'nap'
  | 'wait'
  | 'leave'
  | 'coffee';

export interface AvatarSpriteOptions {
  id: string;
  name: string;
  avatar: Avatar;
  isIntern?: boolean;
  painters: Painters;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;
}

const CONFETTI_COLORS = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xffffff];
const CONFETTI_COUNT = 30;
const CELEBRATE_S = 1.5;
/** Intern arrival/departure "poof": a few light pixels drifting out and fading. */
const POOF_COUNT = 6;
const POOF_S = 0.5;
const POOF_COLORS = [0xffffff, 0xe8ecf1, 0xd7dde6];
/** Emote overlay colours. */
const OUTLINE = 0x101418;
const SWEAT_COLOR = 0x4cc9f0;
const SAND = 0xf4c15d;
const GLASS = 0xdbeafe;
const HOURGLASS_FRAME = 0x8d5a2b;
const ZZZ_COLOR = 0xdfe7ef;
/** Screen pixels per emote-icon cell (matches the 2× generated sheet). */
const PX = 2;
const SWEAT_LOOP_S = 0.8;
const HOURGLASS_FRAME_S = 0.45;
const ZZZ_LIFE_S = 2.4;
const ZZZ_GAP_S = 0.8;
const LEAVE_FADE_S = 0.7;
const SEAT_SINK_PX = 6;
const LABEL_Y = -58;
/** Sheet animation rates. */
const WALK_FPS = 8;
const TYPE_FPS = 6;
const INTERN_TINT = 0xcfd4dc;
const WAIT_TINT = 0x9a9a9a;
/** Faint blue cast while rate-limited. */
const COOLDOWN_TINT = 0xb9d0ff;

const FALLBACK: AvatarPalette = {
  skin: 0xf1c27d,
  hair: 0x4a2c17,
  shirt: 0x3a86ff,
  pants: 0x3d405b,
};

function paletteFrom(a: Avatar): AvatarPalette {
  return {
    skin: parseHex(a.skin, FALLBACK.skin),
    hair: a.hairStyle === 'bald' ? null : parseHex(a.hair, FALLBACK.hair ?? 0x4a2c17),
    shirt: parseHex(a.shirt, FALLBACK.shirt),
    pants: parseHex(a.pants, FALLBACK.pants),
  };
}

/**
 * Which sheet frame a visual pose shows. Poses without a dedicated frame fall back to `sit` when
 * seated and `idle` otherwise; `index` is advanced by the sprite's clock for walk/type cycles.
 */
export function sheetFrameFor(
  pose: Pose,
  seated: boolean,
  poseT: number,
): { pose: SheetPose; index: number } {
  switch (pose) {
    case 'walk':
      return { pose: 'walk', index: Math.floor(poseT * WALK_FPS) % 4 };
    case 'typing':
    case 'working':
      return { pose: 'type', index: Math.floor(poseT * TYPE_FPS) % 2 };
    case 'reading':
      return { pose: 'read', index: 0 };
    case 'raise_hand':
    case 'celebrate':
      return { pose: 'raise', index: 0 };
    case 'nap':
      return { pose: 'nap', index: 0 };
    default:
      return { pose: seated ? 'sit' : 'idle', index: 0 };
  }
}

/** Fill one block of emote-icon cells (grid units of `PX`) at a given alpha. */
function cell(
  g: Graphics,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  w: number,
  h: number,
  color: number,
  alpha: number,
): void {
  g.rect(x0 + cx * PX, y0 + cy * PX, w * PX, h * PX).fill({ color, alpha });
}

const NAME_STYLE = new TextStyle({
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 11,
  fill: 0xffffff,
  stroke: { color: 0x101418, width: 3 },
});

/**
 * Avatar: either a procedural pixel-art sprite (frames from `painters.avatarSheet`, the default)
 * or the M1 placeholder box body, plus a name label, a facing-aware set of effect overlays and the
 * per-pose animation driven from `update(deltaMS)`. Local origin = centre of the feet on the
 * floor; the world positions it at `tileToScreen` of its (fractional) tile.
 */
export class AvatarSprite extends Container {
  readonly id: string;
  facing: Facing = 2;
  seated = false;
  pose: Pose = 'idle';
  /** Set once a `leave` fade has completed; the world then removes the sprite. */
  finished = false;

  private palette: AvatarPalette;
  private intern: boolean;
  private readonly painters: Painters;
  /** Bobs / leans; holds the body and per-frame effects. */
  private readonly bodyRoot = new Container();
  /** Placeholder body (unused in generated mode). */
  private readonly body = new Graphics();
  /** Generated mode: the current sheet frame, feet at the origin. */
  private readonly pixel: Sprite | null;
  private sheet: AvatarSheetTextures | null;
  /** Generated mode: floor shadow that does not bob with the body. */
  private readonly ground = new Graphics();
  private readonly fx = new Graphics();
  private readonly ring = new Graphics();
  private readonly nameLabel: Text;
  private readonly fxText: Text;
  private readonly labelBaseY: number;
  private t = 0;
  private poseT = 0;
  private readonly confetti: Particle[] = [];
  /** Fixed pool for `poof()`; `poofT` counts down while it is visible. */
  private readonly puff: Particle[] = Array.from({ length: POOF_COUNT }, () => ({
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    color: 0xffffff,
  }));
  private poofT = 0;
  private highlighted = false;

  constructor(opts: AvatarSpriteOptions) {
    super();
    this.id = opts.id;
    this.painters = opts.painters;
    this.intern = opts.isIntern ?? false;
    this.palette = paletteFrom(opts.avatar);
    this.sheet = this.loadSheet(opts.avatar);
    this.nameLabel = new Text({
      text: opts.name,
      style: NAME_STYLE,
      anchor: { x: 0.5, y: 1 },
      resolution: 2,
    });
    this.fxText = new Text({
      text: '',
      style: new TextStyle({
        fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
        fontSize: 13,
        fontWeight: 'bold',
        fill: 0xffffff,
        stroke: { color: 0x101418, width: 3 },
      }),
      anchor: 0.5,
      resolution: 2,
    });
    this.fxText.visible = false;
    if (this.sheet) {
      this.pixel = new Sprite({
        texture: Texture.EMPTY,
        anchor: { x: 0.5, y: 1 },
        roundPixels: true,
      });
      this.ground.ellipse(0, 1, 11, 5).fill({ color: 0x000000, alpha: 0.22 });
      this.bodyRoot.addChild(this.pixel, this.fx);
      this.addChild(this.ring, this.ground, this.bodyRoot, this.fxText, this.nameLabel);
      this.labelBaseY = -(this.sheet.frameH + 4);
    } else {
      this.pixel = null;
      this.bodyRoot.addChild(this.body, this.fx);
      this.addChild(this.ring, this.bodyRoot, this.fxText, this.nameLabel);
      this.labelBaseY = LABEL_Y;
    }
    this.nameLabel.y = this.labelBaseY;
    if (this.intern) this.scale.set(0.8);
    this.eventMode = 'static';
    this.interactiveChildren = false;
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(-16, -60, 32, 66);
    this.applyTint();
    this.redrawBody();
  }

  /** True when this sprite shows generated pixel-art frames rather than the placeholder body. */
  get generated(): boolean {
    return this.pixel !== null;
  }

  setName(name: string): void {
    if (this.nameLabel.text !== name) this.nameLabel.text = name;
  }

  setAppearance(avatar: Avatar, isIntern?: boolean): void {
    this.palette = paletteFrom(avatar);
    if (this.pixel) this.sheet = this.loadSheet(avatar) ?? this.sheet;
    if (isIntern !== undefined && isIntern !== this.intern) {
      this.intern = isIntern;
      this.scale.set(isIntern ? 0.8 : 1);
    }
    this.applyTint();
    this.redrawBody();
  }

  setFacing(f: Facing): void {
    if (f === this.facing) return;
    this.facing = f;
    this.redrawBody();
  }

  setSeated(seated: boolean): void {
    this.seated = seated;
  }

  setHighlighted(on: boolean): void {
    if (on === this.highlighted) return;
    this.highlighted = on;
    this.ring.clear();
    if (on) {
      this.ring
        .poly(tileDiamond(0, 0).map((v) => v * 0.7))
        .fill({ color: 0xffd166, alpha: 0.25 })
        .stroke({ width: 2, color: 0xffd166 });
    }
  }

  setPose(pose: Pose): void {
    if (pose === this.pose && pose !== 'celebrate') return;
    this.pose = pose;
    this.poseT = 0;
    this.fxText.visible = false;
    this.fxText.scale.set(1);
    switch (pose) {
      case 'celebrate':
        this.spawnConfetti();
        break;
      case 'raise_hand':
        this.fxText.text = '!';
        this.fxText.style.fill = 0xff3b30;
        this.fxText.position.set(0, -70);
        this.fxText.alpha = 1;
        break;
      default:
        break;
    }
    this.applyTint();
    this.applyFrame();
  }

  /** Advance animations. Call once per frame with the ticker's `deltaMS`. */
  update(deltaMS: number): void {
    const dt = deltaMS / 1000;
    this.t += dt;
    this.poseT += dt;
    const fx = this.fx;
    fx.clear();
    let bob = 0;
    let lean = 0;
    const dir = FACING_DIR[this.facing] ?? [0, 1];
    const side = dir[0] >= 0 ? 1 : -1; // which screen side the avatar faces
    // Where held props go: a little in front at hand height.
    const frontX = dir[0] * 9;
    const frontY = -24 + dir[1] * 4;
    const p = this.palette;
    // The sheet already draws limbs and hand-held items; only the placeholder paints them here.
    const limbs = this.pixel === null;

    switch (this.pose) {
      case 'idle':
      case 'wait':
        bob = Math.sin(this.t * Math.PI * 2 * 0.8);
        break;
      case 'walk': {
        const ph = this.t * Math.PI * 2 * 3;
        if (limbs) {
          bob = -Math.abs(Math.sin(ph)) * 3;
          lean = Math.sin(ph) * 0.06;
        }
        break;
      }
      case 'typing':
      case 'working': {
        bob = Math.sin(this.t * Math.PI * 2 * 0.8) * 0.5;
        if (limbs) {
          const hb = Math.sin(this.t * Math.PI * 2 * 6) * 1.5;
          fx.rect(frontX - 7, frontY + hb, 5, 3).fill(p.skin);
          fx.rect(frontX + 2, frontY - hb, 5, 3).fill(p.skin);
        }
        if (this.pose === 'typing') {
          // Monitor glow: irregular flicker from two incommensurate sines.
          const flicker = 0.3 + 0.3 * Math.abs(Math.sin(this.t * 23) * Math.sin(this.t * 7));
          fx.rect(frontX - 9, -44, 18, 13).fill({ color: 0x9fd8ff, alpha: flicker });
        }
        break;
      }
      case 'reading':
        if (limbs) {
          lean = 0.12 * side;
          fx.rect(frontX - 6, frontY - 4, 12, 8).fill(0x8d5a2b);
          fx.rect(frontX - 5, frontY - 3, 10, 6).fill(0xf4efe6);
          fx.moveTo(frontX, frontY - 3)
            .lineTo(frontX, frontY + 3)
            .stroke({ width: 1, color: 0x8d5a2b });
        }
        break;
      case 'terminal':
        if (Math.floor(this.t * 2.5) % 2 === 0) fx.rect(frontX - 1, -41, 3, 7).fill(0x3ddc84);
        break;
      case 'browsing':
        fx.rect(frontX - 9, -44, 18, 13).fill({
          color: 0x3a86ff,
          alpha: 0.3 + 0.1 * Math.sin(this.t * 4),
        });
        break;
      case 'thinking': {
        // Head scratch: a hand swinging in a small arc beside the head.
        const a = Math.sin(this.t * Math.PI * 2 * 1.5) * 0.6;
        const hx = side * 9 + Math.cos(a) * 3;
        const hy = -46 + Math.sin(a) * 3;
        fx.rect(hx - 1.5, hy, 3, 12).fill(p.shirt);
        fx.rect(hx - 2.5, hy - 3, 5, 4).fill(p.skin);
        break;
      }
      case 'raise_hand': {
        if (limbs) {
          const ax = side * 11;
          fx.rect(ax - 2, -56, 4, 22).fill(p.shirt);
          fx.rect(ax - 3, -61, 6, 6).fill(p.skin);
        }
        this.fxText.visible = true;
        this.fxText.y = -70 + Math.sin(this.t * 6) * 2;
        // Pulse 1.0 → 1.15 so the "!" catches the eye.
        this.fxText.scale.set(1.075 + 0.075 * Math.sin(this.poseT * Math.PI * 2 * 2));
        break;
      }
      case 'sweat':
        this.drawSweat(fx, side);
        break;
      case 'cooldown':
        this.drawHourglass(fx, 13, -52);
        break;
      case 'celebrate': {
        if (this.poseT < CELEBRATE_S) {
          bob = -Math.abs(Math.sin(this.poseT * Math.PI * 2 * 1.5)) * 10;
          this.drawThumbsUp(fx);
        }
        if (limbs) {
          fx.rect(-14, -46, 4, 14).fill(p.shirt);
          fx.rect(10, -46, 4, 14).fill(p.shirt);
          fx.rect(-15, -50, 6, 5).fill(p.skin);
          fx.rect(9, -50, 6, 5).fill(p.skin);
        }
        this.updateConfetti(dt, fx);
        break;
      }
      case 'nap':
        if (limbs) lean = 0.08;
        this.drawZzz(fx, side);
        break;
      case 'leave':
        this.alpha = Math.max(0, this.alpha - dt / LEAVE_FADE_S);
        if (this.alpha <= 0) this.finished = true;
        break;
      case 'coffee': {
        // Cup lifts to the mouth now and then; steam while it rests.
        const lift = Math.max(0, Math.sin(this.t * Math.PI * 2 * 0.35));
        const cy = frontY - 2 - lift * 12;
        fx.rect(frontX - 3, cy, 6, 7).fill(0xf8f9fa);
        fx.rect(frontX + 3, cy + 1.5, 2, 4).fill(0xf8f9fa);
        if (lift < 0.15) {
          const s = (this.t * 0.7) % 1;
          fx.circle(frontX + Math.sin(this.t * 5) * 1.5, cy - 3 - s * 6, 1.2).fill({
            color: 0xffffff,
            alpha: 0.6 - s * 0.5,
          });
        }
        break;
      }
    }

    if (this.poofT > 0) this.updatePoof(dt, fx);

    // Pixel frames stay on whole pixels so they remain crisp.
    if (!limbs) bob = Math.round(bob);
    this.applyFrame();
    this.bodyRoot.y = (this.seated ? SEAT_SINK_PX : 0) + bob;
    this.bodyRoot.rotation = lean;
    this.nameLabel.y = this.labelBaseY + bob * 0.5;
  }

  private loadSheet(avatar: Avatar): AvatarSheetTextures | null {
    const provider = this.painters.avatarSheet;
    if (!provider) return null;
    try {
      return provider(avatar);
    } catch (err) {
      console.warn('[game] avatar sheet generation failed; using the placeholder body', err);
      return null;
    }
  }

  /** Swap the sheet frame for the current pose / facing / clock (generated mode only). */
  private applyFrame(): void {
    if (!this.pixel || !this.sheet) return;
    const { pose, index } = sheetFrameFor(this.pose, this.seated, this.poseT);
    const frames = this.sheet.frames;
    const tex =
      frames[frameKey(pose, this.facing, index)] ?? frames[frameKey('idle', this.facing, 0)];
    if (tex && this.pixel.texture !== tex) this.pixel.texture = tex;
  }

  private applyTint(): void {
    const tint =
      this.pose === 'wait'
        ? WAIT_TINT
        : this.pose === 'cooldown'
          ? COOLDOWN_TINT
          : this.intern && this.pixel
            ? INTERN_TINT
            : 0xffffff;
    (this.pixel ?? this.body).tint = tint;
  }

  private redrawBody(): void {
    if (this.pixel) {
      this.applyFrame();
      return;
    }
    this.body.clear();
    this.painters.avatarBody(this.body, this.palette, this.facing, this.intern);
  }

  /**
   * A brief puff of light pixels around the body (interns appearing at the door or leaving).
   * Reuses a fixed particle pool; nothing is allocated.
   */
  poof(): void {
    this.poofT = POOF_S;
    const n = this.puff.length;
    for (let i = 0; i < n; i++) {
      const c = this.puff[i];
      if (!c) continue;
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
      c.x = Math.cos(a) * 4;
      c.y = -26 + Math.sin(a) * 6;
      c.vx = Math.cos(a) * 36;
      c.vy = Math.sin(a) * 30 - 14;
      c.color = POOF_COLORS[i % POOF_COLORS.length] ?? 0xffffff;
    }
  }

  private updatePoof(dt: number, g: Graphics): void {
    this.poofT = Math.max(0, this.poofT - dt);
    const alpha = this.poofT / POOF_S;
    for (const c of this.puff) {
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      g.rect(Math.round(c.x) - 1, Math.round(c.y) - 1, PX, PX).fill({ color: c.color, alpha });
    }
  }

  /** Pixel thumbs-up (8×9 cells incl. outline) bobbing above the name label for the celebration. */
  private drawThumbsUp(g: Graphics): void {
    const p = this.palette;
    const x0 = -4 * PX;
    const bob = Math.round(Math.sin(this.poseT * Math.PI * 2 * 3) * 1.5) * PX;
    const y0 = this.labelBaseY - 14 - 9 * PX + bob;
    // Fade in over 100 ms, out over the last 300 ms.
    const alpha = Math.max(0, Math.min(1, this.poseT / 0.1, (CELEBRATE_S - this.poseT) / 0.3));
    // Outline boxes first, then the thumb, fist and cuff on top.
    cell(g, x0, y0, 3, 0, 4, 5, OUTLINE, alpha);
    cell(g, x0, y0, 0, 2, 8, 7, OUTLINE, alpha);
    cell(g, x0, y0, 4, 1, 2, 3, p.skin, alpha);
    cell(g, x0, y0, 1, 3, 6, 4, p.skin, alpha);
    cell(g, x0, y0, 1, 7, 6, 1, p.shirt, alpha);
    cell(g, x0, y0, 2, 4, 1, 1, 0xffffff, alpha);
  }

  /** Sweat drop: forms at the temple, falls with gravity, fades, repeats every 0.8 s. */
  private drawSweat(g: Graphics, side: number): void {
    const ph = (this.poseT / SWEAT_LOOP_S) % 1;
    const x = side * 8;
    const grow = Math.min(1, ph / 0.3);
    const fall = Math.max(0, (ph - 0.3) / 0.7);
    const y = -49 + fall * fall * 18;
    const alpha = fall > 0.6 ? 1 - (fall - 0.6) / 0.4 : 1;
    const r = 1.5 + grow;
    g.poly([x, y - r * 2, x - r, y, x + r, y]).fill({ color: SWEAT_COLOR, alpha });
    g.circle(x, y, r).fill({ color: SWEAT_COLOR, alpha });
    // Shine pixel on the upper-left of the drop.
    g.rect(x - r * 0.6 - 0.5, y - r * 0.4 - 0.5, 1, 1).fill({ color: 0xffffff, alpha });
  }

  /** Hourglass (5×7 cells) whose sand runs through three frames, beside the head. */
  private drawHourglass(g: Graphics, cx: number, cy: number): void {
    const x0 = cx - 2.5 * PX;
    const y0 = cy - 3.5 * PX;
    const frame = Math.floor(this.poseT / HOURGLASS_FRAME_S) % 3;
    cell(g, x0, y0, 0, 0, 5, 1, HOURGLASS_FRAME, 1);
    cell(g, x0, y0, 0, 6, 5, 1, HOURGLASS_FRAME, 1);
    cell(g, x0, y0, 0, 1, 5, 1, GLASS, 1);
    cell(g, x0, y0, 1, 2, 3, 1, GLASS, 1);
    cell(g, x0, y0, 2, 3, 1, 1, GLASS, 1);
    cell(g, x0, y0, 1, 4, 3, 1, GLASS, 1);
    cell(g, x0, y0, 0, 5, 5, 1, GLASS, 1);
    if (frame === 0) {
      cell(g, x0, y0, 1, 1, 3, 1, SAND, 1);
      cell(g, x0, y0, 2, 2, 1, 1, SAND, 1);
    } else if (frame === 1) {
      cell(g, x0, y0, 2, 2, 1, 1, SAND, 1);
      cell(g, x0, y0, 2, 3, 1, 1, SAND, 1);
      cell(g, x0, y0, 1, 5, 3, 1, SAND, 1);
    } else {
      cell(g, x0, y0, 2, 4, 1, 1, SAND, 1);
      cell(g, x0, y0, 1, 5, 3, 1, SAND, 1);
    }
  }

  /** Three "z" glyphs launched 0.8 s apart, each rising, growing and fading over 2.4 s. */
  private drawZzz(g: Graphics, side: number): void {
    for (let i = 0; i < 3; i++) {
      const life = this.poseT - i * ZZZ_GAP_S;
      if (life < 0) continue;
      const ph = (life % ZZZ_LIFE_S) / ZZZ_LIFE_S;
      const size = 3 + ph * 4;
      const x = side * (8 + ph * 10) + Math.sin(ph * Math.PI * 4) * 2;
      const y = -52 - ph * 28;
      const alpha = ph < 0.1 ? ph / 0.1 : ph > 0.6 ? (1 - ph) / 0.4 : 1;
      g.moveTo(x, y)
        .lineTo(x + size, y)
        .lineTo(x, y + size)
        .lineTo(x + size, y + size)
        .stroke({ width: 1.5, color: ZZZ_COLOR, alpha });
    }
  }

  private spawnConfetti(): void {
    this.confetti.length = 0;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      this.confetti.push({
        x: (Math.random() - 0.5) * 10,
        y: -44,
        vx: (Math.random() - 0.5) * 140,
        vy: -80 - Math.random() * 120,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? 0xffffff,
      });
    }
  }

  private updateConfetti(dt: number, g: Graphics): void {
    if (this.poseT >= CELEBRATE_S) {
      this.confetti.length = 0;
      return;
    }
    const fade = 1 - this.poseT / CELEBRATE_S;
    for (const c of this.confetti) {
      c.vy += 320 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      g.rect(c.x - 1.5, c.y - 1.5, 3, 3).fill({ color: c.color, alpha: fade });
    }
  }
}
