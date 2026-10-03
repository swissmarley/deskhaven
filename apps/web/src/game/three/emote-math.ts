/**
 * Timing and particle maths for the in-scene emotes (`emotes.ts`), mirroring the Pixi overlays in
 * `pixi/avatar.ts` with the same periods and life times. Everything is a pure function of time (or
 * a plain particle array), in world units (1 unit = 1 tile); the Pixi pixel values were converted
 * with 45.25 px per unit horizontally and 39.2 px per unit of height.
 */

/** Pixi palette, kept verbatim. */
export const CONFETTI_COLORS = [0xff595e, 0xffca3a, 0x8ac926, 0x1982c4, 0x6a4c93, 0xffffff];
export const POOF_COLORS = [0xffffff, 0xe8ecf1, 0xd7dde6];
export const SWEAT_COLOR = 0x4cc9f0;
export const SAND_COLOR = 0xf4c15d;
export const GLASS_COLOR = 0xdbeafe;
export const HOURGLASS_FRAME_COLOR = 0x8d5a2b;
export const ZZZ_COLOR = 0xdfe7ef;
export const EXCLAIM_COLOR = 0xff3b30;
export const OUTLINE_COLOR = 0x101418;
/** Faint blue cast while rate-limited (the Pixi tint); the rig applies it as a weak emissive. */
export const COOLDOWN_TINT = 0xb9d0ff;
export const COOLDOWN_EMISSIVE = 0x3b66ff;
export const COOLDOWN_EMISSIVE_INTENSITY = 0.22;

export const CONFETTI_COUNT = 30;
export const CELEBRATE_S = 1.5;
export const POOF_COUNT = 6;
export const POOF_S = 0.5;
export const SWEAT_LOOP_S = 0.8;
export const HOURGLASS_FRAME_S = 0.45;
export const HOURGLASS_FRAMES = 3;
export const ZZZ_LIFE_S = 2.4;
export const ZZZ_GAP_S = 0.8;
export const ZZZ_COUNT = 3;
/** Pulse rate of the raise-hand "!" (Hz) and its scale range (1.0 → 1.15 in Pixi). */
export const EXCLAIM_PULSE_HZ = 2;

/** Gravity for confetti in world units/s² (Pixi: 320 px/s² at 39.2 px per unit). */
export const CONFETTI_GRAVITY = 8.2;

/**
 * Screen-right in world space for the fixed isometric camera (yaw 45°): the camera's right vector
 * is (1, 0, −1)/√2 (`three/camera.ts`). Emote offsets "beside the head" use it so they never rotate
 * with the avatar.
 */
export const SCREEN_RIGHT = { x: Math.SQRT1_2, z: -Math.SQRT1_2 } as const;

/**
 * Which screen side an avatar faces for a yaw (local +Z → world (sin θ, cos θ)): +1 when the facing
 * points screen-right. Matches Pixi's `FACING_DIR[facing][0] >= 0` for the four cardinal facings.
 */
export function screenSide(yaw: number): 1 | -1 {
  const dx = Math.sin(yaw);
  const dz = Math.cos(yaw);
  return dx * SCREEN_RIGHT.x + dz * SCREEN_RIGHT.z >= 0 ? 1 : -1;
}

// ---- sweat ----------------------------------------------------------------------------------------

export interface SweatDrop {
  /** 0 → 1 while the drop forms at the temple. */
  grow: number;
  /** 0 → 1 while it falls. */
  fall: number;
  /** Vertical offset from the temple in world units (≤ 0). */
  dy: number;
  alpha: number;
  /** Sprite size in world units. */
  size: number;
}

/** Sweat drop state at time `t`: forms over the first 30 % of the loop, falls with gravity, fades. */
export function sweatDrop(t: number, loopS = SWEAT_LOOP_S): SweatDrop {
  const ph = (((t / loopS) % 1) + 1) % 1;
  const grow = Math.min(1, ph / 0.3);
  const fall = Math.max(0, (ph - 0.3) / 0.7);
  const dy = 0 - fall * fall * 0.46;
  const alpha = fall > 0.6 ? 1 - (fall - 0.6) / 0.4 : 1;
  return { grow, fall, dy, alpha, size: 0.08 + 0.05 * grow };
}

// ---- hourglass ------------------------------------------------------------------------------------

/** Which of the three sand frames shows at time `t` (0.45 s each, cycling). */
export function hourglassFrame(t: number, frameS = HOURGLASS_FRAME_S): number {
  const i = Math.floor(Math.max(0, t) / frameS) % HOURGLASS_FRAMES;
  return i < 0 ? i + HOURGLASS_FRAMES : i;
}

