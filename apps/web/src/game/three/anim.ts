import { SPEED_TILES_PER_S } from '../motion.js';
import type { Pose } from '../pose.js';

/**
 * Pose → animation state machine for the rigged characters: pure data and maths, no three.js, so
 * the whole table is testable under Node and lives in one place.
 *
 * A pose resolves to one base clip from `rogue.glb` (`animationFor`), optionally plus a procedural
 * **overlay** (`evaluateOverlay`: bone rotation deltas as a function of time) and a **prop**. The
 * rig applies the overlay after the mixer has written the clip pose, by multiplying the listed bones'
 * orientations with the deltas, so no rest-pose bookkeeping is needed. No CC0 pack ships office
 * clips (typing, reading, napping at a desk), hence this hybrid (ARCHITECTURE §11.4).
 *
 * ## Delta convention
 *
 * A `BoneDelta` is an intrinsic XYZ Euler rotation (radians) **in the character frame** — +Y up,
 * +Z the character's front, +X the character's *left* — applied about the bone's own pivot. In that
 * frame, for an arm hanging straight down: a negative X delta swings it forward, a positive Z delta
 * lifts it out to the character's left (negative to the right) and Y turns it once it points forward.
 * For the head, a positive X delta tilts the face down. Three's 'XYZ' order applies Z first, then Y,
 * then X, so "Z then X" (lift sideways, then swing) is the natural way to read the tables. Values were
 * tuned numerically against the clip poses (`Idle` / `Sit_Chair_Idle` at t = 0): the hands land in
 * front of the body at desk height for `typing`, under the chin for `reading`, beside the jaw for
 * `scratch` / `sip` (the chibi's arms cannot reach the front of a head that sits on the shoulders)
 * and beside the head at eye height for `raise`.
 *
 * ## Why no `Spellcast_Raise`
 *
 * The clip was measured: at its last frame the hands are back at the idle hang (y 0.73 model units),
 * so a `once-hold` of it would hold an idle pose. `Idle` + the `raise` overlay holds the arm up for
 * as long as the behaviour lasts, which is what a permission prompt needs.
 */

export type ClipName = 'Idle' | 'Walking_A' | 'Sit_Chair_Idle' | 'Interact' | 'Cheer';

/** Every clip the rig keeps an action for; anything else in the GLB is ignored (and can be stripped). */
export const USED_CLIPS: readonly ClipName[] = [
  'Idle',
  'Walking_A',
  'Sit_Chair_Idle',
  'Interact',
  'Cheer',
];

export type OverlayKind =
  | 'typing'
  | 'reading'
  | 'scratch'
  | 'raise'
  | 'slump'
  | 'nap'
  | 'sip'
  | 'cheer';

export const OVERLAY_KINDS: readonly OverlayKind[] = [
  'typing',
  'reading',
  'scratch',
  'raise',
  'slump',
  'nap',
  'sip',
  'cheer',
];

export type PropKind = 'book' | 'mug';

export type LoopMode = 'repeat' | 'once-hold';

export interface AnimationSpec {
  clip: ClipName;
  loop: LoopMode;
  timeScale: number;
  overlay: OverlayKind | null;
  prop: PropKind | null;
}

export interface AnimationContext {
  seated: boolean;
  /** The avatar's position is changing this frame (the core sets `walk` itself; this is a safety net). */
  moving: boolean;
  /** Tiles the character covers per `Walking_A` cycle at its current scale; sets the walk time scale. */
  strideTilesPerCycle?: number;
}

/** Every member of the `Pose` union, for exhaustive tests. */
export const ALL_POSES: readonly Pose[] = [
  'idle',
  'walk',
  'typing',
  'working',
  'reading',
  'terminal',
  'browsing',
  'thinking',
  'raise_hand',
  'sweat',
  'cooldown',
  'celebrate',
  'nap',
  'wait',
  'leave',
  'coffee',
];

// ---- walk speed -----------------------------------------------------------------------------------

/**
 * `Walking_A` is an in-place cycle of two steps; each foot travels 0.40 model units peak to peak
 * (measured: foot bone z from −0.241 to +0.160), so one cycle covers 0.80 model units.
 */
export const WALK_STRIDE_MODEL_UNITS = 0.8;
/** Duration of `Walking_A` (and `Idle`) in the GLB. */
export const WALK_CLIP_SECONDS = 1.0667;
/**
 * Playback rate caps. The avatars walk 2.5 tiles/s for a 1.45-unit body (≈ 1.7 body heights per
 * second, twice a brisk human walk), which would need a 5× cycle; above ~2.2× the legs blur into a
 * cartoon scurry, so the cap trades some foot slide for a believable cadence.
 */
