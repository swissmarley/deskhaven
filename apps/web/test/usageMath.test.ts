import { emptyUsage } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { firedAgentsToday } from '../src/ui/usageMath.js';

const cost = (costUsd: number) => ({ ...emptyUsage(), costUsd });

describe('firedAgentsToday', () => {
  it('is the part of the office total for today that no agent on staff accounts for', () => {
    expect(
      firedAgentsToday({ today: cost(0.6996), perAgentToday: { a: cost(0.4), b: cost(0.1) } }),
    ).toBeCloseTo(0.1996, 9);
  });

  it('reads rounding noise and older servers as nothing', () => {
    expect(firedAgentsToday({ today: cost(0.5), perAgentToday: { a: cost(0.49999) } })).toBe(0);
    expect(firedAgentsToday({ today: cost(0.5) })).toBe(0);
    expect(firedAgentsToday(null)).toBe(0);
  });
});
