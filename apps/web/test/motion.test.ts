import { describe, expect, it } from 'vitest';
import {
  advanceMotion,
  buildMotion,
  easeTrapezoid,
  SPEED_TILES_PER_S,
} from '../src/game/motion.js';

describe('motion', () => {
  it('easeTrapezoid is monotonic, continuous and normalised', () => {
    const r = 0.2;
    let prev = 0;
    for (let i = 0; i <= 100; i++) {
      const u = i / 100;
      const v = easeTrapezoid(u, r);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
    expect(easeTrapezoid(0, r)).toBe(0);
    expect(easeTrapezoid(1, r)).toBeCloseTo(1, 12);
    // Join points between the ramp and cruise phases are continuous.
    expect(easeTrapezoid(r - 1e-9, r)).toBeCloseTo(easeTrapezoid(r + 1e-9, r), 6);
    expect(easeTrapezoid(1 - r - 1e-9, r)).toBeCloseTo(easeTrapezoid(1 - r + 1e-9, r), 6);
    expect(easeTrapezoid(0.5, 0)).toBe(0.5);
  });

  it('builds cumulative lengths with √2 diagonals and a speed-based duration', () => {
    const m = buildMotion([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
    ]);
    expect(m.cum).toEqual([0, 1, 1 + Math.SQRT2]);
    expect(m.total).toBeCloseTo(1 + Math.SQRT2);
    expect(m.duration).toBeCloseTo((1 + Math.SQRT2) / SPEED_TILES_PER_S);
  });

  it('advances along the polyline and reports the segment being walked', () => {
    const m = buildMotion([
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
    ]);
    const a = advanceMotion(m, m.duration * 0.25);
    expect(a?.done).toBe(false);
    expect(a?.from).toEqual({ x: 0, y: 0 });
    expect(a?.to).toEqual({ x: 2, y: 0 });
    expect(a?.y).toBe(0);
    expect(a?.x).toBeGreaterThan(0);
    const b = advanceMotion(m, m.duration * 0.5);
    expect(b?.from).toEqual({ x: 2, y: 0 });
    expect(b?.to).toEqual({ x: 2, y: 2 });
    expect(b?.x).toBe(2);
    const c = advanceMotion(m, m.duration);
    expect(c?.done).toBe(true);
    expect([c?.x, c?.y]).toEqual([2, 2]);
  });

  it('handles a degenerate single-point motion', () => {
    const m = buildMotion([{ x: 1, y: 1 }]);
    const s = advanceMotion(m, 1);
    expect(s?.done).toBe(true);
    expect([s?.x, s?.y]).toEqual([1, 1]);
  });
});
