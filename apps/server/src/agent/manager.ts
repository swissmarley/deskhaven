import type { Agent, AgentStatus } from '@agenthotel/shared';
import type { AgentService } from '../agents/service.js';
import type { WsHub } from '../ws/hub.js';
import { AgentRuntime, type RuntimeDeps } from './runtime.js';

export interface ManagerDeps {
  agents: AgentService;
  hub: WsHub;
  runtimeDeps: Omit<
    RuntimeDeps,
    'onStopped' | 'onStatus' | 'onSessionId' | 'onTurn' | 'onApiKeySource'
  > & {
    onTurn: RuntimeDeps['onTurn'];
    onApiKeySource: RuntimeDeps['onApiKeySource'];
  };
  concurrencyCap: () => number;
  /** Returns a reason string when the agent must not spend more today, or null. */
  budgetCheck?: (agentId: string) => string | null;
  idleTimeoutMs?: () => number;
}

/**
 * Owns every AgentRuntime, enforces the concurrency cap (agents beyond it wait for a desk), and holds
 * the global kill switch.
 */
export class AgentManager {
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly waiting: string[] = [];
  killSwitch = false;

  constructor(private readonly deps: ManagerDeps) {}

  get(agentId: string): AgentRuntime | undefined {
    return this.runtimes.get(agentId);
  }

  /** Live Claude Code processes (idle ones included). */
  runningCount(): number {
    let n = 0;
    for (const r of this.runtimes.values()) if (r.isRunning()) n++;
    return n;
  }

  /**
   * Agents currently in a turn or waiting on a permission. The concurrency cap applies to these, not to
   * idle processes: an idle session costs memory but no plan usage, and it must stay alive for resume.
   */
  busyCount(): number {
    let n = 0;
    for (const r of this.runtimes.values()) {
      const s = r.getStatus();
      if (r.isRunning() && (s === 'working' || s === 'needs_input')) n++;
    }
    return n;
  }

  private ensure(agent: Agent): AgentRuntime {
    let rt = this.runtimes.get(agent.id);
    if (rt) {
      rt.updateAgent(agent);
      return rt;
    }
    rt = new AgentRuntime(agent, {
      ...this.deps.runtimeDeps,
      onSessionId: (id, sessionId) => this.deps.agents.patch(id, (a) => ({ ...a, sessionId })),
      onStatus: (id, status, lastError) => this.onStatus(id, status, lastError),
      onTurn: (id, taskId, turn) => this.deps.runtimeDeps.onTurn(id, taskId, turn),
      onApiKeySource: this.deps.runtimeDeps.onApiKeySource,
      onStopped: (id) => this.onStopped(id),
    });
    this.runtimes.set(agent.id, rt);
    return rt;
  }

  private onStatus(agentId: string, status: AgentStatus, lastError: string | null): void {
    const rt = this.runtimes.get(agentId);
    this.deps.agents.patch(agentId, (a) => ({
      ...a,
      status,
      lastError: lastError ?? (status === 'error' ? a.lastError : null),
      currentTaskId: rt?.getCurrentTaskId() ?? null,
    }));
    // A desk frees up whenever an agent leaves the busy states.
    if (status === 'idle' || status === 'stopped' || status === 'error' || status === 'paused') {
      queueMicrotask(() => this.startWaiting());
    }
  }

  private onStopped(agentId: string): void {
    this.waiting.splice(0, this.waiting.length, ...this.waiting.filter((id) => id !== agentId));
    this.startWaiting();
  }

  private canStart(): boolean {
    return !this.killSwitch && this.busyCount() < this.deps.concurrencyCap();
  }

  private startWaiting(): void {
    while (this.waiting.length && this.canStart()) {
      const id = this.waiting.shift();
      if (!id) break;
      const agent = this.deps.agents.get(id);
      const rt = agent ? this.ensure(agent) : undefined;
      if (!rt) continue;
      if (!rt.isRunning()) rt.start();
      else rt.resumeWaiting();
    }
  }

  /** Start (or resume) an agent's session now, or queue it behind the concurrency cap. */
  start(agentId: string): AgentStatus {
    if (this.killSwitch) throw new Error('Kill switch is active');
    const agent = this.mustGet(agentId);
    const rt = this.ensure(agent);
    if (rt.isRunning()) return rt.getStatus();
    if (!this.canStart()) {
      if (!this.waiting.includes(agentId)) this.waiting.push(agentId);
      this.onStatus(agentId, 'waiting', null);
      return 'waiting';
    }
    rt.start();
    return rt.getStatus();
  }

  sendPrompt(agentId: string, text: string, taskId: string | null): void {
    if (this.killSwitch) throw new Error('Kill switch is active');
    const agent = this.mustGet(agentId);
    const over = this.deps.budgetCheck?.(agentId);
    if (over) throw new Error(over);
    const rt = this.ensure(agent);
    const busy = rt.getStatus() === 'working' || rt.getStatus() === 'needs_input';
    if (rt.getStatus() === 'paused' || busy) {
      // paused: queued until resume; busy: queued behind the current turn (same desk)
      rt.sendPrompt(text, taskId);
      return;
    }
    if (!this.canStart()) {
      rt.enqueueOnly(text, taskId);
      if (!this.waiting.includes(agentId)) this.waiting.push(agentId);
      return;
    }
    rt.sendPrompt(text, taskId);
  }

  async stop(agentId: string): Promise<void> {
    const rt = this.runtimes.get(agentId);
    if (!rt) {
      this.deps.agents.patch(agentId, (a) => ({ ...a, status: 'stopped', currentTaskId: null }));
      return;
    }
    await rt.stop();
  }

  async pause(agentId: string): Promise<void> {
    await this.ensure(this.mustGet(agentId)).pause();
  }

  resume(agentId: string): void {
    if (this.killSwitch) throw new Error('Kill switch is active');
    this.ensure(this.mustGet(agentId)).resume();
  }

  async interrupt(agentId: string): Promise<void> {
    await this.runtimes.get(agentId)?.interrupt();
  }

  async remove(agentId: string): Promise<void> {
    await this.stop(agentId);
    this.runtimes.delete(agentId);
  }

  /** Global kill switch: stop everything, refuse new work until reset. */
  async killAll(): Promise<void> {
    this.killSwitch = true;
    this.waiting.length = 0;
    this.deps.hub.broadcast({ type: 'kill_switch', active: true });
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.stop()));
  }

  resetKillSwitch(): void {
    this.killSwitch = false;
    this.deps.hub.broadcast({ type: 'kill_switch', active: false });
  }

  /** Stop processes that have been idle longer than the configured timeout (sessions stay resumable). */
  async sweepIdle(): Promise<number> {
    const limit = this.deps.idleTimeoutMs?.() ?? 0;
    if (limit <= 0) return 0;
    let n = 0;
    for (const rt of this.runtimes.values()) {
      if (
        rt.isRunning() &&
        rt.getStatus() === 'idle' &&
        rt.queuedCount() === 0 &&
        rt.idleFor() > limit
      ) {
        await rt.stop();
        n++;
      }
    }
    return n;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.stop()));
  }

  private mustGet(agentId: string): Agent {
    const a = this.deps.agents.get(agentId);
    if (!a) throw new Error(`Unknown agent ${agentId}`);
    return a;
  }
}
