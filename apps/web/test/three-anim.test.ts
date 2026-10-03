import { describe, expect, it } from 'vitest';
import { SPEED_TILES_PER_S } from '../src/game/motion.js';
import type { Pose } from '../src/game/pose.js';
import {
  ALL_POSES,
  animationFor,
  evaluateOverlay,
  MAX_WALK_TIME_SCALE,
  MIN_WALK_TIME_SCALE,
  maxOverlayAngle,
  OVERLAY_BONES,
  OVERLAY_KINDS,
  OVERLAY_PERIOD_S,
  sipPhase,
  USED_CLIPS,
  WALK_CLIP_SECONDS,
  WALK_STRIDE_MODEL_UNITS,
  walkTimeScale,
} from '../src/game/three/anim.js';

/** Every member of the `Pose` union; the type assertion fails to compile if one is missing. */
const POSES: readonly Pose[] = ALL_POSES;
const EXPECTED_POSES: Record<Pose, true> = {
  idle: true,
  walk: true,
  typing: true,
  working: true,
  reading: true,
  terminal: true,
  browsing: true,
  thinking: true,
  raise_hand: true,
  sweat: true,
  cooldown: true,
  celebrate: true,
  nap: true,
  wait: true,
  leave: true,
  coffee: true,
};

describe('animationFor', () => {
  it('lists every pose exactly once', () => {
    expect([...POSES].sort()).toEqual(Object.keys(EXPECTED_POSES).sort());
  });

  it('maps every pose to a used clip, seated or standing, moving or not', () => {
    for (const pose of POSES)
      for (const seated of [false, true])
        for (const moving of [false, true]) {
          const spec = animationFor(pose, { seated, moving, strideTilesPerCycle: 0.53 });
          expect(USED_CLIPS, `${pose} seated=${seated}`).toContain(spec.clip);
          expect(Number.isFinite(spec.timeScale)).toBe(true);
          expect(spec.timeScale).toBeGreaterThan(0);
          if (spec.overlay) expect(OVERLAY_KINDS).toContain(spec.overlay);
        }
  });

  it('idles standing with Idle and seated with Sit_Chair_Idle', () => {
    expect(animationFor('idle', { seated: false, moving: false }).clip).toBe('Idle');
    expect(animationFor('idle', { seated: true, moving: false }).clip).toBe('Sit_Chair_Idle');
    expect(animationFor('wait', { seated: true, moving: false }).clip).toBe('Sit_Chair_Idle');
  });

  it('never pops a seated avatar into a standing clip', () => {
    for (const pose of POSES) {
      if (pose === 'walk' || pose === 'leave') continue;
      const spec = animationFor(pose, { seated: true, moving: false });
      expect(spec.clip, pose).toBe('Sit_Chair_Idle');
    }
  });

  it('walks with Walking_A at a positive finite time scale from the stride', () => {
    const spec = animationFor('walk', { seated: false, moving: true, strideTilesPerCycle: 0.53 });
    expect(spec.clip).toBe('Walking_A');
    expect(spec.timeScale).toBeGreaterThan(0);
    expect(Number.isFinite(spec.timeScale)).toBe(true);
    expect(spec.timeScale).toBeLessThanOrEqual(MAX_WALK_TIME_SCALE);
    // Without a stride the clip plays at its authored speed.
    expect(animationFor('walk', { seated: false, moving: true }).timeScale).toBe(1);
  });

  it('attaches the book to reading and the mug to coffee, nothing else', () => {
    for (const pose of POSES) {
      const spec = animationFor(pose, { seated: false, moving: false });
      if (pose === 'reading') expect(spec.prop).toBe('book');
      else if (pose === 'coffee') expect(spec.prop).toBe('mug');
      else expect(spec.prop, pose).toBeNull();
    }
  });

  it('uses the expected clip / overlay pairs for the office poses', () => {
    const standing = (pose: Pose) => animationFor(pose, { seated: false, moving: false });
    const seated = (pose: Pose) => animationFor(pose, { seated: true, moving: false });
    expect(seated('typing')).toMatchObject({ clip: 'Sit_Chair_Idle', overlay: 'typing' });
    expect(seated('working')).toMatchObject({ clip: 'Sit_Chair_Idle', overlay: 'typing' });
    expect(standing('reading')).toMatchObject({ clip: 'Idle', overlay: 'reading', prop: 'book' });
    expect(standing('terminal')).toMatchObject({ clip: 'Interact', overlay: null });
    expect(standing('browsing')).toMatchObject({ clip: 'Interact', overlay: null });
    expect(standing('thinking')).toMatchObject({ clip: 'Idle', overlay: 'scratch' });
    expect(standing('raise_hand')).toMatchObject({ clip: 'Idle', overlay: 'raise' });
    expect(standing('sweat')).toMatchObject({ overlay: 'slump' });
    expect(standing('cooldown')).toMatchObject({ overlay: 'slump' });
    expect(standing('celebrate')).toMatchObject({ clip: 'Cheer', overlay: null });
    expect(seated('celebrate')).toMatchObject({ clip: 'Sit_Chair_Idle', overlay: 'cheer' });
    expect(seated('nap')).toMatchObject({ clip: 'Sit_Chair_Idle', overlay: 'nap' });
    expect(standing('coffee')).toMatchObject({ clip: 'Idle', overlay: 'sip', prop: 'mug' });
    expect(standing('leave')).toMatchObject({ clip: 'Walking_A' });
    expect(standing('wait')).toMatchObject({ clip: 'Idle', overlay: null });
  });
});

