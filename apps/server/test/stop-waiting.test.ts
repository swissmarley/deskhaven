import { describe, expect, it } from 'vitest';
import { managerHarness, tick } from './manager-harness.js';

/**
 * Regression: stopping an agent that waits for a free desk left its prompt queued and its id in the
 * desk queue, so it came back to life and ran the old prompt as soon as a desk freed up.
 */
describe('stopping an agent that waits for a desk', () => {
  it('drops the queued prompt and leaves the desk queue (prompt path)', async () => {
    const h = managerHarness({ cap: 1 });
    const busy = h.hire('Busy');
    const queued = h.hire('Queued');
    h.manager.sendPrompt(busy.id, 'first', null);
    h.manager.sendPrompt(queued.id, 'old prompt', null);
    expect(h.manager.get(queued.id)?.getStatus()).toBe('waiting');
    expect(h.manager.waitingIds()).toEqual([queued.id]);

    await h.manager.stop(queued.id);
    expect(h.manager.waitingIds()).toEqual([]);
    expect(h.manager.get(queued.id)?.queuedCount()).toBe(0);
    expect(h.agents.get(queued.id)?.status).toBe('stopped');

    // The desk frees up: the stopped agent must stay stopped and never see the old prompt.
    h.sessions[0]?.finishTurn();
    await tick();
    await h.manager.stop(busy.id);
    await tick();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions.flatMap((s) => s.prompts)).not.toContain('old prompt');
    expect(h.agents.get(queued.id)?.status).toBe('stopped');
    expect(h.manager.get(queued.id)?.isRunning()).toBe(false);
  });

  it('leaves the desk queue (start path)', async () => {
    const h = managerHarness({ cap: 1 });
    const busy = h.hire('Busy');
    const queued = h.hire('Queued');
    h.manager.sendPrompt(busy.id, 'first', null);
    expect(h.manager.start(queued.id)).toBe('waiting');
    await h.manager.stop(queued.id);
    await h.manager.stop(busy.id);
    await tick();
    expect(h.sessions).toHaveLength(1);
    expect(h.agents.get(queued.id)?.status).toBe('stopped');
  });

  it('flags a task whose queued prompt was dropped instead of re-dispatching it', async () => {
    const h = managerHarness({ cap: 1 });
    const busy = h.hire('Busy');
    const queued = h.hire('Queued');
    h.manager.sendPrompt(busy.id, 'first', null);
    const task = await h.tasks.create({
      title: 'Later',
      prompt: 'do it',
      assigneeAgentId: queued.id,
    });
    expect(h.tasks.get(task.id)?.status).toBe('assigned');
    await h.manager.stop(queued.id);
    expect(h.tasks.get(task.id)?.status).toBe('needs_input');
    // A server restart re-dispatches only tasks still marked "assigned".
    h.tasks.reconcileOnBoot();
    await h.manager.stop(busy.id);
    await tick();
    expect(h.sessions).toHaveLength(1);
  });

  it('still lets a waiting agent take a free desk when it was not stopped', async () => {
    const h = managerHarness({ cap: 1 });
    const busy = h.hire('Busy');
    const queued = h.hire('Queued');
    h.manager.sendPrompt(busy.id, 'first', null);
    h.manager.sendPrompt(queued.id, 'next', null);
    h.sessions[0]?.finishTurn();
    await tick();
    expect(h.sessions).toHaveLength(2);
    expect(h.sessions[1]?.prompts).toEqual(['next']);
  });
});
