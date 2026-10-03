import type { Facing } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import { type Facing8, facing8FromDelta, facing8Of, yawFor8 } from '../src/game/iso.js';
import {
  approachYaw,
  facingDirection,
  facingYaw,
  normalizeYaw,
  TURN_RATE,
  yawDelta,
} from '../src/game/three/math.js';

const S = Math.SQRT1_2;

describe('facing8FromDelta', () => {
  it('maps the 8 directions clockwise from north', () => {
    const cases: [number, number, Facing8][] = [
      [0, -1, 0], // N
      [1, -1, 1], // NE
      [1, 0, 2], // E
      [1, 1, 3], // SE
      [0, 1, 4], // S
      [-1, 1, 5], // SW
      [-1, 0, 6], // W
      [-1, -1, 7], // NW
    ];
    for (const [dx, dy, want] of cases) {
      expect(facing8FromDelta(dx, dy), `${dx},${dy}`).toBe(want);
      // Scale does not matter, nor does a small wobble around the exact direction.
      expect(facing8FromDelta(dx * 0.01, dy * 0.01)).toBe(want);
      expect(facing8FromDelta(dx + 0.1 * dy, dy - 0.1 * dx)).toBe(want);
    }
  });

  it('treats a zero delta as south (the default facing)', () => {
    expect(facing8FromDelta(0, 0)).toBe(4);
    expect(facing8FromDelta(-0, 0)).toBe(4);
  });

  it('agrees with the 4-way cardinal facings', () => {
    for (const facing of [0, 1, 2, 3] as Facing[]) {
      const dir = facingDirection(facing);
      expect(facing8FromDelta(dir.x, dir.z)).toBe(facing8Of(facing));
    }
  });
});

describe('yawFor8', () => {
  it('matches facingYaw for the four cardinal facings', () => {
    for (const facing of [0, 1, 2, 3] as Facing[])
      expect(yawFor8(facing8Of(facing))).toBeCloseTo(facingYaw(facing), 12);
  });

  it('turns local +Z onto each of the 8 world directions', () => {
    const dirs: [number, number][] = [
      [0, -1],
      [S, -S],
      [1, 0],
      [S, S],
      [0, 1],
      [-S, S],
      [-1, 0],
      [-S, -S],
    ];
    dirs.forEach(([x, z], f8) => {
      const yaw = yawFor8(f8 as Facing8);
      expect(Math.sin(yaw), `f8 ${f8} x`).toBeCloseTo(x, 9);
      expect(Math.cos(yaw), `f8 ${f8} z`).toBeCloseTo(z, 9);
    });
  });
});

describe('approachYaw', () => {
  it('converges to the target without overshooting, along the shortest arc', () => {
    const pairs: [number, number][] = [
      [0, Math.PI / 2],
      [Math.PI / 2, -Math.PI / 2],
      [-3, 3],
      [2.9, -2.9],
      [facingYaw(0), facingYaw(1)],
      [0, 0],
    ];
    for (const [from, to] of pairs) {
      let yaw = from;
      const initial = yawDelta(from, to);
      let last = Math.abs(initial);
      for (let i = 0; i < 200; i++) {
        const next = approachYaw(yaw, to, 1 / 60);
        const remaining = yawDelta(next, to);
        // Never overshoots: the remaining turn keeps its sign (or reaches zero) and shrinks.
        if (initial !== 0) expect(Math.sign(remaining) * Math.sign(initial)).not.toBe(-1);
        expect(Math.abs(remaining)).toBeLessThanOrEqual(last + 1e-12);
        last = Math.abs(remaining);
        yaw = next;
      }
      expect(Math.abs(yawDelta(yaw, to))).toBeLessThan(1e-3);
      expect(yaw).toBeGreaterThan(-Math.PI - 1e-9);
      expect(yaw).toBeLessThanOrEqual(Math.PI + 1e-9);
    }
  });

  it('closes most of the gap within a quarter second and snaps on huge steps', () => {
    let yaw = 0;
    for (let i = 0; i < 15; i++) yaw = approachYaw(yaw, Math.PI / 2, 1 / 60);
    expect(yaw / (Math.PI / 2)).toBeGreaterThan(0.9);
    expect(approachYaw(0, 1, 10)).toBeCloseTo(1, 12);
    expect(approachYaw(0, 1, 1 / TURN_RATE)).toBeCloseTo(1, 12);
    expect(approachYaw(1, 1, 0.016)).toBe(1);
  });

  it('wraps yaws into (−π, π]', () => {
    expect(normalizeYaw(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeYaw(-Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(normalizeYaw(0.5)).toBeCloseTo(0.5, 12);
    expect(normalizeYaw(-2 * Math.PI + 0.25)).toBeCloseTo(0.25, 12);
  });
});
