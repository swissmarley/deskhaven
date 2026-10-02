import {
  type AgentEvent,
  emptyUsage,
  type UsageSnapshot,
  type UsageTotals,
} from '@agenthotel/shared';
import type { AgentService } from '../agents/service.js';

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

  snapshot(): UsageSnapshot {
    const perAgent: Record<string, UsageTotals> = {};
    const totals = emptyUsage();
    for (const a of this.agents.list()) {
      perAgent[a.id] = a.usage;
      totals.costUsd += a.usage.costUsd;
      totals.inputTokens += a.usage.inputTokens;
      totals.outputTokens += a.usage.outputTokens;
      totals.cacheReadTokens += a.usage.cacheReadTokens;
      totals.cacheCreationTokens += a.usage.cacheCreationTokens;
      totals.turns += a.usage.turns;
    }
    const rt = this.runtime();
    return {
      authModeInUse: this.authModeInUse,
      totals,
      today: this.agents.todayUsage(),
      perAgent,
      rateLimits: [...this.windows.values()],
      killSwitch: rt.killSwitch,
      running: rt.running,
      concurrencyCap: rt.concurrencyCap,
    };
  }
}
