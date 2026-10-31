import type { Settings } from '@deskhaven/shared';
import type { AgentService } from '../agents/service.js';
import { usd } from './runtime.js';

/**
 * Per-agent and global daily caps on the SDK's cost estimate. Checked before every prompt is dispatched.
 * `maxTurns` (SDK) and the per-turn `maxBudgetUsd` (AgentRuntime) apply on top of this.
 */
export function createBudgetGuard(
  agents: AgentService,
  settings: () => Settings,
): (agentId: string) => string | null {
  return (agentId) => {
    const s = settings();
    const agent = agents.get(agentId);
    if (!agent) return null;
    const today = agents.todayUsage(agentId).costUsd;
    if (agent.budget.dailyCapUsd !== undefined && today >= agent.budget.dailyCapUsd) {
      return `${agent.name} reached today's budget (${usd(today)} of ${usd(agent.budget.dailyCapUsd)} estimated). Raise the cap in the HR desk to continue.`;
    }
    const total = agents.todayUsage().costUsd;
    if (s.dailyCapUsd > 0 && total >= s.dailyCapUsd) {
      return `The office reached today's global budget (${usd(total)} of ${usd(s.dailyCapUsd)} estimated). Raise it in Settings to continue.`;
    }
    return null;
  };
}
