import {
  CanvasTexture,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  type Quaternion,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Texture,
  Vector3,
} from 'three';
import { toHex } from '../color.js';
import type { Pose } from '../pose.js';
import {
  CELEBRATE_S,
  CONFETTI_COUNT,
  CONFETTI_GRAVITY,
  confettiAlpha,
  EXCLAIM_COLOR,
  exclaimPulse,
  GLASS_COLOR,
  HOURGLASS_FRAME_COLOR,
  HOURGLASS_FRAMES,
  hourglassFrame,
  OUTLINE_COLOR,
  type Particle,
  POOF_COUNT,
  POOF_S,
  poofAlpha,
  SAND_COLOR,
  SCREEN_RIGHT,
  SWEAT_COLOR,
  spawnConfetti,
  spawnPoof,
  stepParticles,
  sweatDrop,
  thumbsUp,
  ZZZ_COLOR,
  ZZZ_COUNT,
  zzzGlyphs,
} from './emote-math.js';

/**
 * In-scene emotes for the Three avatars, mirroring the Pixi overlays: thumbs-up + confetti for
 * `celebrate`, a looping sweat drop, the ticking hourglass for `cooldown`, the pulsing "!" for
 * `raise_hand`, rising "z"s for `nap`, and the intern poof. Icons are billboarded `Sprite`s with
 * small pixel-art `CanvasTexture`s painted once per scene (`EmoteResources`); confetti and poof are
 * one `InstancedMesh` of camera-facing quads each. Everything is hidden (zero draw calls) unless
 * its pose is active. Timing lives in `emote-math.ts`.
 *
 * The emote group is positioned by the owner at the avatar's feet and never rotates with the
 * avatar: "beside the head" offsets use `SCREEN_RIGHT` so they stay on the screen side they were
 * meant for. All sizes are world units at body scale 1; the owner passes the intern scale.
 */

/** Canvas pixels per pixel-art cell. */
const CELL = 4;
const FALLBACK_SKIN = 0xf1c27d;
const FALLBACK_SHIRT = 0x3a86ff;
/** Sprite sizes (world units, width × height) at scale 1. */
const THUMB_SIZE = { w: 0.36, h: 0.4 };
const HOURGLASS_SIZE = { w: 0.24, h: 0.34 };
const EXCLAIM_SIZE = { w: 0.22, h: 0.34 };
/** Offsets from the top of the head (world units at scale 1). */
const ABOVE_LABEL = 0.6;
const HOURGLASS_RIGHT = 0.32;
const HOURGLASS_DOWN = 0.15;
const TEMPLE_RIGHT = 0.18;
const TEMPLE_DOWN = 0.12;
const CONFETTI_DOWN = 0.1;
const CONFETTI_QUAD = 0.06;
const POOF_QUAD = 0.05;
const POOF_HEIGHT = 0.65;

export type EmoteTextureKey =
  | 'thumb'
  | 'hourglass0'
  | 'hourglass1'
  | 'hourglass2'
  | 'exclaim'
  | 'zed'
  | 'drop';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  return [canvas, ctx];
}

function cell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  c: number,
) {
  ctx.fillStyle = toHex(c);
  ctx.fillRect(x * CELL, y * CELL, w * CELL, h * CELL);
}

function paintThumb(ctx: CanvasRenderingContext2D): void {
  cell(ctx, 3, 0, 4, 5, OUTLINE_COLOR);
  cell(ctx, 0, 2, 8, 7, OUTLINE_COLOR);
  cell(ctx, 4, 1, 2, 3, FALLBACK_SKIN);
  cell(ctx, 1, 3, 6, 4, FALLBACK_SKIN);
  cell(ctx, 1, 7, 6, 1, FALLBACK_SHIRT);
  cell(ctx, 2, 4, 1, 1, 0xffffff);
}

