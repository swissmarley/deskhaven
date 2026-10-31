import { describe, expect, it } from 'vitest';
import { managerHarness, tick } from './manager-harness.js';

describe('cost of a turn stopped by the per-turn cap', () => {
  it('reaches the task, the agent and the daily total even when the SDK reports $0', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Tester-Eng');
    h.agents.patch(a.id, (x) => ({ ...x, budget: { maxBudgetUsd: 0.02 } }));
    const task = await h.tasks.create({ title: 'Tiny', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    const s = h.sessions[0];
    if (!s) throw new Error('no session');
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        model: 'claude-sonnet-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        usage: {
          input_tokens: 5,
          cache_creation_input_tokens: 10_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10_000 },
          cache_read_input_tokens: 20_000,
          output_tokens: 300,
        },
      },
    });
    await tick();
    s.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 1700,
      duration_api_ms: 1600,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
    });
    await tick(30);
    const saved = h.tasks.get(task.id);
    expect(saved?.status).toBe('needs_input');
    expect(saved?.costUsd).toBeCloseTo(0.04701, 8);
    expect(h.agents.get(a.id)?.usage.costUsd).toBeCloseTo(0.04701, 8);
    expect(h.agents.get(a.id)?.usage.cacheCreationTokens).toBe(10_000);
    expect(h.agents.todayUsage(a.id).costUsd).toBeCloseTo(0.04701, 8);
  });
});