describe('walkTimeScale', () => {
  it('scales the clip so the feet cover the walking speed, within the caps', () => {
    // 2.5 tiles/s over a 0.53-tile cycle needs ~5× — capped.
    expect(walkTimeScale(SPEED_TILES_PER_S, 0.53)).toBe(MAX_WALK_TIME_SCALE);
    // One cycle per second at exactly one stride per second plays at 1× for a 1 s clip.
    expect(walkTimeScale(1, 1, 1)).toBe(1);
    expect(walkTimeScale(0.8, 0.53)).toBeCloseTo((0.8 / 0.53) * WALK_CLIP_SECONDS, 9);
    expect(walkTimeScale(0.01, 0.53)).toBe(MIN_WALK_TIME_SCALE);
  });

  it('is positive and finite for degenerate input', () => {
    for (const v of [
      walkTimeScale(2.5, 0),
      walkTimeScale(Number.NaN, 0.5),
      walkTimeScale(2.5, 0.5, 0),
    ]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(WALK_STRIDE_MODEL_UNITS).toBeGreaterThan(0);
  });
});

describe('overlays', () => {
  const TIMES = Array.from({ length: 101 }, (_, i) => i / 10);

  it('keeps every bone angle under 90° for t in [0, 10]', () => {
    for (const kind of OVERLAY_KINDS)
      for (const t of TIMES) {
        const pose = evaluateOverlay(kind, t);
        expect(maxOverlayAngle(pose), `${kind} @ ${t}`).toBeLessThan(Math.PI / 2);
        for (const bone of Object.keys(pose.bones)) expect(OVERLAY_BONES).toContain(bone);
      }
  });

  it('is smooth: a 1 ms step never moves a bone more than 0.02 rad', () => {
    for (const kind of OVERLAY_KINDS)
      for (const t of TIMES) {
        const a = evaluateOverlay(kind, t);
        const b = evaluateOverlay(kind, t + 0.001);
        for (const bone of OVERLAY_BONES) {
          const da = a.bones[bone];
          const db = b.bones[bone];
          if (!da || !db) {
            expect(da, `${kind} ${bone} appears/disappears over time`).toBe(db);
            continue;
          }
          const step = Math.max(
            Math.abs(da.x - db.x),
            Math.abs(da.y - db.y),
            Math.abs(da.z - db.z),
          );
          expect(step, `${kind} ${bone} @ ${t}`).toBeLessThan(0.02);
        }
      }
  });

  it('repeats with its declared period (or holds still)', () => {
    for (const kind of OVERLAY_KINDS) {
      const period = OVERLAY_PERIOD_S[kind];
      for (const t of [0.1, 1.3, 4.7]) {
        const a = evaluateOverlay(kind, t);
        const b = evaluateOverlay(kind, period === null ? t + 3.21 : t + period);
        for (const bone of OVERLAY_BONES) {
          const da = a.bones[bone];
          const db = b.bones[bone];
          if (!da || !db) continue;
          expect(da.x, `${kind} ${bone}`).toBeCloseTo(db.x, 6);
          expect(da.y, `${kind} ${bone}`).toBeCloseTo(db.y, 6);
          expect(da.z, `${kind} ${bone}`).toBeCloseTo(db.z, 6);
        }
      }
    }
  });

  it('types with the hands out of phase and the raise holding still', () => {
    const a = evaluateOverlay('typing', 0.05);
    expect(a.bones.handL?.x ?? 0).toBeCloseTo(-(a.bones.handR?.x ?? 0), 9);
    expect(Math.abs(a.bones.handL?.x ?? 0)).toBeGreaterThan(0.05);
    expect(evaluateOverlay('raise', 0)).toEqual(evaluateOverlay('raise', 7.3));
    expect(evaluateOverlay('raise', 0).bones.upperArmR).toBeDefined();
    expect(evaluateOverlay('raise', 0).bones.upperArmL).toBeUndefined();
  });

  it('places the book in the left hand and the mug in the right, gravity-aligned', () => {
    expect(evaluateOverlay('reading', 0).prop).toMatchObject({ prop: 'book', slot: 'handL' });
    expect(evaluateOverlay('sip', 0).prop).toMatchObject({ prop: 'mug', slot: 'handR' });
    expect(evaluateOverlay('typing', 0).prop).toBeNull();
    // The reader looks down ~20°.
    expect(evaluateOverlay('reading', 0).bones.head?.x ?? 0).toBeCloseTo((20 * Math.PI) / 180, 1);
  });

  it('sips in a rest / raise / hold / lower cycle', () => {
    expect(sipPhase(0)).toBe(0);
    expect(sipPhase(1)).toBe(0);
    expect(sipPhase(3)).toBe(1);
    expect(sipPhase(4.9)).toBe(0);
    expect(sipPhase(2.0)).toBeGreaterThan(0.2);
    expect(sipPhase(2.0)).toBeLessThan(1);
    // The mug tilts towards the mouth only at the top.
    expect(Math.abs(evaluateOverlay('sip', 0).prop?.tilt.z ?? 1)).toBe(0);
    expect(evaluateOverlay('sip', 3).prop?.tilt.z ?? 0).toBeLessThan(0);
  });
});