function paintHourglass(ctx: CanvasRenderingContext2D, frame: number): void {
  cell(ctx, 0, 0, 5, 1, HOURGLASS_FRAME_COLOR);
  cell(ctx, 0, 6, 5, 1, HOURGLASS_FRAME_COLOR);
  cell(ctx, 0, 1, 5, 1, GLASS_COLOR);
  cell(ctx, 1, 2, 3, 1, GLASS_COLOR);
  cell(ctx, 2, 3, 1, 1, GLASS_COLOR);
  cell(ctx, 1, 4, 3, 1, GLASS_COLOR);
  cell(ctx, 0, 5, 5, 1, GLASS_COLOR);
  if (frame === 0) {
    cell(ctx, 1, 1, 3, 1, SAND_COLOR);
    cell(ctx, 2, 2, 1, 1, SAND_COLOR);
  } else if (frame === 1) {
    cell(ctx, 2, 2, 1, 1, SAND_COLOR);
    cell(ctx, 2, 3, 1, 1, SAND_COLOR);
    cell(ctx, 1, 5, 3, 1, SAND_COLOR);
  } else {
    cell(ctx, 2, 4, 1, 1, SAND_COLOR);
    cell(ctx, 1, 5, 3, 1, SAND_COLOR);
  }
}

function paintExclaim(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.font = `bold ${Math.round(h * 0.85)}px system-ui, -apple-system, Segoe UI, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, w * 0.18);
  ctx.strokeStyle = toHex(OUTLINE_COLOR);
  ctx.strokeText('!', w / 2, h * 0.54);
  ctx.fillStyle = toHex(EXCLAIM_COLOR);
  ctx.fillText('!', w / 2, h * 0.54);
}

function paintZed(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.lineWidth = s * 0.16;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = toHex(ZZZ_COLOR);
  ctx.beginPath();
  ctx.moveTo(s * 0.15, s * 0.2);
  ctx.lineTo(s * 0.85, s * 0.2);
  ctx.lineTo(s * 0.15, s * 0.8);
  ctx.lineTo(s * 0.85, s * 0.8);
  ctx.stroke();
}

function paintDrop(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const r = w * 0.36;
  const cx = w / 2;
  const cy = h - r - 1;
  ctx.fillStyle = toHex(SWEAT_COLOR);
  ctx.beginPath();
  ctx.moveTo(cx, 1);
  ctx.lineTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(cx - r * 0.6, cy - r * 0.4, Math.max(1, w / 12), Math.max(1, w / 12));
}

/** Textures and the shared quad geometry of one scene's emotes; textures are painted lazily. */
export class EmoteResources {
  private readonly textures = new Map<EmoteTextureKey, Texture>();
  readonly quad = new PlaneGeometry(1, 1);

  texture(key: EmoteTextureKey): Texture {
    let tex = this.textures.get(key);
    if (tex) return tex;
    let canvas: HTMLCanvasElement;
    let pixelArt = true;
    switch (key) {
      case 'thumb': {
        const [c, ctx] = makeCanvas(8 * CELL, 9 * CELL);
        paintThumb(ctx);
        canvas = c;
        break;
      }
      case 'hourglass0':
      case 'hourglass1':
      case 'hourglass2': {
        const [c, ctx] = makeCanvas(5 * CELL, 7 * CELL);
        paintHourglass(ctx, Number(key.slice(-1)));
        canvas = c;
        break;
      }
      case 'exclaim': {
        const [c, ctx] = makeCanvas(40, 64);
        paintExclaim(ctx, 40, 64);
        canvas = c;
        pixelArt = false;
        break;
      }
      case 'zed': {
        const [c, ctx] = makeCanvas(32, 32);
        paintZed(ctx, 32);
        canvas = c;
        pixelArt = false;
        break;
      }
      case 'drop': {
        const [c, ctx] = makeCanvas(24, 32);
        paintDrop(ctx, 24, 32);
        canvas = c;
        pixelArt = false;
        break;
      }
    }
    tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    tex.magFilter = pixelArt ? NearestFilter : LinearFilter;
    tex.minFilter = LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.textures.set(key, tex);
    return tex;
  }

  dispose(): void {
    for (const t of this.textures.values()) t.dispose();
    this.textures.clear();
    this.quad.dispose();
  }
}

/** Per-frame inputs from the owner. */
export interface EmoteFrame {
  /** World height of the top of the head above the feet. */
  headTop: number;
  /** Which screen side the avatar faces (`screenSide(yaw)`). */
  side: 1 | -1;
  /** Body scale (interns 0.8). */
  scale: number;
  /** Camera orientation, for the instanced quads. */
  cameraQuaternion: Quaternion;
}

const _m = new Matrix4();
const _p = new Vector3();
const _s = new Vector3();
const _c = new Color();

export class AvatarEmotes {
  readonly group = new Group();
  private readonly thumb: Sprite;
  private readonly hourglass: Sprite;
  private readonly exclaim: Sprite;
  private readonly drop: Sprite;
  private readonly zeds: Sprite[] = [];
  private readonly confetti: InstancedMesh;
  private readonly confettiMaterial: MeshBasicMaterial;
  private readonly puff: InstancedMesh;
  private readonly puffMaterial: MeshBasicMaterial;
  private readonly materials: (SpriteMaterial | MeshBasicMaterial)[] = [];
  private pose: Pose = 'idle';
  private poseT = 0;
  private t = 0;
  private hourglassIndex = -1;
  private confettiParticles: Particle[] = [];
  private puffParticles: Particle[] = [];
  private poofT = 0;

  constructor(private readonly res: EmoteResources) {
    this.group.name = 'emotes';
    this.group.userData = { pickable: false };
    this.thumb = this.sprite('thumb', THUMB_SIZE.w, THUMB_SIZE.h);
    this.hourglass = this.sprite('hourglass0', HOURGLASS_SIZE.w, HOURGLASS_SIZE.h);
    this.exclaim = this.sprite('exclaim', EXCLAIM_SIZE.w, EXCLAIM_SIZE.h);
    this.drop = this.sprite('drop', 0.1, 0.13);
    for (let i = 0; i < ZZZ_COUNT; i++) this.zeds.push(this.sprite('zed', 0.15, 0.15));
    this.confettiMaterial = this.quadMaterial();
    this.confetti = this.instanced(this.confettiMaterial, CONFETTI_COUNT);
    this.puffMaterial = this.quadMaterial();
    this.puff = this.instanced(this.puffMaterial, POOF_COUNT);
  }

  setPose(pose: Pose): void {
    if (pose === this.pose && pose !== 'celebrate') return;
    this.pose = pose;
    this.poseT = 0;
    this.hourglassIndex = -1;
    this.hideAll();
    if (pose === 'celebrate') {
      this.confettiParticles = spawnConfetti();
      this.confetti.count = this.confettiParticles.length;
      for (let i = 0; i < this.confettiParticles.length; i++) {
        const p = this.confettiParticles[i];
        if (p) this.confetti.setColorAt(i, _c.setHex(p.color));
      }
      if (this.confetti.instanceColor) this.confetti.instanceColor.needsUpdate = true;
    }
  }

  poof(): void {
    this.poofT = POOF_S;
    this.puffParticles = spawnPoof();
    this.puff.count = this.puffParticles.length;
    for (let i = 0; i < this.puffParticles.length; i++) {
      const p = this.puffParticles[i];
      if (p) this.puff.setColorAt(i, _c.setHex(p.color));
    }
    if (this.puff.instanceColor) this.puff.instanceColor.needsUpdate = true;
  }

  update(dt: number, f: EmoteFrame): void {
    this.t += dt;
    this.poseT += dt;
    const s = f.scale;
    const H = f.headTop;
    const R = SCREEN_RIGHT;
    switch (this.pose) {
      case 'celebrate': {
        const th = thumbsUp(this.poseT);
        this.thumb.visible = th.visible;
        if (th.visible) {
          this.thumb.material.opacity = th.alpha;
          this.thumb.position.set(0, H + (ABOVE_LABEL + th.bob) * s, 0);
        }
        if (this.poseT < CELEBRATE_S && this.confettiParticles.length > 0) {
          stepParticles(this.confettiParticles, dt, CONFETTI_GRAVITY);
          this.confettiMaterial.opacity = confettiAlpha(this.poseT);
          this.writeQuads(
            this.confetti,
            this.confettiParticles,
            H - CONFETTI_DOWN * s,
            CONFETTI_QUAD * s,
            f.cameraQuaternion,
          );
          this.confetti.visible = true;
        } else {
          this.confetti.visible = false;
          this.confettiParticles.length = 0;
        }
        break;
      }
      case 'raise_hand': {
        const { scale, bob } = exclaimPulse(this.poseT);
        this.exclaim.visible = true;
        this.exclaim.scale.set(EXCLAIM_SIZE.w * s * scale, EXCLAIM_SIZE.h * s * scale, 1);
        this.exclaim.position.set(0, H + (ABOVE_LABEL + bob) * s, 0);
        break;
      }
      case 'sweat': {
        const d = sweatDrop(this.poseT);
        this.drop.visible = true;
        this.drop.material.opacity = d.alpha;
        this.drop.scale.set(d.size * s, d.size * 1.3 * s, 1);
        const k = f.side * TEMPLE_RIGHT * s;
        this.drop.position.set(R.x * k, H + (-TEMPLE_DOWN + d.dy) * s, R.z * k);
        break;
      }
      case 'cooldown': {
        const frame = hourglassFrame(this.poseT);
        if (frame !== this.hourglassIndex) {
          this.hourglassIndex = frame;
          const key = `hourglass${frame % HOURGLASS_FRAMES}` as EmoteTextureKey;
          this.hourglass.material.map = this.res.texture(key);
          this.hourglass.material.needsUpdate = true;
        }
        this.hourglass.visible = true;
        const k = HOURGLASS_RIGHT * s;
        this.hourglass.position.set(R.x * k, H - HOURGLASS_DOWN * s, R.z * k);
        break;
      }
      case 'nap': {
        const glyphs = zzzGlyphs(this.poseT, f.side);
        for (const z of this.zeds) z.visible = false;
        for (const g of glyphs) {
          const z = this.zeds[g.index];
          if (!z) continue;
          z.visible = true;
          z.material.opacity = g.alpha;
          z.scale.set(g.size * s, g.size * s, 1);
          const k = g.dx * s;
          z.position.set(R.x * k, H + g.dy * s, R.z * k);
        }
        break;
      }
      default:
        break;
    }
    if (this.poofT > 0) {
      this.poofT = Math.max(0, this.poofT - dt);
      stepParticles(this.puffParticles, dt, 0);
      this.puffMaterial.opacity = poofAlpha(this.poofT);
      this.writeQuads(
        this.puff,
        this.puffParticles,
        POOF_HEIGHT * s,
        POOF_QUAD * s,
        f.cameraQuaternion,
      );
      this.puff.visible = this.poofT > 0;
    } else if (this.puff.visible) {
      this.puff.visible = false;
    }
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.confetti.dispose();
    this.puff.dispose();
    this.group.removeFromParent();
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private sprite(key: EmoteTextureKey, w: number, h: number): Sprite {
    const material = new SpriteMaterial({
      map: this.res.texture(key),
      transparent: true,
      depthWrite: false,
    });
    this.materials.push(material);
    const sprite = new Sprite(material);
    sprite.scale.set(w, h, 1);
    sprite.visible = false;
    sprite.userData = { pickable: false };
    this.group.add(sprite);
    return sprite;
  }

  private quadMaterial(): MeshBasicMaterial {
    const material = new MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      toneMapped: false,
    });
    this.materials.push(material);
    return material;
  }

  private instanced(material: MeshBasicMaterial, count: number): InstancedMesh {
    const mesh = new InstancedMesh(this.res.quad, material, count);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // Allocate the colour attribute now so `setColorAt` never has to on a later frame.
    for (let i = 0; i < count; i++) mesh.setColorAt(i, _c.setHex(0xffffff));
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData = { pickable: false };
    this.group.add(mesh);
    return mesh;
  }

  /** Particle offsets are (screen-right, up); write them as camera-facing quads of `size`. */
  private writeQuads(
    mesh: InstancedMesh,
    particles: Particle[],
    baseY: number,
    size: number,
    q: Quaternion,
  ): void {
    _s.set(size, size, 1);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      if (!p) continue;
      _p.set(SCREEN_RIGHT.x * p.x, baseY + p.y, SCREEN_RIGHT.z * p.x);
      _m.compose(_p, q, _s);
      mesh.setMatrixAt(i, _m);
    }
    mesh.count = particles.length;
    mesh.instanceMatrix.needsUpdate = true;
  }

  private hideAll(): void {
    this.thumb.visible = false;
    this.hourglass.visible = false;
    this.exclaim.visible = false;
    this.drop.visible = false;
    for (const z of this.zeds) z.visible = false;
    this.confetti.visible = false;
    this.confettiParticles.length = 0;
  }
}