// ---- zzz ------------------------------------------------------------------------------------------

export interface ZzzGlyph {
  index: number;
  /** 0 → 1 over the glyph's life. */
  phase: number;
  size: number;
  /** Offset along screen-right (signed by the facing side) and up, in world units. */
  dx: number;
  dy: number;
  alpha: number;
}

/**
 * The "z" glyphs alive at time `t` since the nap began: three launched `ZZZ_GAP_S` apart, each
 * looping over `ZZZ_LIFE_S` while rising, growing, weaving and fading.
 */
export function zzzGlyphs(t: number, side: 1 | -1 = 1): ZzzGlyph[] {
  const out: ZzzGlyph[] = [];
  for (let i = 0; i < ZZZ_COUNT; i++) {
    const life = t - i * ZZZ_GAP_S;
    if (life < 0) continue;
    const ph = (life % ZZZ_LIFE_S) / ZZZ_LIFE_S;
    out.push({
      index: i,
      phase: ph,
      size: 0.1 + ph * 0.12,
      dx: side * (0.18 + ph * 0.22) + Math.sin(ph * Math.PI * 4) * 0.045,
      dy: 0.1 + ph * 0.7,
      alpha: ph < 0.1 ? ph / 0.1 : ph > 0.6 ? (1 - ph) / 0.4 : 1,
    });
  }
  return out;
}

// ---- raise hand / celebrate -----------------------------------------------------------------------

/** Scale and bob of the pulsing "!" at `t` seconds into the pose (Pixi: 1.0 → 1.15 at 2 Hz). */
export function exclaimPulse(t: number): { scale: number; bob: number } {
  return {
    scale: 1.075 + 0.075 * Math.sin(t * Math.PI * 2 * EXCLAIM_PULSE_HZ),
    bob: Math.sin(t * 6) * 0.05,
  };
}

/** Thumbs-up visibility: fades in over 0.1 s, out over the last 0.3 s of `CELEBRATE_S`, bobs. */
export function thumbsUp(t: number): { visible: boolean; alpha: number; bob: number } {
  if (t < 0 || t >= CELEBRATE_S) return { visible: false, alpha: 0, bob: 0 };
  const alpha = Math.max(0, Math.min(1, t / 0.1, (CELEBRATE_S - t) / 0.3));
  return { visible: true, alpha, bob: Math.sin(t * Math.PI * 2 * 3) * 0.04 };
}

// ---- particles ------------------------------------------------------------------------------------

export interface Particle {
  /** Offset along screen-right and up from the spawn point, world units. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;
}

export type Rng = () => number;

/** Confetti burst at the head: spread sideways, launched upwards, coloured round-robin. */
export function spawnConfetti(count = CONFETTI_COUNT, rng: Rng = Math.random): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: (rng() - 0.5) * 0.22,
      y: 0,
      vx: (rng() - 0.5) * 3.1,
      vy: 2.0 + rng() * 3.0,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length] ?? 0xffffff,
    });
  }
  return out;
}

/** Integrate particles by `dt` seconds under `gravity` (world units/s², pulling down). */
export function stepParticles(particles: Particle[], dt: number, gravity: number): void {
  for (const p of particles) {
    p.vy -= gravity * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

/** Confetti opacity `t` seconds into the celebration (linear fade over `CELEBRATE_S`). */
export function confettiAlpha(t: number): number {
  return Math.max(0, Math.min(1, 1 - t / CELEBRATE_S));
}

/** Poof: a ring of light motes around the chest drifting outwards and slightly up. */
export function spawnPoof(count = POOF_COUNT, rng: Rng = Math.random): Particle[] {
  const out: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.6;
    // Pixi spawns at (cos a × 4, sin a × 6) px with velocity (cos a × 36, sin a × 30 − 14) px/s,
    // y down; here y is up.
    out.push({
      x: Math.cos(a) * 0.09,
      y: -Math.sin(a) * 0.15,
      vx: Math.cos(a) * 0.8,
      vy: -Math.sin(a) * 0.75 + 0.35,
      color: POOF_COLORS[i % POOF_COLORS.length] ?? 0xffffff,
    });
  }
  return out;
}

/** Poof opacity with `remaining` seconds of `POOF_S` left. */
export function poofAlpha(remaining: number): number {
  return Math.max(0, Math.min(1, remaining / POOF_S));
}

/** Monitor glow strength at time `t`: Pixi's irregular flicker from two incommensurate sines. */
export function screenFlicker(t: number): number {
  return 0.3 + 0.3 * Math.abs(Math.sin(t * 23) * Math.sin(t * 7));
}
