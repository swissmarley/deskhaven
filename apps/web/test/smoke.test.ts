import { APP_VERSION } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';

describe('web smoke', () => {
  it('imports shared', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
