import { describe, expect, it } from 'vitest';
import {
  CELEBRATE_S,
  CONFETTI_COLORS,
  CONFETTI_COUNT,
  CONFETTI_GRAVITY,
  confettiAlpha,
  exclaimPulse,
  HOURGLASS_FRAME_S,
  HOURGLASS_FRAMES,
  hourglassFrame,
  POOF_COLORS,
  POOF_COUNT,
  POOF_S,
  poofAlpha,
  SWEAT_LOOP_S,
  screenFlicker,
  screenSide,
  spawnConfetti,
  spawnPoof,
  stepParticles,
  sweatDrop,
  thumbsUp,
  ZZZ_COUNT,
  ZZZ_GAP_S,
  ZZZ_LIFE_S,
  zzzGlyphs,
} from '../src/game/three/emote-math.js';
import { facingYaw } from '../src/game/three/math.js';
import {
  DEGRADE_FPS,
  DEGRADE_HOLD_MS,
  DegradeMonitor,
  FpsMeter,
  formatStats,
  statsEnabled,
} from '../src/game/three/perf.js';

/** Deterministic rng for particle spawns. */
function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('sweatDrop', () => {
  it('forms at the temple, falls with gravity and fades, every 0.8 s', () => {
    expect(SWEAT_LOOP_S).toBe(0.8);
    const start = sweatDrop(0);
    expect(start.grow).toBe(0);
    expect(start.fall).toBe(0);
    expect(start.dy).toBe(0);
    expect(start.alpha).toBe(1);
    const formed = sweatDrop(0.3 * SWEAT_LOOP_S);
    expect(formed.grow).toBeCloseTo(1, 9);
    expect(formed.fall).toBeCloseTo(0, 9);
    // Falling: lower and lower, quadratically.
    const a = sweatDrop(0.5 * SWEAT_LOOP_S);
    const b = sweatDrop(0.7 * SWEAT_LOOP_S);
    const c = sweatDrop(0.9 * SWEAT_LOOP_S);
    expect(a.dy).toBeLessThan(0);
    expect(b.dy).toBeLessThan(a.dy);
    expect(c.dy).toBeLessThan(b.dy);
    expect(b.dy - a.dy).toBeGreaterThan(c.dy - b.dy); // accelerating downwards
    expect(c.alpha).toBeLessThan(1);
    expect(c.alpha).toBeGreaterThan(0);
  });

  it('is periodic and bounded', () => {
    for (let i = 0; i < 50; i++) {
      const t = i * 0.137;
      const d = sweatDrop(t);
      const again = sweatDrop(t + 3 * SWEAT_LOOP_S);
      expect(again.dy).toBeCloseTo(d.dy, 9);
      expect(again.alpha).toBeCloseTo(d.alpha, 9);
      expect(d.alpha).toBeGreaterThanOrEqual(0);
      expect(d.alpha).toBeLessThanOrEqual(1);
      expect(d.dy).toBeGreaterThanOrEqual(-0.46);
      expect(d.dy).toBeLessThanOrEqual(0);
      expect(d.size).toBeGreaterThan(0);
    }
  });
});

describe('hourglassFrame', () => {
  it('ticks through three frames every 0.45 s and wraps', () => {
    expect(HOURGLASS_FRAME_S).toBe(0.45);
    expect(HOURGLASS_FRAMES).toBe(3);
    expect(hourglassFrame(0)).toBe(0);
    expect(hourglassFrame(0.449)).toBe(0);
    expect(hourglassFrame(0.45)).toBe(1);
    expect(hourglassFrame(0.9)).toBe(2);
    expect(hourglassFrame(1.35)).toBe(0);
    expect(hourglassFrame(-1)).toBe(0);
    for (let i = 0; i < 100; i++) {
      const f = hourglassFrame(i * 0.3);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(HOURGLASS_FRAMES);
    }
  });
});

