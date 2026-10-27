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
  startAgentSession,
} from './sdk-adapter.js';

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
    const cfg: SessionConfig = {
      cwd: this.cwd(),
      model: sessionModel(this.agent, presetById(this.agent.rolePresetId)),
      systemPromptAppend: this.agent.systemPrompt,
      tools: this.agent.tools,
      allowedTools: this.agent.allowedTools,
      permissionMode: this.agent.permissionMode,
      env,
      additionalDirectories: [],
      // Only Deskhaven's own MCP servers: the user's global connectors must not leak into agents.
      strictMcpConfig: true,
      ...(this.sessionId ? { resume: this.sessionId } : {}),
      ...(this.agent.budget.maxTurns ? { maxTurns: this.agent.budget.maxTurns } : {}),
      ...(this.agent.budget.maxBudgetUsd ? { maxBudgetUsd: this.agent.budget.maxBudgetUsd } : {}),
    };
    const mcp = this.deps.mcpServers?.(this.agent);
    if (mcp) cfg.mcpServers = mcp;
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

  /**
   * The SDK fixes the subprocess env at spawn, so a key added (or removed, or a mode switch) in
   * Settings would never reach a running agent. Between turns the process is ended and respawned on
   * the same session id; the queued prompt then runs with the current credentials.
   */
  private async restartForCredentials(): Promise<void> {
    const s = this.session;
    if (!s || this.restarting) return;
    this.restarting = true;
    const generation = this.stopGeneration;
    this.deps.log.info(
      { agentId: this.agent.id },
      'credentials changed; restarting the session before the next turn',
    );
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
      void this.restartForCredentials();
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    this.lastActivityAt = Date.now();
    this.currentTaskId = next.taskId;
    this.inTurn = true;
    this.setStatus('working');
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
    for (const ev of normalizeSdkMessage(m, this.ctx())) this.process(ev);
    if (m.type === 'result') this.onTurnEnd();
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
