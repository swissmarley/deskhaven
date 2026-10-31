// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { freshSessionWarning } from '../src/ui/AgentForm.js';

describe('freshSessionWarning', () => {
  it('warns when a fresh session per task meets a cap its start-up nearly uses', () => {
    expect(freshSessionWarning(true, '0.10')).toMatch(/costs about \$0\.11 to start/);
    expect(freshSessionWarning(true, '0.10')).toMatch(/Use \$0\.22 or more/);
  });

  it('stays quiet with a roomy cap, no cap, or no fresh sessions', () => {
    expect(freshSessionWarning(true, '0.30')).toBeNull();
    expect(freshSessionWarning(true, '')).toBeNull();
    expect(freshSessionWarning(false, '0.05')).toBeNull();
  });
});