describe('zzzGlyphs', () => {
  it('launches three glyphs 0.8 s apart and loops each over 2.4 s', () => {
    expect(ZZZ_COUNT).toBe(3);
    expect(zzzGlyphs(0)).toHaveLength(1);
    expect(zzzGlyphs(ZZZ_GAP_S - 0.01)).toHaveLength(1);
    expect(zzzGlyphs(ZZZ_GAP_S)).toHaveLength(2);
    expect(zzzGlyphs(2 * ZZZ_GAP_S)).toHaveLength(3);
    expect(zzzGlyphs(100)).toHaveLength(3);
    const g = zzzGlyphs(0.5)[0];
    const later = zzzGlyphs(0.5 + ZZZ_LIFE_S)[0];
    expect(g).toBeDefined();
    expect(later).toBeDefined();
    if (!g || !later) return;
    expect(later.phase).toBeCloseTo(g.phase, 9);
    expect(later.dy).toBeCloseTo(g.dy, 9);
  });

  it('rises, grows and fades in then out, mirrored by the facing side', () => {
    const early = zzzGlyphs(0.1)[0];
    const mid = zzzGlyphs(1.0)[0];
    const late = zzzGlyphs(2.3)[0];
    if (!early || !mid || !late) throw new Error('glyphs');
    expect(early.alpha).toBeLessThan(1);
    expect(mid.alpha).toBe(1);
    expect(late.alpha).toBeLessThan(0.3);
    expect(mid.dy).toBeGreaterThan(early.dy);
    expect(late.dy).toBeGreaterThan(mid.dy);
    expect(mid.size).toBeGreaterThan(early.size);
    const left = zzzGlyphs(1.0, -1)[0];
    if (!left) throw new Error('glyph');
    expect(left.dx).toBeLessThan(0);
    expect(mid.dx).toBeGreaterThan(0);
    for (let i = 0; i < 60; i++)
      for (const z of zzzGlyphs(i * 0.11)) {
        expect(z.alpha).toBeGreaterThanOrEqual(0);
        expect(z.alpha).toBeLessThanOrEqual(1);
        expect(z.dy).toBeGreaterThanOrEqual(0.1);
        expect(z.dy).toBeLessThanOrEqual(0.8);
      }
  });
});

describe('exclaimPulse and thumbsUp', () => {
  it('pulses the "!" between 1.0 and 1.15 at 2 Hz', () => {
    expect(exclaimPulse(0).scale).toBeCloseTo(1.075, 9);
    expect(exclaimPulse(0.125).scale).toBeCloseTo(1.15, 9);
    expect(exclaimPulse(0.375).scale).toBeCloseTo(1.0, 9);
    expect(exclaimPulse(0.5).scale).toBeCloseTo(exclaimPulse(0).scale, 9);
    expect(Math.abs(exclaimPulse(1.3).bob)).toBeLessThanOrEqual(0.05);
  });

  it('shows the thumbs-up for 1.5 s with a fade in and out', () => {
    expect(CELEBRATE_S).toBe(1.5);
    expect(thumbsUp(-0.1).visible).toBe(false);
    expect(thumbsUp(0).alpha).toBe(0);
    expect(thumbsUp(0.05).alpha).toBeCloseTo(0.5, 9);
    expect(thumbsUp(0.5).alpha).toBe(1);
    expect(thumbsUp(CELEBRATE_S - 0.15).alpha).toBeCloseTo(0.5, 9);
    expect(thumbsUp(CELEBRATE_S).visible).toBe(false);
  });
});

describe('particles', () => {
  it('spawns 30 confetti in the Pixi palette, launched upwards and spread sideways', () => {
    const ps = spawnConfetti(CONFETTI_COUNT, lcg(7));
    expect(ps).toHaveLength(30);
    const colors = new Set(ps.map((p) => p.color));
    expect([...colors].every((c) => CONFETTI_COLORS.includes(c))).toBe(true);
    expect(colors.size).toBe(CONFETTI_COLORS.length);
    expect(ps.every((p) => p.vy > 0)).toBe(true);
    expect(ps.some((p) => p.vx < 0)).toBe(true);
    expect(ps.some((p) => p.vx > 0)).toBe(true);
  });

  it('integrates with gravity: rises, peaks, falls below the spawn point before the fade ends', () => {
    const ps = spawnConfetti(CONFETTI_COUNT, lcg(3));
    const dt = 1 / 60;
    let peak = Number.NEGATIVE_INFINITY;
    let steps = 0;
    for (let t = 0; t < CELEBRATE_S; t += dt) {
      stepParticles(ps, dt, CONFETTI_GRAVITY);
      steps++;
      for (const p of ps) peak = Math.max(peak, p.y);
    }
    expect(steps).toBeGreaterThan(80);
    expect(peak).toBeGreaterThan(0.2);
    // The slowest particle is well on its way down by the end of the celebration.
    const minVy = Math.min(...ps.map((p) => p.vy));
    expect(minVy).toBeLessThan(0);
    expect(ps.some((p) => p.y < 0)).toBe(true);
    expect(confettiAlpha(0)).toBe(1);
    expect(confettiAlpha(CELEBRATE_S / 2)).toBeCloseTo(0.5, 9);
    expect(confettiAlpha(CELEBRATE_S)).toBe(0);
    expect(confettiAlpha(10)).toBe(0);
  });

  it('spawns the poof ring in the light palette and fades over 0.5 s', () => {
    expect(POOF_S).toBe(0.5);
    const ps = spawnPoof(POOF_COUNT, lcg(11));
    expect(ps).toHaveLength(POOF_COUNT);
    expect(ps.every((p) => POOF_COLORS.includes(p.color))).toBe(true);
    // Drifts outwards: distance from the centre grows.
    const before = ps.map((p) => Math.hypot(p.x, p.y));
    stepParticles(ps, 0.3, 0);
    for (const [i, p] of ps.entries())
      expect(Math.hypot(p.x, p.y), `particle ${i}`).toBeGreaterThan(before[i] ?? 0);
    expect(poofAlpha(POOF_S)).toBe(1);
    expect(poofAlpha(POOF_S / 4)).toBeCloseTo(0.25, 9);
    expect(poofAlpha(0)).toBe(0);
  });
});