export const MIN_WALK_TIME_SCALE = 0.5;
export const MAX_WALK_TIME_SCALE = 2.2;

/** Time scale that makes the feet cover `tilesPerSecond` with a `strideTilesPerCycle` stride. */
export function walkTimeScale(
  tilesPerSecond: number,
  strideTilesPerCycle: number,
  cycleSeconds = WALK_CLIP_SECONDS,
): number {
  if (!(strideTilesPerCycle > 0) || !(cycleSeconds > 0) || !Number.isFinite(tilesPerSecond))
    return 1;
  const raw = (Math.abs(tilesPerSecond) / strideTilesPerCycle) * cycleSeconds;
  return Math.min(MAX_WALK_TIME_SCALE, Math.max(MIN_WALK_TIME_SCALE, raw));
}

// ---- pose table -----------------------------------------------------------------------------------

function spec(
  clip: ClipName,
  overlay: OverlayKind | null = null,
  prop: PropKind | null = null,
  timeScale = 1,
  loop: LoopMode = 'repeat',
): AnimationSpec {
  return { clip, loop, timeScale, overlay, prop };
}

/**
 * The pose → clip/overlay/prop table. Seated avatars use `Sit_Chair_Idle` as the base of every
 * stationary pose (a standing clip would pop them out of the chair); standing ones use `Idle`.
 */
export function animationFor(pose: Pose, ctx: AnimationContext): AnimationSpec {
  const base: ClipName = ctx.seated ? 'Sit_Chair_Idle' : 'Idle';
  switch (pose) {
    case 'walk':
      return spec(
        'Walking_A',
        null,
        null,
        ctx.strideTilesPerCycle === undefined
          ? 1
          : walkTimeScale(SPEED_TILES_PER_S, ctx.strideTilesPerCycle),
      );
    case 'leave':
      // Standing at the door while fading out: keep walking out of the room.
      return spec('Walking_A');
    case 'idle':
    case 'wait':
      return ctx.moving ? spec('Walking_A') : spec(base);
    case 'typing':
    case 'working':
      return spec(base, 'typing');
    case 'reading':
      return spec(base, 'reading', 'book');
    case 'terminal':
    case 'browsing':
      // The server rack and the library PC are stand stations: `Interact` taps at a panel.
      return ctx.seated ? spec(base, 'typing') : spec('Interact');
    case 'thinking':
      return spec(base, 'scratch');
    case 'raise_hand':
      return spec(base, 'raise');
    case 'sweat':
    case 'cooldown':
      return spec(base, 'slump');
    case 'celebrate':
      // `Cheer` is a standing clip; a seated avatar throws its arms up instead.
      return ctx.seated ? spec(base, 'cheer') : spec('Cheer');
    case 'nap':
      return spec(base, 'nap');
    case 'coffee':
      return spec(base, 'sip', 'mug');
  }
}

// ---- overlays -------------------------------------------------------------------------------------

/** Bones an overlay may rotate, in parent-first order (the rig applies them in this order). */
export type OverlayBone =
  | 'chest'
  | 'head'
  | 'upperArmL'
  | 'lowerArmL'
  | 'handL'
  | 'upperArmR'
  | 'lowerArmR'
  | 'handR';

export const OVERLAY_BONES: readonly OverlayBone[] = [
  'chest',
  'head',
  'upperArmL',
  'lowerArmL',
  'handL',
  'upperArmR',
  'lowerArmR',
  'handR',
];

