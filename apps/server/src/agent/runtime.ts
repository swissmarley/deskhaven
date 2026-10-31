import fs from 'node:fs';
import path from 'node:path';
import {
  type Agent,
  type AgentEvent,
  type AgentEventOf,
  type AgentStatus,
  agentCwd,
  classifyTool,
  newId,
  presetById,
  type RolePreset,
  type Settings,
  sessionModel,
} from '@deskhaven/shared';
import { workdirProblem } from '../agents/service.js';
import type { ChildEnv } from '../auth/env.js';
import { type ExternalCredentials, externalCredentials } from '../auth/external.js';
import type { AuthProvider } from '../auth/types.js';
import { envVar } from '../config.js';
import type { EventStore } from '../events/store.js';
import { scrubSecrets } from '../logger.js';
import { DiffTracker, isInside } from './diff-tracker.js';
import { type NormalizeContext, normalizeHook, normalizeSdkMessage } from './normalize.js';
import type { PermissionBroker } from './permission-broker.js';
import {
  type AgentSession,
  type CanUseTool,
  type HookInput,
  type McpServerConfig,
  type SDKMessage,
  type SessionCallbacks,
  type SessionConfig,
  sessionCostUsd,
  startAgentSession,
} from './sdk-adapter.js';
import { TurnCostMeter, turnCostFromCumulative } from './turn-cost.js';

/** Minimum gap between two mid-turn reads of the SDK's running cost. */
const COST_PROBE_INTERVAL_MS = 1500;

type TurnUsage = Parameters<TurnCostMeter['add']>[2];

export interface RuntimeLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface RuntimeDeps {
  auth: () => AuthProvider;
  events: EventStore;
  broker: PermissionBroker;
  settings: () => Settings;
  baseEnv: () => ChildEnv;
  log: RuntimeLogger;
  onSessionId: (agentId: string, sessionId: string) => void;
  onStatus: (agentId: string, status: AgentStatus, lastError: string | null) => void;
  onTurn: (agentId: string, taskId: string | null, turn: AgentEventOf<'turn_completed'>) => void;
  onApiKeySource: (agentId: string, apiKeySource: string) => void;
  onStopped: (agentId: string) => void;
  mcpServers?: (agent: Agent) => Record<string, McpServerConfig> | undefined;
  /** Test seam: replaces the SDK session factory. */
  startSession?: (cfg: SessionConfig, cb: SessionCallbacks) => AgentSession;
  /** Resolves role presets from the DB (built-ins + custom); falls back to shipped presets in tests. */
  presetLookup?: (id: string) => RolePreset | undefined;
  /** How long `stop()` waits for the process to exit before aborting it. */
  stopGraceMs?: number;
}

interface QueuedPrompt {
  text: string;
  taskId: string | null;
}

/**
 * One live Claude Code session per agent, in streaming-input mode. Owns the message loop, the tool
 * bookkeeping, status transitions and the permission hand-off. Everything observable leaves through
 * `EventStore.append`.
 */
