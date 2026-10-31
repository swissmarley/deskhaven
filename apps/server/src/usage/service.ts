import {
  type AgentEvent,
  emptyUsage,
  type UsageSnapshot,
  type UsageTotals,
} from '@deskhaven/shared';
import type { AgentService } from '../agents/service.js';
import { localDate } from './date.js';

type RateWindow = UsageSnapshot['rateLimits'][number];

/** Aggregates cost/token totals and the latest plan rate-limit windows for the HUD. */
export class UsageService {
  private readonly windows = new Map<string, RateWindow>();
  private authModeInUse = 'unknown';

  constructor(
    private readonly agents: AgentService,
    private readonly runtime: () => {
      killSwitch: boolean;
      running: number;
      concurrencyCap: number;
    },
  ) {}

  observe(ev: AgentEvent): void {
    if (ev.type === 'rate_limit') {
      const key = ev.windowType ?? 'unknown';
      this.windows.set(key, {
        windowType: key,
        status: ev.status,
        utilization: ev.utilization,
        resetsAt: ev.resetsAt,
      });
    } else if (ev.type === 'session_started') {
      this.authModeInUse =
        ev.apiKeySource === 'none' ? 'CLAUDE_SUBSCRIPTION' : `API_KEY (${ev.apiKeySource})`;
    }
  }

  /**
   * Office totals (all time and today) come from the daily rows and include agents that were fired,
   * so "today" never exceeds "total" and both count every dollar spent; `perAgent` and
   * `perAgentToday` cover the agents on staff, and the gap to the totals is the fired agents' share.
   */
  snapshot(): UsageSnapshot {
    const perAgent: Record<string, UsageTotals> = {};
    const perAgentToday: Record<string, UsageTotals> = {};
    const todayByAgent = this.agents.usageByAgent(localDate());
    for (const a of this.agents.list()) {
      perAgent[a.id] = a.usage;
      perAgentToday[a.id] = todayByAgent.get(a.id) ?? emptyUsage();
    }
    const totals = sumUsage(this.agents.usageByAgent().values());
    const rt = this.runtime();
    return {
      authModeInUse: this.authModeInUse,
      totals,
      today: sumUsage(todayByAgent.values()),
      perAgent,
      perAgentToday,
      rateLimits: [...this.windows.values()],
      killSwitch: rt.killSwitch,
      running: rt.running,
      concurrencyCap: rt.concurrencyCap,
    };
  }
}

function sumUsage(rows: Iterable<UsageTotals>): UsageTotals {
  const total = emptyUsage();
  for (const r of rows) {
    total.costUsd += r.costUsd;
    total.inputTokens += r.inputTokens;
    total.outputTokens += r.outputTokens;
    total.cacheReadTokens += r.cacheReadTokens;
    total.cacheCreationTokens += r.cacheCreationTokens;
    total.turns += r.turns;
  }
  return total;
}
