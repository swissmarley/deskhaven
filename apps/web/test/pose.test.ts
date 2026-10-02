import type { Behavior, BehaviorKind } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import { type Pose, poseFor } from '../src/game/pose.js';

/** One behaviour per kind; the `Record` keeps this exhaustive when `Behavior` grows. */
const SAMPLES: Record<BehaviorKind, Behavior> = {
  idle: { kind: 'idle', variant: 'wander' },
  thinking: { kind: 'thinking' },
  reading: { kind: 'reading', label: 'README.md' },
  typing: { kind: 'typing', label: 'index.ts' },
  terminal: { kind: 'terminal', command: 'npm test' },
  browsing: { kind: 'browsing', query: 'zod' },
  delegating: { kind: 'delegating', label: 'Explore' },
  working: { kind: 'working', label: 'planning' },
  raise_hand: { kind: 'raise_hand', reason: 'permission' },
  sweat: { kind: 'sweat', reason: 'error', message: '' },
  cooldown: { kind: 'cooldown' },
  celebrate: { kind: 'celebrate' },
  nap: { kind: 'nap' },
  wait: { kind: 'wait' },
  leave: { kind: 'leave' },
};

const EXPECTED: Record<BehaviorKind, Pose> = {
  idle: 'idle',
  thinking: 'thinking',
  reading: 'reading',
  typing: 'typing',
  terminal: 'terminal',
  browsing: 'browsing',
  delegating: 'working',
  working: 'working',
  raise_hand: 'raise_hand',
  sweat: 'sweat',
  cooldown: 'cooldown',
  celebrate: 'celebrate',
  nap: 'nap',
  wait: 'wait',
  leave: 'leave',
};

describe('poseFor', () => {
  it('maps every behaviour kind to a pose', () => {
    for (const kind of Object.keys(SAMPLES) as BehaviorKind[]) {
      expect(poseFor(SAMPLES[kind])).toBe(EXPECTED[kind]);
    }
  });

  it('plays the coffee pose for the idle coffee variant only', () => {
    expect(poseFor({ kind: 'idle', variant: 'coffee' })).toBe('coffee');
    expect(poseFor({ kind: 'idle', variant: 'sofa' })).toBe('idle');
    expect(poseFor({ kind: 'idle', variant: 'wander' })).toBe('idle');
  });
});