export class AgentRuntime {
  private session: AgentSession | null = null;
  private loop: Promise<void> | null = null;
  private status: AgentStatus;
  private currentTaskId: string | null = null;
  private readonly queue: QueuedPrompt[] = [];
  private readonly startedTools = new Set<string>();
  private readonly finishedTools = new Set<string>();
  private readonly toolInfo = new Map<string, { tool: string; input: unknown }>();
  private diffs: DiffTracker;
  private sessionId: string | null;
  private stopping = false;
  private inTurn = false;
  private lastError: string | null = null;
  private lastActivityAt = Date.now();
  /** The auth provider the live process was spawned with (its env is fixed at spawn). */
  private sessionAuth: AuthProvider | null = null;
  /** Non-API-key credentials the user configured for API_KEY mode (Bedrock, Vertex, ...). */
  private sessionExternal: ExternalCredentials | null = null;
  private restarting = false;
  /** Bumped by stop(), so a credentials restart that is still winding down does not respawn. */
  private stopGeneration = 0;
  /**
   * Directories the session may read besides its cwd (a reviewer's view of an engineer worktree).
   * The CLI only honours these as `--add-dir` at process start, including when `--resume` is set, so a
   * change restarts the process on the same session id.
   */
  private extraReadDirs: string[] = [];
  /** Directories the live process was spawned with. */
  private sessionReadDirs: string[] = [];
  /** Running cost estimate of the current turn (the SDK reports cost only when a turn ends). */
  private readonly turnCost = new TurnCostMeter();
  /** Set when this turn was interrupted for reaching `budget.maxBudgetUsd`. */
  private turnBudgetHit: { estimateUsd: number; capUsd: number } | null = null;
  /** Bumped per dispatched prompt, so a late SDK cost reading cannot land on the next turn. */
  private turnSeq = 0;
  /** The SDK's cumulative cost when this turn was dispatched; null until (or unless) it answers. */
  private turnSdkBase: number | null = null;
  /** This turn's cost according to the SDK's running total (0 until a reading arrives). */
  private turnSdkCost = 0;
  private costProbeInFlight = false;
  private lastCostProbeAt = 0;
  /** Streamed responses: message id and model per parent tool use, for `message_delta` usage. */
  private readonly streamMessage = new Map<string, { id: string; model: string }>();
  /** The SDK's cumulative `total_cost_usd` after the previous turn of the live process. */
  private sessionCostBase = 0;
  /** Task of the last prompt dispatched to the live session; undefined = not known yet. */
  private sessionTaskId: string | null | undefined = undefined;
  /** The live process started a new conversation and has not run a prompt yet. */
  private sessionClean = false;

  constructor(
    private agent: Agent,
    private readonly deps: RuntimeDeps,
  ) {
    this.sessionId = agent.sessionId;
    this.status = agent.status === 'paused' ? 'paused' : 'stopped';
    this.diffs = new DiffTracker(this.cwd());
  }

