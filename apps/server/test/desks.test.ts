import { describe, expect, it } from 'vitest';
import { managerHarness, tick } from './manager-harness.js';

describe('desk counter', () => {
  it('reports every change in busy agents, so the HUD does not keep a finished turn', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Ada');
    h.manager.sendPrompt(a.id, 'work', null);
    await tick();
    expect(h.manager.busyCount()).toBe(1);
    expect(h.desks).toEqual([1]);
    h.sessions[0]?.finishTurn();
    await tick();
    // Before, the only snapshot was sent at the end of the turn, while the agent still read as busy.
    expect(h.manager.busyCount()).toBe(0);
    expect(h.desks).toEqual([1, 0]);
    await h.manager.stop(a.id);
    expect(h.desks).toEqual([1, 0]);
  });
});
