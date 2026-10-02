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

  runningCount(): number {
    let n = 0;
    for (const r of this.runtimes.values()) if (r.isRunning()) n++;
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
  }

  private onStopped(agentId: string): void {
    this.waiting.splice(0, this.waiting.length, ...this.waiting.filter((id) => id !== agentId));
    this.startWaiting();
  }

  private canStart(): boolean {
    return !this.killSwitch && this.runningCount() < this.deps.concurrencyCap();
  }

  private startWaiting(): void {
    while (this.waiting.length && this.canStart()) {
      const id = this.waiting.shift();
      if (!id) break;
      const agent = this.deps.agents.get(id);
      const rt = agent ? this.ensure(agent) : undefined;
      if (rt && !rt.isRunning()) rt.start();
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
    const rt = this.ensure(agent);
    if (rt.isRunning() || rt.getStatus() === 'paused') {
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

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.runtimes.values()].map((r) => r.stop()));
  }

  private mustGet(agentId: string): Agent {
    const a = this.deps.agents.get(agentId);
    if (!a) throw new Error(`Unknown agent ${agentId}`);
    return a;
  }
}
