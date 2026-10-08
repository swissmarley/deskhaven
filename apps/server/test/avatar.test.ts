import { describe, expect, it } from 'vitest';
import { PALETTES, randomAvatar } from '../src/agents/service.js';

describe('randomAvatar', () => {
  it('spreads 10,000 avatars across every option of every field', () => {
    const N = 10_000;
    const avatars = Array.from({ length: N }, () => randomAvatar());
    const distinct = new Set(avatars.map((a) => JSON.stringify(a)));
    // 6 * 8 * 5 * 8 * 6 * 5 = 57,600 combinations: nearly every draw should be new.
    expect(distinct.size).toBeGreaterThan(N * 0.8);

    const fields = {
      skin: PALETTES.skin,
      hair: PALETTES.hair,
      shirt: PALETTES.shirt,
      pants: PALETTES.pants,
      hairStyle: ['short', 'long', 'cap', 'bald', 'bun'],
    } as const;
    for (const [field, options] of Object.entries(fields)) {
      const counts = new Map<string, number>();
      for (const a of avatars) {
        const v = String(a[field as keyof typeof a]);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      expect(counts.size, field).toBe(options.length);
      const expected = N / options.length;
      for (const [value, n] of counts) {
        // within ±20% of uniform (≈ 8 standard deviations for these sample sizes)
        expect(Math.abs(n - expected) / expected, `${field}=${value}`).toBeLessThan(0.2);
      }
    }
    const accessories = new Set(avatars.map((a) => a.accessory));
    expect(accessories.size).toBe(5);
  });

  it('is deterministic for a given seed and differs between nearby seeds', () => {
    expect(randomAvatar(0.123)).toEqual(randomAvatar(0.123));
    const near = new Set(
      Array.from({ length: 50 }, (_, i) => JSON.stringify(randomAvatar(0.5 + i * 1e-6))),
    );
    expect(near.size).toBeGreaterThan(40);
  });
});