describe('screenSide and screenFlicker', () => {
  it('matches the Pixi facing sides: north and east face screen-right, south and west left', () => {
    expect(screenSide(facingYaw(0))).toBe(1);
    expect(screenSide(facingYaw(1))).toBe(1);
    expect(screenSide(facingYaw(2))).toBe(-1);
    expect(screenSide(facingYaw(3))).toBe(-1);
  });

  it('keeps the monitor flicker in [0.3, 0.6]', () => {
    for (let i = 0; i < 200; i++) {
      const f = screenFlicker(i * 0.037);
      expect(f).toBeGreaterThanOrEqual(0.3);
      expect(f).toBeLessThanOrEqual(0.6);
    }
  });
});

describe('FpsMeter and DegradeMonitor', () => {
  it('averages over the last second of frames', () => {
    const m = new FpsMeter();
    expect(m.fps).toBe(0);
    for (let i = 0; i < 120; i++) m.push(1000 / 60);
    expect(m.warm).toBe(true);
    expect(m.fps).toBeCloseTo(60, 0);
    for (let i = 0; i < 60; i++) m.push(1000 / 30);
    expect(m.fps).toBeCloseTo(30, 0);
  });

  it('degrades once after 3 s under 45 fps, resets on recovery, never fires twice', () => {
    const d = new DegradeMonitor();
    expect(DEGRADE_FPS).toBe(45);
    expect(DEGRADE_HOLD_MS).toBe(3000);
    // 2.9 s slow, then one fast frame: no degrade.
    for (let t = 0; t < 2900; t += 25) expect(d.sample(40, 25)).toBe(false);
    expect(d.sample(60, 16)).toBe(false);
    // Now 3 s slow: fires exactly once at the hold time.
    let fired = 0;
    for (let t = 0; t < 4000; t += 25) if (d.sample(30, 25)) fired++;
    expect(fired).toBe(1);
    expect(d.done).toBe(true);
    for (let t = 0; t < 4000; t += 25) expect(d.sample(10, 25)).toBe(false);
  });

  it('ignores a cold meter', () => {
    const d = new DegradeMonitor();
    for (let t = 0; t < 5000; t += 25) expect(d.sample(10, 25, false)).toBe(false);
  });

  it('enables the stats overlay from the URL or storage', () => {
    expect(statsEnabled('?stats=1', null)).toBe(true);
    expect(statsEnabled('?foo=1&stats=1', null)).toBe(true);
    expect(statsEnabled('?stats=0', null)).toBe(false);
    expect(statsEnabled('', '1')).toBe(true);
    expect(statsEnabled(undefined, undefined)).toBe(false);
    expect(
      formatStats({ fps: 59.6, calls: 120, triangles: 14700, avatars: 8, degraded: false }),
    ).toBe('60 fps · 120 calls · 14.7k tris · 8 avatars');
    expect(formatStats({ fps: 30, calls: 90, triangles: 900, avatars: 2, degraded: true })).toBe(
      '30 fps · 90 calls · 900 tris · 2 avatars · degraded',
    );
  });
});
