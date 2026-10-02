import type { Avatar, Facing } from '@agenthotel/shared';
import { Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import type { AvatarPalette, Painters } from './assets/index.js';
import { parseHex } from './color.js';
import { FACING_DIR, tileDiamond } from './iso.js';

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
const LEAVE_FADE_S = 0.7;
const SEAT_SINK_PX = 6;
const LABEL_Y = -58;

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

const NAME_STYLE = new TextStyle({
  fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif',
  fontSize: 11,
  fill: 0xffffff,
  stroke: { color: 0x101418, width: 3 },
});

/**
 * Placeholder avatar: an isometric box body (pants / shirt / skin / hair) with a name label and a
 * facing marker, animated per pose from `update(deltaMS)`. Local origin = centre of the feet on
 * the floor; the world positions it at `tileToScreen` of its (fractional) tile.
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
  private readonly body = new Graphics();
  private readonly fx = new Graphics();
  private readonly ring = new Graphics();
  private readonly nameLabel: Text;
  private readonly fxText: Text;
  private t = 0;
  private poseT = 0;
  private readonly confetti: Particle[] = [];
  private highlighted = false;

  constructor(opts: AvatarSpriteOptions) {
    super();
    this.id = opts.id;
    this.painters = opts.painters;
    this.intern = opts.isIntern ?? false;
    this.palette = paletteFrom(opts.avatar);
    this.nameLabel = new Text({
      text: opts.name,
      style: NAME_STYLE,
      anchor: { x: 0.5, y: 1 },
      resolution: 2,
    });
    this.nameLabel.y = LABEL_Y;
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
    this.bodyRoot.addChild(this.body, this.fx);
    this.addChild(this.ring, this.bodyRoot, this.fxText, this.nameLabel);
    if (this.intern) this.scale.set(0.8);
    this.eventMode = 'static';
    this.interactiveChildren = false;
    this.cursor = 'pointer';
    this.hitArea = new Rectangle(-16, -60, 32, 66);
    this.redrawBody();
  }

  setName(name: string): void {
    if (this.nameLabel.text !== name) this.nameLabel.text = name;
  }

  setAppearance(avatar: Avatar, isIntern?: boolean): void {
    this.palette = paletteFrom(avatar);
    if (isIntern !== undefined && isIntern !== this.intern) {
      this.intern = isIntern;
      this.scale.set(isIntern ? 0.8 : 1);
    }
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
      case 'nap':
        this.fxText.text = 'z z z';
        this.fxText.style.fill = 0xdfe7ef;
        break;
      default:
        break;
    }
    this.body.tint = pose === 'wait' ? 0x9a9a9a : 0xffffff;
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

    switch (this.pose) {
      case 'idle':
      case 'wait':
        bob = Math.sin(this.t * Math.PI * 2 * 0.8);
        break;
      case 'walk': {
        const ph = this.t * Math.PI * 2 * 3;
        bob = -Math.abs(Math.sin(ph)) * 3;
        lean = Math.sin(ph) * 0.06;
        break;
      }
      case 'typing':
      case 'working': {
        bob = Math.sin(this.t * Math.PI * 2 * 0.8) * 0.5;
        const hb = Math.sin(this.t * Math.PI * 2 * 6) * 1.5;
        fx.rect(frontX - 7, frontY + hb, 5, 3).fill(p.skin);
        fx.rect(frontX + 2, frontY - hb, 5, 3).fill(p.skin);
        if (this.pose === 'typing') {
          // Monitor glow: irregular flicker from two incommensurate sines.
          const flicker = 0.3 + 0.3 * Math.abs(Math.sin(this.t * 23) * Math.sin(this.t * 7));
          fx.rect(frontX - 9, -44, 18, 13).fill({ color: 0x9fd8ff, alpha: flicker });
        }
        break;
      }
      case 'reading':
        lean = 0.12 * side;
        fx.rect(frontX - 6, frontY - 4, 12, 8).fill(0x8d5a2b);
        fx.rect(frontX - 5, frontY - 3, 10, 6).fill(0xf4efe6);
        fx.moveTo(frontX, frontY - 3)
          .lineTo(frontX, frontY + 3)
          .stroke({ width: 1, color: 0x8d5a2b });
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
        const ax = side * 11;
        fx.rect(ax - 2, -56, 4, 22).fill(p.shirt);
        fx.rect(ax - 3, -61, 6, 6).fill(p.skin);
        this.fxText.visible = true;
        this.fxText.y = -70 + Math.sin(this.t * 6) * 2;
        break;
      }
      case 'sweat': {
        // A drop that repeatedly forms at the temple and falls.
        const ph = (this.t * 1.2) % 1;
        const dy = ph * 14;
        const alpha = 1 - ph * 0.7;
        fx.poly([9, -50 + dy, 6.5, -45 + dy, 11.5, -45 + dy]).fill({ color: 0x4cc9f0, alpha });
        fx.circle(9, -44.5 + dy, 2.5).fill({ color: 0x4cc9f0, alpha });
        break;
      }
      case 'cooldown': {
        const cx = 11;
        const cy = -54;
        fx.circle(cx, cy, 5.5).fill({ color: 0xcfd8dc, alpha: 0.9 });
        for (let i = 0; i < 3; i++) {
          const a = this.t * 0.8 + (i * Math.PI) / 3;
          fx.moveTo(cx - Math.cos(a) * 7, cy - Math.sin(a) * 7)
            .lineTo(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7)
            .stroke({ width: 1, color: 0xffffff });
        }
        break;
      }
      case 'celebrate': {
        if (this.poseT < CELEBRATE_S)
          bob = -Math.abs(Math.sin(this.poseT * Math.PI * 2 * 1.5)) * 10;
        fx.rect(-14, -46, 4, 14).fill(p.shirt);
        fx.rect(10, -46, 4, 14).fill(p.shirt);
        fx.rect(-15, -50, 6, 5).fill(p.skin);
        fx.rect(9, -50, 6, 5).fill(p.skin);
        this.updateConfetti(dt, fx);
        break;
      }
      case 'nap': {
        const ph = (this.t * 0.5) % 1;
        lean = 0.08;
        this.fxText.visible = true;
        this.fxText.position.set(10 + ph * 6, -60 - ph * 12);
        this.fxText.alpha = 1 - ph;
        break;
      }
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

    this.bodyRoot.y = (this.seated ? SEAT_SINK_PX : 0) + bob;
    this.bodyRoot.rotation = lean;
    this.nameLabel.y = LABEL_Y + bob * 0.5;
  }

  private redrawBody(): void {
    this.body.clear();
    this.painters.avatarBody(this.body, this.palette, this.facing, this.intern);
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