/** Intrinsic XYZ Euler rotation in radians, in the character frame (see the module comment). */
export interface BoneDelta {
  x: number;
  y: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Where a prop goes: parented to a hand slot for position, but oriented in the character frame
 * every frame (gravity-aligned) so a mug never turns upside down while the arm rotates. `offset`
 * is in model units from the slot, `tilt` the prop's rotation in the character frame.
 */
export interface PropPlacement {
  prop: PropKind;
  slot: 'handL' | 'handR';
  offset: Vec3;
  tilt: BoneDelta;
}

export interface OverlayPose {
  bones: Partial<Record<OverlayBone, BoneDelta>>;
  prop: PropPlacement | null;
}

/** Period of each overlay's motion in seconds, or null when it is a static hold (for tests). */
export const OVERLAY_PERIOD_S: Record<OverlayKind, number | null> = {
  typing: 1 / 3,
  reading: 1 / 0.3,
  scratch: 2.5,
  raise: null,
  slump: 1 / 0.3,
  nap: 4,
  sip: 5,
  cheer: 0.5,
};

const DEG = Math.PI / 180;

function deg(x = 0, y = 0, z = 0): BoneDelta {
  return { x: x * DEG, y: y * DEG, z: z * DEG };
}

function wave(hz: number, t: number, phase = 0): number {
  return Math.sin(2 * Math.PI * hz * t + phase);
}

/** Smoothstep 0 → 1 over [a, b]. */
function ramp(t: number, a: number, b: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/** The sip cycle: rest, raise the mug over 0.8 s, hold it at the mouth, lower it, rest. */
export function sipPhase(t: number): number {
  const u = ((t % 5) + 5) % 5;
  return ramp(u, 1.5, 2.3) - ramp(u, 3.7, 4.5);
}

/** Bone deltas (and prop placement) of an overlay at time `t` seconds. */
export function evaluateOverlay(kind: OverlayKind, t: number): OverlayPose {
  switch (kind) {
    case 'typing': {
      // Elbows in and forward, forearms level over the keyboard, hands tapping out of phase.
      const tap = wave(3, t);
      const tapR = wave(3, t, Math.PI);
      return {
        bones: {
          chest: deg(10),
          upperArmL: deg(-50, 0, -38),
          upperArmR: deg(-50, 0, 38),
          lowerArmL: deg(-10 + 3 * tap, 8),
          lowerArmR: deg(-10 + 3 * tapR, -8),
          handL: deg(10 * tap),
          handR: deg(10 * tapR),
        },
        prop: null,
      };
    }
    case 'reading':
      // Both arms forward holding the book under the chin, head tilted down ~20° with a slow nod.
      return {
        bones: {
          head: deg(20 + 1.5 * wave(0.3, t)),
          upperArmL: deg(-55, 0, -30),
          upperArmR: deg(-55, 0, 30),
          lowerArmL: deg(-40),
          lowerArmR: deg(-40),
        },
        prop: {
          prop: 'book',
          slot: 'handL',
          offset: { x: -0.24, y: 0.03, z: 0.05 },
          tilt: deg(-20),
        },
      };
    case 'scratch':
      // Right hand up to the side of the jaw, slow rub, head tilted towards it.
      return {
        bones: {
          head: deg(0, 0, -10 + 2 * wave(0.4, t)),
          upperArmR: deg(-85, 0, 10),
          lowerArmR: deg(-45 + 4 * wave(0.8, t), -35),
        },
        prop: null,
      };
    case 'raise':
      // Right arm out to the side then up: hand beside the head at eye height, held.
      return {
        bones: {
          upperArmR: deg(45, 0, -45),
          lowerArmR: deg(-40, 45, -80),
        },
        prop: null,
      };
    case 'slump':
      // Chest and head sag forward; a slow heavy breath.
      return {
        bones: {
          chest: deg(15 + 2 * wave(0.3, t)),
          head: deg(25),
        },
        prop: null,
      };
    case 'nap':
      // Head drooped and tilted, chest rising and falling slowly.
      return {
        bones: {
          chest: deg(10 + 3 * wave(0.25, t)),
          head: deg(35 + 2 * wave(0.25, t), 0, 10),
        },
        prop: null,
      };
    case 'sip': {
      // Rest with the mug at the hip, periodically raise it to the side of the mouth and tilt it in.
      const p = sipPhase(t);
      return {
        bones: {
          head: deg(0, 0, -8 * p),
          upperArmR: deg(-80 * p, 0, 10 * p),
          lowerArmR: deg(-60 * p, -20 * p),
        },
        prop: {
          prop: 'mug',
          slot: 'handR',
          offset: { x: 0, y: -0.04, z: 0 },
          tilt: deg(0, 0, -35 * p),
        },
      };
    }
    case 'cheer': {
      // Seated celebration: both arms up in a V, pumping.
      const pump = wave(2, t);
      return {
        bones: {
          head: deg(-10),
          upperArmL: deg(-80, 0, 60),
          upperArmR: deg(-80, 0, -60),
          lowerArmL: deg(-60 + 10 * pump),
          lowerArmR: deg(-60 + 10 * pump),
        },
        prop: null,
      };
    }
  }
}

/** Largest absolute angle component in an overlay pose (overlays are meant to stay under 90°). */
export function maxOverlayAngle(pose: OverlayPose): number {
  let max = 0;
  for (const d of Object.values(pose.bones)) {
    if (!d) continue;
    max = Math.max(max, Math.abs(d.x), Math.abs(d.y), Math.abs(d.z));
  }
  if (pose.prop)
    max = Math.max(
      max,
      Math.abs(pose.prop.tilt.x),
      Math.abs(pose.prop.tilt.y),
      Math.abs(pose.prop.tilt.z),
    );
  return max;
}
