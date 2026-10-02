import { describe, expect, it } from 'vitest';
import { createBudgetGuard } from '../src/agent/budget.js';
import type { AgentService } from '../src/agents/service.js';
import { defaultSettings } from '../src/settings/service.js';

function guard(agentCost: number, totalCost: number, dailyCapUsd?: number, globalCap = 20) {
  const agents = {
    get: () => ({
      id: 'a1',
      name: 'Ada',
      budget: dailyCapUsd !== undefined ? { dailyCapUsd } : {},
    }),
    todayUsage: (id?: string) => ({ costUsd: id ? agentCost : totalCost }),
  } as unknown as AgentService;
  return createBudgetGuard(agents, () => defaultSettings({ dailyCapUsd: globalCap }));
}

describe('budget guard', () => {
  it('allows spend under both caps', () => {
    expect(guard(1, 5, 2)('a1')).toBeNull();
  });
  it('blocks when the agent cap is reached', () => {
    expect(guard(2, 5, 2)('a1')).toMatch(/Ada reached today's budget/);
  });
  it('blocks when the global cap is reached and ignores a zero global cap', () => {
    expect(guard(1, 20, undefined, 20)('a1')).toMatch(/global budget/);
    expect(guard(1, 20, undefined, 0)('a1')).toBeNull();
  });
});
