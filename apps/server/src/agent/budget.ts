import type { Settings } from '@deskhaven/shared';
import type { AgentService } from '../agents/service.js';

/**
 * Per-agent and global daily caps on the SDK's cost estimate. Checked before every prompt is dispatched.
 * SDK-side limits (maxTurns, maxBudgetUsd) still apply per session on top of this.
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
      return `${agent.name} reached today's budget ($${today.toFixed(2)} of $${agent.budget.dailyCapUsd.toFixed(2)} estimated). Raise the cap in the HR desk to continue.`;
    }
    const total = agents.todayUsage().costUsd;
    if (s.dailyCapUsd > 0 && total >= s.dailyCapUsd) {
      return `The office reached today's global budget ($${total.toFixed(2)} of $${s.dailyCapUsd.toFixed(2)} estimated). Raise it in Settings to continue.`;
    }
    return null;
  };
}
