import { describe, expect, it } from 'vitest';
import { withRestartNote } from '../src/tasks/service.js';
import { managerHarness, tick } from './manager-harness.js';

const notes = (s: string | null | undefined) =>
  (s ?? '').match(/\[Interrupted by a server restart/g)?.length ?? 0;

describe('restart note', () => {
  it('marks a task whose turn was running, once, however many times the server restarts', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Ada');
    const task = await h.tasks.create({ title: 'Mid-turn', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    expect(h.tasks.get(task.id)?.status).toBe('in_progress');
    // The process dies with the server; boot after boot (tsx watch reloads) runs reconcileOnBoot.
    h.tasks.reconcileOnBoot();
    h.tasks.reconcileOnBoot();
    h.tasks.reconcileOnBoot();
    const saved = h.tasks.get(task.id);
    expect(saved?.status).toBe('needs_input');
    expect(notes(saved?.resultSummary)).toBe(1);
  });

  it('leaves a task alone that was already waiting in Needs input after its turn ended', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Ada');
    const task = await h.tasks.create({ title: 'Stopped', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    h.sessions[0]?.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: ['Turn interrupted'],
    });
    await tick();
    const before = h.tasks.get(task.id);
    expect(before?.status).toBe('needs_input');
    h.tasks.reconcileOnBoot();
    h.tasks.reconcileOnBoot();
    expect(notes(h.tasks.get(task.id)?.resultSummary)).toBe(0);
    expect(h.tasks.get(task.id)?.resultSummary).toBe(before?.resultSummary);
  });

  it('replaces an earlier note instead of stacking them', () => {
    const first = withRestartNote('Did half of it.', new Date(2026, 9, 31, 10, 0, 0));
    const second = withRestartNote(first, new Date(2026, 9, 31, 11, 0, 0));
    expect(notes(second)).toBe(1);
    expect(second.startsWith('Did half of it.\n\n[Interrupted by a server restart at ')).toBe(true);
    expect(withRestartNote(null, new Date())).toMatch(/^\[Interrupted by a server restart/);
  });
});
