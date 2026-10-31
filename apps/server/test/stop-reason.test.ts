import { describe, expect, it } from 'vitest';
import { managerHarness, tick } from './manager-harness.js';

describe('task summary of a failed turn', () => {
  it('keeps the agent text and adds why the turn stopped', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Tester-Eng');
    const task = await h.tasks.create({ title: 'One line', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    const s = h.sessions[0];
    if (!s) throw new Error('no session');
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Added the comment.' }] },
    });
    s.emit({
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
      errors: [
        'Stopped: this turn reached its budget of $0.100 (interrupted at $0.121 estimated).',
      ],
    });
    await tick(20);
    const saved = h.tasks.get(task.id);
    expect(saved?.status).toBe('needs_input');
    expect(saved?.resultSummary).toBe(
      'Added the comment.\n\n**Stopped: this turn reached its budget of $0.100 (interrupted at $0.121 estimated).**',
    );
  });

  it('leaves a successful turn as the agent wrote it', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Ada');
    const task = await h.tasks.create({ title: 'Fine', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    h.sessions[0]?.finishTurn();
    await tick(20);
    expect(h.tasks.get(task.id)?.resultSummary).not.toContain('**');
  });
});