  get agentId(): string {
    return this.agent.id;
  }
  getStatus(): AgentStatus {
    return this.status;
  }
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }
  isRunning(): boolean {
    return this.session !== null;
  }
  queuedCount(): number {
    return this.queue.length;
  }
  /** Milliseconds since the last message, prompt or status change. */
  idleFor(): number {
    return Date.now() - this.lastActivityAt;
  }

  /** Config changes apply to the next session start. */
  updateAgent(agent: Agent): void {
    this.agent = agent;
    this.sessionId = agent.sessionId ?? this.sessionId;
    this.diffs = new DiffTracker(this.cwd());
  }

  /**
   * Extra directories passed to the CLI as `--add-dir`. Read/Grep/Glob can use them; the edit guard
   * still refuses writes outside cwd. A running session is restarted (and resumed) before the next
   * prompt when the list changes.
   */
  setExtraReadDirs(dirs: string[]): void {
    const next = [...new Set(dirs.filter((d) => d.length > 0))].sort();
    if (
      next.length === this.extraReadDirs.length &&
      next.every((d, i) => d === this.extraReadDirs[i])
    )
      return;
    this.extraReadDirs = next;
  }

  private cwd(): string {
    return agentCwd(this.agent);
  }

  /** Spawn the Claude Code process (resuming the stored session when there is one). */
  start(): void {
    if (this.session || this.restarting) return;
    this.stopping = false;
    const problem = workdirProblem(this.agent);
    if (problem) {
      this.failToStart(problem, 'other');
      return;
    }
    const auth = this.deps.auth();
    const env = auth.childEnv(this.deps.baseEnv());
    const external = auth.mode === 'API_KEY' ? externalCredentials(env, this.cwd()) : null;
    if (auth.mode === 'API_KEY' && !env.ANTHROPIC_API_KEY && !external) {
      // Without a key the CLI would silently fall back to whatever else it finds (a claude.ai login).
      this.failToStart(
        'API key mode is selected but no API key is configured. Add one in Settings (or set ANTHROPIC_API_KEY), or switch to subscription mode. For Bedrock, Vertex or an apiKeyHelper, set CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX, configure apiKeyHelper in the project, or set DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS=1.',
      );
      return;
    }
    if (this.wantsFreshSession(this.queue[0]?.taskId ?? null)) this.dropSession();
    this.sessionCostBase = this.savedSessionCost();
    this.sessionClean = !this.sessionId;
    const preset =
      this.deps.presetLookup?.(this.agent.rolePresetId) ?? presetById(this.agent.rolePresetId);
    const cfg: SessionConfig = {
      cwd: this.cwd(),
      model: sessionModel(this.agent, preset),
      systemPromptAppend: this.agent.systemPrompt,
      // An empty tool list means the preset's set (as the HR form says); only a preset without a
      // list gives the whole Claude Code surface, whose definitions cost tens of thousands of tokens.
      tools: this.agent.tools ?? preset?.tools ?? null,
      allowedTools: this.agent.allowedTools,
      permissionMode: this.agent.permissionMode,
      env,
      additionalDirectories: this.extraReadDirs,
      // Only Deskhaven's own MCP servers: the user's global connectors must not leak into agents.
      strictMcpConfig: true,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      ...(this.agent.budget.maxTurns ? { maxTurns: this.agent.budget.maxTurns } : {}),
      // budget.maxBudgetUsd is enforced per turn by this runtime (see onAssistantUsage). The SDK's
      // own maxBudgetUsd is cumulative for the process and only checked between API calls.
    };
    const mcp = this.deps.mcpServers?.(this.agent);
    if (mcp) cfg.mcpServers = mcp;
    this.sessionReadDirs = [...this.extraReadDirs];
    const cb: SessionCallbacks = {
      onMessage: (m) => this.handleMessage(m),
      onHook: (input, toolUseId) => this.handleHook(input, toolUseId),
      canUseTool: this.handlePermission,
      onStderr: (line) =>
        this.deps.log.debug({ agentId: this.agent.id }, scrubSecrets(line.trimEnd())),
      preToolGuard: (input) => this.guard(input),
    };
    const factory = this.deps.startSession ?? startAgentSession;
    this.session = factory(cfg, cb);
    this.sessionAuth = auth;
    this.sessionExternal = external;
    this.deps.log.info(
      {
        agentId: this.agent.id,
        cwd: cfg.cwd,
        model: cfg.model,
        resume: Boolean(cfg.resume),
        mode: auth.mode,
        ...(external ? { credentials: external.label } : {}),
      },
      'agent session started',
    );
    this.loop = this.run();
    if (this.queue.length) this.dispatchNext();
    else this.setStatus('idle');
  }

  /** Queue a prompt; starts the session if needed (unless paused). */
  sendPrompt(text: string, taskId: string | null): void {
    this.emit({ ...this.baseEvent(), type: 'message_sent', text, ...(taskId ? { taskId } : {}) });
    this.queue.push({ text, taskId });
    if (this.status === 'paused' || this.status === 'waiting' || this.restarting) return;
    if (!this.session) {
      this.start();
      return;
    }
    if (!this.inTurn) this.dispatchNext();
  }

  /** Called by the manager when a desk frees up for an agent that was waiting with a live process. */
  resumeWaiting(): void {
    if (this.status !== 'waiting') return;
    if (this.queue.length && !this.inTurn) this.dispatchNext();
    else this.setStatus('idle');
  }

  /** The manager queued this agent for a desk without a prompt (start() at the concurrency cap). */
  markWaiting(): void {
    if (!this.session) this.setStatus('waiting');
  }

  /** Queue without starting (the manager uses this when the concurrency cap is reached). */
  enqueueOnly(text: string, taskId: string | null): void {
    this.emit({ ...this.baseEvent(), type: 'message_sent', text, ...(taskId ? { taskId } : {}) });
    this.queue.push({ text, taskId });
    this.setStatus('waiting');
  }

  async interrupt(): Promise<void> {
    if (!this.session) return;
    try {
      await this.session.query.interrupt();
      this.emit({ ...this.baseEvent(), type: 'interrupted' });
    } catch (err) {
      this.deps.log.warn({ agentId: this.agent.id, err: String(err) }, 'interrupt failed');
    }
  }

  async pause(): Promise<void> {
    if (this.inTurn) await this.interrupt();
    this.setStatus('paused');
  }

  resume(): void {
    if (this.status !== 'paused') return;
    this.setStatus(this.session ? 'idle' : 'stopped');
    if (this.queue.length) {
      if (!this.session) this.start();
      else if (!this.inTurn) this.dispatchNext();
    }
  }

  /** End the input stream, interrupt, and abort after a grace period. Keeps `sessionId` for resume. */
  async stop(): Promise<void> {
    this.stopGeneration++;
    // Drop queued prompts first: nothing may be dispatched while the process winds down, and an agent
    // stopped while waiting for a desk must not wake up later and run them.
    this.dropQueue('The agent was stopped before this task started.');
    const s = this.session;
    if (!s) {
      this.currentTaskId = null;
      this.setStatus('stopped');
      this.deps.onStopped(this.agent.id);
      return;
    }
    this.stopping = true;
    this.deps.broker.cancelForAgent(this.agent.id);
    s.prompts.end();
    if (this.inTurn) await this.interrupt();
    const timeout = new Promise<void>((r) => setTimeout(r, this.deps.stopGraceMs ?? 5000));
    await Promise.race([this.loop ?? Promise.resolve(), timeout]);
    if (this.session) {
      s.abort.abort();
      this.session = null;
    }
    this.queue.length = 0;
    this.inTurn = false;
    this.currentTaskId = null;
    this.setStatus('stopped');
    this.deps.onStopped(this.agent.id);
  }

  // ----- internals -------------------------------------------------------------------------------

  /** True when credentials changed in Settings after this process was spawned. */
  private credentialsChanged(): boolean {
    return this.sessionAuth !== null && this.deps.auth() !== this.sessionAuth;
  }

  private readDirsChanged(): boolean {
    if (this.sessionReadDirs.length !== this.extraReadDirs.length) return true;
    return this.sessionReadDirs.some((d, i) => d !== this.extraReadDirs[i]);
  }

  /**
   * The SDK fixes subprocess options at spawn (env, and `--add-dir`). Between turns the process is
   * ended and respawned on the same session id; the queued prompt then runs with the new options.
   * `--resume` does not drop `--add-dir`: both are launch flags of the new process.
   */
  private async restartBeforeTurn(reason: string): Promise<void> {
    const s = this.session;
    if (!s || this.restarting) return;
    this.restarting = true;
    const generation = this.stopGeneration;
    this.deps.log.info({ agentId: this.agent.id }, reason);
    this.stopping = true;
    s.prompts.end();
    const timeout = new Promise<void>((r) => setTimeout(r, this.deps.stopGraceMs ?? 5000));
    await Promise.race([this.loop ?? Promise.resolve(), timeout]);
    if (this.session === s) {
      s.abort.abort();
      this.session = null;
    }
    this.sessionAuth = null;
    this.stopping = false;
    this.restarting = false;
    if (generation !== this.stopGeneration || this.status === 'paused') return;
    this.start();
  }

  private failToStart(message: string, kind: 'auth' | 'other' = 'auth'): void {
    this.lastError = message;
    this.emit({ ...this.baseEvent(), type: 'error', kind, message });
    this.dropQueue(message);
    this.currentTaskId = null;
    this.setStatus('error');
    this.deps.onStopped(this.agent.id);
  }

  /** Empties the prompt queue; queued task prompts are reported so the board can flag them. */
  private dropQueue(message: string): void {
    const dropped = this.queue.splice(0);
    for (const q of dropped) {
      if (!q.taskId) continue;
      this.emit({
        ...this.baseEvent(),
        taskId: q.taskId,
        type: 'notification',
        kind: 'cancelled',
        message,
      });
    }
  }

  private async run(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      for await (const m of s.query) this.handleMessage(m);
      this.finishLoop(null);
    } catch (err) {
      this.finishLoop(err);
    }
  }

  private finishLoop(err: unknown): void {
    this.deps.log.info(
      { agentId: this.agent.id, stopping: this.stopping, error: err ? String(err) : null },
      'agent session loop ended',
    );
    this.session = null;
    this.inTurn = false;
    if (err && !this.stopping) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err));
      this.lastError = message;
      this.deps.log.error(
        { agentId: this.agent.id, err: message },
        'agent session ended with error',
      );
      this.emit({ ...this.baseEvent(), type: 'error', kind: 'other', message });
      this.setStatus('error');
    } else if (!this.stopping) {
      this.setStatus('stopped');
    }
    this.currentTaskId = null;
    if (!this.stopping) this.deps.onStopped(this.agent.id);
  }

  private dispatchNext(): void {
    if (!this.session || !this.queue.length) return;
    if (this.credentialsChanged()) {
      void this.restartBeforeTurn(
        'credentials changed; restarting the session before the next turn',
      );
      return;
    }
    if (this.readDirsChanged()) {
      void this.restartBeforeTurn(
        'read directories changed; restarting the session before the next turn',
      );
      return;
    }
    if (this.wantsFreshSession(this.queue[0]?.taskId ?? null)) {
      this.dropSession();
      void this.restartBeforeTurn('new task; starting a fresh session (freshSessionPerTask)');
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.lastActivityAt = Date.now();
    this.currentTaskId = next.taskId;
    this.sessionTaskId = next.taskId;
    this.sessionClean = false;
    this.turnCost.reset();
    this.turnBudgetHit = null;
    this.turnSeq++;
    this.turnSdkBase = null;
    this.turnSdkCost = 0;
    this.lastCostProbeAt = 0;
    this.streamMessage.clear();
    this.inTurn = true;
    this.setStatus('working');
    // Read the SDK's running total before the prompt goes out: it is the baseline for this turn.
    if (this.agent.budget.maxBudgetUsd) this.readTurnBase(this.turnSeq);
    this.session.prompts.push(next.text);
  }

  private ctx(): NormalizeContext {
    return {
      agentId: this.agent.id,
      ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      now: () => Date.now(),
      newId,
    };
  }

  private baseEvent() {
    return {
      id: newId(),
      ts: Date.now(),
      agentId: this.agent.id,
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      ...(this.currentTaskId ? { taskId: this.currentTaskId } : {}),
    };
  }

  private handleMessage(m: SDKMessage): void {
    this.lastActivityAt = Date.now();
    recordSdkMessage(m);
    if (m.type === 'assistant') this.onAssistantUsage(m);
    else if (m.type === 'stream_event') this.onStreamUsage(m);
    for (const ev of normalizeSdkMessage(m, this.ctx())) this.process(ev);
    if (m.type === 'result') this.onTurnEnd();
  }

  /**
   * Adds an assistant message's usage to the turn estimate and interrupts the turn once it reaches
   * `budget.maxBudgetUsd`. The check runs as each API response arrives, so a turn can overshoot by
   * at most the call that crossed the cap.
   */
  private onAssistantUsage(m: Extract<SDKMessage, { type: 'assistant' }>): void {
    if (!this.inTurn) return;
    const msg = m.message as { id?: string; model?: string; usage?: unknown } | undefined;
    if (!msg?.usage || typeof msg.usage !== 'object') return;
    this.turnCost.add(msg.id, msg.model ?? this.agent.model, msg.usage as TurnUsage);
    this.checkTurnBudget();
  }

  /**
   * With partial messages on, `message_start` carries a response's input and cache usage and
   * `message_delta` its final output count, which the assistant messages report only partially.
   */
  private onStreamUsage(m: Extract<SDKMessage, { type: 'stream_event' }>): void {
    if (!this.inTurn) return;
    const key = m.parent_tool_use_id ?? '';
    const ev = m.event as {
      type?: string;
      message?: { id?: string; model?: string; usage?: unknown };
      usage?: unknown;
    };
    if (ev.type === 'message_start' && ev.message?.id) {
      const model = ev.message.model ?? this.agent.model;
      this.streamMessage.set(key, { id: ev.message.id, model });
      if (ev.message.usage && typeof ev.message.usage === 'object')
        this.turnCost.add(ev.message.id, model, ev.message.usage as TurnUsage);
    } else if (ev.type === 'message_delta' && ev.usage && typeof ev.usage === 'object') {
      const current = this.streamMessage.get(key);
      if (!current) return;
      this.turnCost.add(current.id, current.model, ev.usage as TurnUsage);
    } else return;
    this.checkTurnBudget();
  }

  /**
   * Interrupts the turn once the larger of two readings reaches `budget.maxBudgetUsd`: the runtime's
   * own estimate (updated as each API response streams in, priced like the SDK) and the SDK's running
   * total minus its value when the turn started. The second catches anything the price table misses
   * (a model the bundled CLI prices differently, managed pricing), one reading behind.
   */
  private checkTurnBudget(): void {
    const cap = this.agent.budget.maxBudgetUsd;
    if (!cap || this.turnBudgetHit) return;
    const spent = Math.max(this.turnCost.totalUsd, this.turnSdkCost);
    if (spent >= cap) {
      this.turnBudgetHit = { estimateUsd: spent, capUsd: cap };
      this.emit({
        ...this.baseEvent(),
        type: 'notification',
        kind: 'budget',
        message: `${this.agent.name} reached the per-turn budget ($${spent.toFixed(2)} of $${cap.toFixed(2)} estimated). Interrupting the turn.`,
      });
      void this.interrupt();
      return;
    }
    this.probeSdkCost();
  }

  private readTurnBase(seq: number): void {
    const q = this.session?.query;
    if (!q) return;
    void sessionCostUsd(q).then((total) => {
      if (seq === this.turnSeq && total !== null) this.turnSdkBase = total;
    });
  }

  /** Ask the SDK for its running total, at most one request in flight and one per interval. */
  private probeSdkCost(): void {
    const q = this.session?.query;
    if (!q || this.costProbeInFlight || this.turnSdkBase === null) return;
    const now = Date.now();
    if (now - this.lastCostProbeAt < COST_PROBE_INTERVAL_MS) return;
    this.lastCostProbeAt = now;
    this.costProbeInFlight = true;
    const seq = this.turnSeq;
    void sessionCostUsd(q)
      .then((total) => {
        if (seq !== this.turnSeq || !this.inTurn || total === null || this.turnSdkBase === null)
          return;
        this.turnSdkCost = Math.max(
          this.turnSdkCost,
          turnCostFromCumulative(total, this.turnSdkBase),
        );
        this.checkTurnBudget();
      })
      .finally(() => {
        this.costProbeInFlight = false;
      });
  }

  /** True when `freshSessionPerTask` is on and the next prompt belongs to another task. */
  private wantsFreshSession(nextTaskId: string | null): boolean {
    if (!this.agent.budget.freshSessionPerTask || !nextTaskId) return false;
    // Nothing to forget: no stored session, or a live process that has not run a prompt yet.
    if (!this.sessionId && !this.session) return false;
    if (this.session && this.sessionClean) return false;
    const previous =
      this.sessionTaskId !== undefined ? this.sessionTaskId : this.lastPromptTaskBeforeQueue();
    return previous !== nextTaskId;
  }

  /**
   * Task of the prompt sent before everything still queued (after a server restart the in-memory
   * marker is gone; a turn cut short by the restart has no `turn_completed`, but its prompt was logged).
   * `undefined` when the log has no earlier prompt.
   */
  private lastPromptTaskBeforeQueue(): string | null | undefined {
    const sent = this.deps.events.list({
      agentId: this.agent.id,
      types: ['message_sent'],
      limit: this.queue.length + 1,
    });
    const before = sent[this.queue.length];
    return before ? (before.taskId ?? null) : undefined;
  }

  /** Forget the session id so the next spawn starts a new conversation instead of resuming. */
  private dropSession(): void {
    this.sessionId = null;
    this.sessionTaskId = undefined;
    this.sessionCostBase = 0;
  }

  /** The cumulative SDK cost saved with the last turn of the session about to be resumed. */
  private savedSessionCost(): number {
    if (!this.sessionId) return 0;
    const last = this.deps.events.latest(this.agent.id, 'turn_completed');
    if (last?.type !== 'turn_completed' || last.sessionId !== this.sessionId) return 0;
    return last.sessionCostUsd ?? 0;
  }

  private handleHook(input: HookInput, toolUseId: string | undefined): void {
    if (input.hook_event_name === 'PreToolUse')
      this.diffs.onPreTool(input.tool_use_id, input.tool_name, input.tool_input);
    for (const ev of normalizeHook(input, toolUseId, this.ctx())) {
      if (ev.type === 'tool_finished' && input.hook_event_name === 'PostToolUse') {
        const diffs = this.diffs.onPostTool(input.tool_use_id, input.tool_name, input.tool_input);
        this.process(diffs.length ? { ...ev, diffs } : ev);
      } else this.process(ev);
    }
  }

  private process(ev: AgentEvent): void {
    switch (ev.type) {
      case 'session_started': {
        this.sessionId = ev.sessionId ?? this.sessionId;
        if (ev.sessionId) this.deps.onSessionId(this.agent.id, ev.sessionId);
        this.deps.onApiKeySource(this.agent.id, ev.apiKeySource);
        this.emit(ev);
        // Check against the credentials this process was spawned with, in both modes: the CLI
        // falls back to other credentials it finds rather than failing.
        const auth = this.sessionAuth ?? this.deps.auth();
        let message: string | null = null;
        if (auth.mode === 'CLAUDE_SUBSCRIPTION' && ev.apiKeySource !== 'none')
          message = `Subscription mode expected the claude.ai login but the session reports apiKeySource="${ev.apiKeySource}". Stopping to avoid API billing.`;
        else if (
          auth.mode === 'API_KEY' &&
          ev.apiKeySource !== 'ANTHROPIC_API_KEY' &&
          !this.sessionExternal?.accepts(ev.apiKeySource)
        )
          message = `API key mode expected the configured API key${this.sessionExternal ? ` or ${this.sessionExternal.label}` : ''} but the session reports apiKeySource="${ev.apiKeySource}". Stopping so it does not run on other credentials (set DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS=1 to allow them).`;
        if (message) {
          this.lastError = message;
          this.emit({ ...this.baseEvent(), type: 'error', kind: 'auth', message });
          void this.stop();
        }
        return;
      }
      case 'tool_started': {
        if (this.startedTools.has(ev.toolUseId)) return;
        this.startedTools.add(ev.toolUseId);
        this.toolInfo.set(ev.toolUseId, { tool: ev.tool, input: ev.input });
        this.emit(ev);
        return;
      }
      case 'tool_finished':
      case 'tool_failed': {
        if (this.finishedTools.has(ev.toolUseId)) return;
        this.finishedTools.add(ev.toolUseId);
        const info = this.toolInfo.get(ev.toolUseId);
        const fixed =
          ev.tool === '?' && info
            ? { ...ev, tool: info.tool, category: classifyTool(info.tool) }
            : ev;
        this.emit(fixed);
        this.toolInfo.delete(ev.toolUseId);
        return;
      }
      case 'error': {
        this.lastError = ev.message;
        this.emit(ev);
        return;
      }
      case 'turn_completed': {
        // total_cost_usd is cumulative for the process: store this turn's share.
        const total = ev.costUsd;
        const costUsd = turnCostFromCumulative(total, this.sessionCostBase);
        if (total > 0) this.sessionCostBase = total;
        const hit = this.turnBudgetHit;
        if (hit) {
          const reason = `Stopped: this turn reached its budget ($${Math.max(costUsd, hit.estimateUsd).toFixed(2)} of $${hit.capUsd.toFixed(2)} estimated). Reply to continue, or raise "Max $ / turn" in the HR desk.`;
          this.emit({ ...ev, ok: false, costUsd, sessionCostUsd: total, errors: [reason] });
          return;
        }
        this.emit({ ...ev, costUsd, sessionCostUsd: total });
        return;
      }
      default:
        this.emit(ev);
    }
  }

  private onTurnEnd(): void {
    this.inTurn = false;
    const taskId = this.currentTaskId;
    const last = this.deps.events.latest(this.agent.id, 'turn_completed');
    if (last && last.type === 'turn_completed') this.deps.onTurn(this.agent.id, taskId, last);
    this.currentTaskId = null;
    this.startedTools.clear();
    this.finishedTools.clear();
    if (this.stopping) return;
    if (this.queue.length && this.status !== 'paused') this.dispatchNext();
    else if (this.status !== 'paused') this.setStatus('idle');
  }

  private readonly handlePermission: CanUseTool = async (toolName, input, opts) => {
    const taskId = this.currentTaskId;
    const category = classifyTool(toolName);
    const requestIdHolder = { id: '' };
    const pending = this.deps.broker.ask(
      {
        agentId: this.agent.id,
        taskId,
        toolUseId: opts.toolUseID,
        tool: toolName,
        input,
        title: opts.title,
        description: opts.description,
        suggestions: opts.suggestions,
      },
      opts.signal,
    );
    const latest = this.deps.broker.pendingForAgent(this.agent.id).at(-1);
    requestIdHolder.id = latest?.id ?? opts.requestId;
    this.setStatus('needs_input');
    this.emit({
      ...this.baseEvent(),
      type: 'permission_requested',
      requestId: requestIdHolder.id,
      toolUseId: opts.toolUseID,
      tool: toolName,
      category,
      input,
      title: opts.title,
      description: opts.description,
      hasSuggestions: Boolean(opts.suggestions?.length),
    });
    const outcome = await pending;
    this.emit({
      ...this.baseEvent(),
      type: 'permission_resolved',
      requestId: requestIdHolder.id,
      tool: toolName,
      category,
      decision: outcome.decision,
      ...(outcome.message ? { message: outcome.message } : {}),
    });
    if (this.status === 'needs_input') this.setStatus(this.inTurn ? 'working' : 'idle');
    return outcome.result;
  };

  /** Defence in depth: file edits must stay inside the working directory. */
  private guard(input: HookInput): string | null {
    if (input.hook_event_name !== 'PreToolUse') return null;
    if (classifyTool(input.tool_name) !== 'edit') return null;
    const rec = (input.tool_input ?? {}) as Record<string, unknown>;
    const p =
      typeof rec.file_path === 'string'
        ? rec.file_path
        : typeof rec.notebook_path === 'string'
          ? rec.notebook_path
          : null;
    if (!p) return null;
    const abs = path.isAbsolute(p) ? p : path.join(this.cwd(), p);
    if (isInside(this.cwd(), abs)) return null;
    return `Deskhaven: writing outside the agent's working directory is not allowed (${abs}). Work inside ${this.cwd()}.`;
  }

  private setStatus(status: AgentStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit({ ...this.baseEvent(), type: 'status', status });
    this.deps.onStatus(this.agent.id, status, status === 'error' ? this.lastError : null);
  }

  private emit(ev: AgentEvent): void {
    try {
      this.deps.events.append(ev);
    } catch (err) {
      this.deps.log.warn(
        { agentId: this.agent.id, type: ev.type, err: String(err) },
        'dropped invalid event',
      );
    }
  }
}

/**
 * Dev aid: when DESKHAVEN_RECORD_SDK points at a file, every raw SDK message is appended as JSONL so
 * real sessions can become normaliser fixtures (`apps/server/test/fixtures`). Off by default.
 */
export function recordSdkMessage(m: SDKMessage, file = envVar(process.env, 'RECORD_SDK')): void {
  if (!file) return;
  try {
    fs.appendFileSync(file, `${JSON.stringify(m)}\n`);
  } catch {
    // recording must never break a session
  }
}
