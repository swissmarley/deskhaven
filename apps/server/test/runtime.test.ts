import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Agent, AgentSchema, emptyUsage } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '../src/agent/permission-broker.js';
import { AgentRuntime, budgetStopReason, type RuntimeDeps, usd } from '../src/agent/runtime.js';
import {
  type AgentSession,
  buildOptions,
  createPromptQueue,
  type HookInput,
  type Query,
  type SDKMessage,
  type SessionCallbacks,
  type SessionConfig,
} from '../src/agent/sdk-adapter.js';
import { ClaudeSubscriptionAuthProvider } from '../src/auth/subscription.js';
import { openDb } from '../src/db/client.js';
import { EventStore } from '../src/events/store.js';
import { defaultSettings } from '../src/settings/service.js';
import { WsHub } from '../src/ws/hub.js';

/** A controllable stand-in for the SDK Query: tests feed messages and hooks through it. */
class FakeSession {
  readonly messages: SDKMessage[] = [];
  private waiting: ((r: IteratorResult<SDKMessage>) => void) | null = null;
  private closed = false;
  interrupts = 0;
  /** What the experimental get_usage control request reports; null = not supported. */
  sdkTotal: number | null = null;
  usageCalls = 0;
  constructor(
    readonly cfg: SessionConfig,
    readonly cb: SessionCallbacks,
  ) {}
  emit(m: Record<string, unknown>) {
    const msg = { uuid: 'u', session_id: 'sess-1', ...m } as unknown as SDKMessage;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: msg, done: false });
    } else this.messages.push(msg);
  }
  hook(h: Record<string, unknown>) {
    this.cb.onHook(
      {
        session_id: 'sess-1',
        transcript_path: '/t',
        cwd: this.cfg.cwd,
        ...h,
      } as unknown as HookInput,
      undefined,
    );
  }
  close() {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }
  asQuery(): Query {
    const self = this;
    const q = {
      [Symbol.asyncIterator]() {
        return q;
      },
      next(): Promise<IteratorResult<SDKMessage>> {
        const head = self.messages.shift();
        if (head) return Promise.resolve({ value: head, done: false });
        if (self.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => {
          self.waiting = r;
        });
      },
      return() {
        self.closed = true;
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(e: unknown) {
        return Promise.reject(e);
      },
      interrupt: async () => {
        self.interrupts++;
        return { still_queued: [] };
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        self.usageCalls++;
        if (self.sdkTotal === null) throw new Error('unsupported');
        return { session: { total_cost_usd: self.sdkTotal } };
      },
    };
    return q as unknown as Query;
  }
}

function setup(over: Partial<Agent> = {}, mode: 'API_KEY' | 'CLAUDE_SUBSCRIPTION' = 'API_KEY') {
  const { db } = openDb(':memory:');
  const hub = new WsHub();
  const events = new EventStore(db, hub);
  const broker = new PermissionBroker({ db, timeoutMs: () => 0, onUpsert: () => {} });
  const agent = AgentSchema.parse({
    id: 'a1',
    name: 'Ada',
    avatar: {
      skin: '#fff',
      hair: '#000',
      hairStyle: 'short',
      shirt: '#f00',
      pants: '#00f',
      accessory: 'none',
    },
    rolePresetId: 'engineer',
    systemPrompt: 'be good',
    model: 'claude-sonnet-5-5',
    tools: null,
    allowedTools: ['Read'],
    permissionMode: 'default',
    workdir: process.cwd(),
    worktree: null,
    sessionId: null,
    status: 'stopped',
    roomId: 'lobby',
    deskId: null,
    budget: { maxTurns: 5 },
    currentTaskId: null,
    usage: emptyUsage(),
    lastError: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
  const sessions: FakeSession[] = [];
  const calls = {
    sessionIds: [] as string[],
    statuses: [] as string[],
    turns: [] as (string | null)[],
    stopped: 0,
  };
  const auth =
    mode === 'CLAUDE_SUBSCRIPTION'
      ? new ClaudeSubscriptionAuthProvider({
          env: {},
          policyCheckedAt: '',
          probeFn: async () => ({ loggedIn: true }),
        })
      : {
          mode: 'API_KEY' as const,
          probe: async () => ({}) as never,
          childEnv: (b: Record<string, string | undefined>) => ({ ...b, ANTHROPIC_API_KEY: 'k' }),
          constraints: () => ({ bindHost: null, defaultConcurrency: 4 }),
        };
  const deps: RuntimeDeps = {
    auth: () => auth,
    events,
    broker,
    settings: () => defaultSettings(),
    baseEnv: () => ({ PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDE_CODE_OAUTH_TOKEN: 'o' }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
    onSessionId: (_id, s) => calls.sessionIds.push(s),
    onStatus: (_id, s) => calls.statuses.push(s),
    onTurn: (_id, taskId) => calls.turns.push(taskId),
    onApiKeySource: () => {},
    onStopped: () => calls.stopped++,
    stopGraceMs: 200,
    startSession: (cfg, cb): AgentSession => {
      const fake = new FakeSession(cfg, cb);
      sessions.push(fake);
      const prompts = createPromptQueue();
      // The real CLI exits when its input stream ends; the fake does the same.
      const end = prompts.end.bind(prompts);
      prompts.end = () => {
        end();
        fake.close();
      };
      return { query: fake.asQuery(), prompts, abort: new AbortController() };
    },
  };
  const rt = new AgentRuntime(agent, deps);
  const all = () => events.list({ ascending: true, limit: 1000 });
  return { rt, sessions, calls, all, events, broker };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A real folder standing in for a worktree (the runtime refuses to start in a missing one). */
function fakeWorktree(subdir?: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-wt-')));
  if (subdir) fs.mkdirSync(path.join(dir, subdir), { recursive: true });
  return dir;
}

describe('AgentRuntime', () => {
  it('scopes the cwd and the edit guard to the hired subfolder of a worktree', () => {
    const wt = fakeWorktree('packages/app');
    const { rt, sessions } = setup({
      worktree: { path: wt, branch: 'b', subdir: 'packages/app' },
    });
    rt.sendPrompt('hi', null);
    const s = sessions[0];
    if (!s) throw new Error('no session');
    expect(s.cfg.cwd).toBe(`${wt}/packages/app`);
    const edit = (file_path: string) =>
      s.cb.preToolGuard?.({
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path },
        tool_use_id: 't',
        session_id: 's',
        transcript_path: '/t',
        cwd: s.cfg.cwd,
      } as unknown as HookInput);
    expect(edit(`${wt}/packages/app/src/x.ts`)).toBeNull();
    expect(edit('src/relative.ts')).toBeNull();
    expect(edit(`${wt}/README.md`)).toMatch(/outside/);
    expect(edit(`${wt}/packages/other/y.ts`)).toMatch(/outside/);
  });

  it('runs in the agent worktree when it has one', () => {
    const wt = fakeWorktree();
    const { rt, sessions } = setup({ worktree: { path: wt, branch: 'b' } });
    rt.sendPrompt('hi', null);
    expect(sessions[0]?.cfg.cwd).toBe(wt);
  });

  it('runs a prompt through a full turn, dedupes tool events, attributes the turn to the task', async () => {
    const { rt, sessions, calls, all } = setup();
    rt.sendPrompt('fix the bug', 'task1');
    expect(rt.isRunning()).toBe(true);
    const s = sessions[0];
    if (!s) throw new Error('no session');
    expect(s.cfg.env.ANTHROPIC_API_KEY).toBe('k');
    expect(s.cfg.permissionMode).toBe('default');
    expect(s.cfg.maxTurns).toBe(5);
    expect(rt.getStatus()).toBe('working');

    s.emit({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-5-5',
      tools: ['Read'],
      permissionMode: 'default',
      apiKeySource: 'ANTHROPIC_API_KEY',
      claude_code_version: '2.1.287',
      cwd: s.cfg.cwd,
      mcp_servers: [],
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
    });
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } }],
      },
    });
    await tick();
    s.hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_use_id: 't1',
    });
    s.hook({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'README.md' },
      tool_response: 'contents',
      tool_use_id: 't1',
      duration_ms: 12,
    });
    s.emit({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contents', is_error: false }],
      },
    });
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'All good.' }] },
    });
    s.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 1,
      result: 'All good.',
      stop_reason: 'end_turn',
      total_cost_usd: 0.01,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
    });
    await tick();

    const types = all().map((e) => e.type);
    expect(types.filter((t) => t === 'tool_started')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool_finished')).toHaveLength(1);
    expect(types).toContain('session_started');
    expect(types).toContain('assistant_text');
    const turn = all().find((e) => e.type === 'turn_completed');
    expect(turn).toMatchObject({ taskId: 'task1', ok: true, costUsd: 0.01 });
    expect(calls.turns).toEqual(['task1']);
    expect(calls.sessionIds).toEqual(['sess-1']);
    expect(rt.getStatus()).toBe('idle');
    expect(rt.getCurrentTaskId()).toBeNull();

    await rt.stop();
    expect(rt.getStatus()).toBe('stopped');
    expect(rt.isRunning()).toBe(false);
    expect(calls.stopped).toBeGreaterThan(0);
  });

  it('routes permission requests through the broker and emits requested/resolved events', async () => {
    const { rt, sessions, broker, all } = setup();
    rt.sendPrompt('run tests', null);
    const s = sessions[0];
    if (!s) throw new Error('no session');
    const decision = s.cb.canUseTool(
      'Bash',
      { command: 'pnpm test' },
      {
        signal: new AbortController().signal,
        toolUseID: 'tb',
        requestId: 'r1',
        title: 'Run pnpm test?',
      },
    );
    await tick();
    expect(rt.getStatus()).toBe('needs_input');
    const pending = broker.listPending();
    expect(pending).toHaveLength(1);
    expect(all().find((e) => e.type === 'permission_requested')).toMatchObject({
      tool: 'Bash',
      category: 'bash',
      title: 'Run pnpm test?',
    });
    broker.resolve(pending[0]?.id ?? '', 'allow');
    expect(await decision).toEqual({ behavior: 'allow' });
    await tick();
    expect(all().find((e) => e.type === 'permission_resolved')).toMatchObject({
      decision: 'allow',
      tool: 'Bash',
    });
    expect(rt.getStatus()).toBe('working');
    await rt.stop();
  });

  it('passes extra read dirs at spawn and again on resume when they change', async () => {
    const engineer = fakeWorktree();
    const { rt, sessions } = setup({ sessionId: 'sess-keep' });
    rt.setExtraReadDirs([engineer, engineer]);
    rt.start();
    const first = sessions[0];
    if (!first) throw new Error('no session');
    expect(first.cfg.additionalDirectories).toEqual([engineer]);
    expect(first.cfg.resume).toBe('sess-keep');
    rt.setExtraReadDirs([`${engineer}/nested`]);
    rt.sendPrompt('review the branch', 'task-review');
    const deadline = Date.now() + 1000;
    while (sessions.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const second = sessions[1];
    if (!second) throw new Error('session was not restarted');
    expect(second.cfg.resume).toBe('sess-keep');
    expect(second.cfg.additionalDirectories).toEqual([`${engineer}/nested`]);
    const edit = second.cb.preToolGuard?.({
      session_id: 's',
      transcript_path: '/t',
      cwd: second.cfg.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: path.join(engineer, 'secret.ts') },
      tool_use_id: 'e',
    } as HookInput);
    expect(edit).toMatch(/not allowed/);
    const read = second.cb.preToolGuard?.({
      session_id: 's',
      transcript_path: '/t',
      cwd: second.cfg.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: path.join(engineer, 'secret.ts') },
      tool_use_id: 'r',
    } as HookInput);
    expect(read).toBeNull();
    await rt.stop();
  });

  it('asks the SDK for resume and additionalDirectories on the same process', () => {
    const options = buildOptions(
      {
        cwd: '/reviewer',
        model: 'm',
        systemPromptAppend: '',
        tools: null,
        allowedTools: [],
        permissionMode: 'default',
        env: {},
        resume: 'sess-9',
        additionalDirectories: ['/engineer/wt'],
        strictMcpConfig: true,
      },
      {
        onMessage: () => {},
        onHook: () => {},
        canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'no' }),
      },
      new AbortController(),
    );
    expect(options.resume).toBe('sess-9');
    expect(options.additionalDirectories).toEqual(['/engineer/wt']);
    expect(options.strictMcpConfig).toBe(true);
  });

  it('blocks edits outside the working directory via the PreToolUse guard', () => {
    const { rt, sessions } = setup();
    rt.start();
    const s = sessions[0];
    if (!s) throw new Error('no session');
    const outside = s.cb.preToolGuard?.({
      session_id: 's',
      transcript_path: '/t',
      cwd: s.cfg.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: '/etc/passwd' },
      tool_use_id: 'x',
    } as HookInput);
    expect(outside).toMatch(/not allowed/);
    const inside = s.cb.preToolGuard?.({
      session_id: 's',
      transcript_path: '/t',
      cwd: s.cfg.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'src/a.ts' },
      tool_use_id: 'y',
    } as HookInput);
    expect(inside).toBeNull();
    const read = s.cb.preToolGuard?.({
      session_id: 's',
      transcript_path: '/t',
      cwd: s.cfg.cwd,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/passwd' },
      tool_use_id: 'z',
    } as HookInput);
    expect(read).toBeNull();
  });

  it('in subscription mode strips auth vars and stops when the session reports an API key', async () => {
    const { rt, sessions, all } = setup({}, 'CLAUDE_SUBSCRIPTION');
    rt.start();
    const s = sessions[0];
    if (!s) throw new Error('no session');
    expect(s.cfg.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(s.cfg.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(s.cfg.env.PATH).toBe('/bin');
    s.emit({
      type: 'system',
      subtype: 'init',
      model: 'm',
      tools: [],
      permissionMode: 'default',
      apiKeySource: 'ANTHROPIC_API_KEY',
      claude_code_version: '1',
      cwd: '/',
      mcp_servers: [],
      slash_commands: [],
      output_style: 'd',
      skills: [],
      plugins: [],
    });
    await tick();
    s.close();
    await tick();
    expect(all().find((e) => e.type === 'error')).toMatchObject({
      kind: 'auth',
      message: expect.stringContaining('apiKeySource'),
    });
    expect(rt.getStatus()).toBe('stopped');
  });

  it('pauses, queues prompts, and resumes', async () => {
    const { rt, sessions } = setup();
    rt.start();
    await rt.pause();
    expect(rt.getStatus()).toBe('paused');
    rt.sendPrompt('later', null);
    expect(rt.queuedCount()).toBe(1);
    rt.resume();
    await tick();
    expect(rt.getStatus()).toBe('working');
    expect(rt.queuedCount()).toBe(0);
    expect(sessions[0]?.interrupts ?? 0).toBe(0); // nothing was in flight when paused
    await rt.stop();
  });

  it('interrupts a turn as soon as the running cost estimate reaches budget.maxBudgetUsd', async () => {
    const { rt, sessions, all } = setup({ budget: { maxBudgetUsd: 0.3 } });
    rt.sendPrompt('small fix', 'task1');
    const s = sessions[0];
    if (!s) throw new Error('no session');
    // The SDK's own cap is cumulative per process and checked late; the runtime enforces it instead.
    expect(s.cfg.maxBudgetUsd).toBeUndefined();
    const assistant = (id: string, usage: Record<string, unknown>) =>
      s.emit({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id,
          model: 'claude-sonnet-5-5',
          role: 'assistant',
          content: [{ type: 'text', text: 'working' }],
          usage,
        },
      });
    // 38k cache writes (1h TTL) + 75k cache reads on Sonnet 5.5 ≈ $0.17: under the cap.
    assistant('m1', {
      input_tokens: 2,
      cache_creation_input_tokens: 38_000,
      cache_read_input_tokens: 75_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 38_000 },
      output_tokens: 100,
    });
    // The same streamed response again must not be counted twice.
    assistant('m1', {
      input_tokens: 2,
      cache_creation_input_tokens: 38_000,
      cache_read_input_tokens: 75_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 38_000 },
      output_tokens: 120,
    });
    await tick();
    expect(s.interrupts).toBe(0);
    // A second API call re-reads the cache and writes more: the estimate crosses $0.30.
    assistant('m2', {
      input_tokens: 2,
      cache_creation_input_tokens: 30_000,
      cache_read_input_tokens: 113_000,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 30_000 },
      output_tokens: 200,
    });
    await tick();
    expect(s.interrupts).toBe(1);
    const notice = all().find((e) => e.type === 'notification' && e.kind === 'budget');
    expect(notice).toMatchObject({ taskId: 'task1' });
    s.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      duration_ms: 100,
      duration_api_ms: 90,
      num_turns: 2,
      stop_reason: null,
      total_cost_usd: 0.31,
      usage: { input_tokens: 4, output_tokens: 320 },
      modelUsage: {},
      permission_denials: [],
      errors: [],
    });
    await tick();
    const turn = all().find((e) => e.type === 'turn_completed');
    expect(turn).toMatchObject({ ok: false, taskId: 'task1' });
    // Interrupted: the larger of the SDK's $0.31 and the runtime's estimate when it stopped.
    expect(turn?.type === 'turn_completed' && turn.costUsd).toBeGreaterThanOrEqual(0.31);
    expect(turn?.type === 'turn_completed' && turn.errors?.[0]).toMatch(/reached its budget/);
    expect(rt.getStatus()).toBe('idle');
    await rt.stop();
  });

  it("stores each turn's share of the SDK's cumulative total_cost_usd", async () => {
    const { rt, sessions, all } = setup();
    const s0 = () => sessions[0] as FakeSession;
    const result = (total: number) =>
      s0().emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: 'ok',
        stop_reason: 'end_turn',
        total_cost_usd: total,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      });
    rt.sendPrompt('one', 't1');
    result(0.1651324);
    await tick();
    rt.sendPrompt('two', 't1');
    result(0.185327);
    await tick();
    const turns = all().filter((e) => e.type === 'turn_completed');
    expect(turns.map((t) => (t.type === 'turn_completed' ? t.costUsd : 0))).toEqual([
      0.1651324,
      expect.closeTo(0.0201946, 6),
    ]);
    expect(turns[1]).toMatchObject({ sessionCostUsd: 0.185327 });
    await rt.stop();
  });

  it('resumes the cumulative cost baseline saved with the last turn of the session', async () => {
    const { rt, sessions, all, events } = setup({ sessionId: 'sess-1' });
    events.append({
      id: 'old-turn',
      ts: 1,
      agentId: 'a1',
      sessionId: 'sess-1',
      type: 'turn_completed',
      ok: true,
      subtype: 'success',
      costUsd: 0.05,
      sessionCostUsd: 0.4,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 1,
      durationMs: 1,
    });
    rt.sendPrompt('again', 't1');
    const s = sessions[0];
    if (!s) throw new Error('no session');
    expect(s.cfg.resume).toBe('sess-1');
    s.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0.45,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
    });
    await tick();
    const turn = all()
      .filter((e) => e.type === 'turn_completed')
      .at(-1);
    expect(turn?.type === 'turn_completed' && turn.costUsd).toBeCloseTo(0.05, 6);
    await rt.stop();
  });

  it('starts a fresh session for a new task when freshSessionPerTask is on', async () => {
    const { rt, sessions } = setup({
      sessionId: 'sess-old',
      budget: { freshSessionPerTask: true },
    });
    const finish = (s: FakeSession) =>
      s.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: 'ok',
        stop_reason: 'end_turn',
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      });
    // No turn of task A was ever run in sess-old, so task A starts clean.
    rt.sendPrompt('task A', 'A');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.cfg.resume).toBeUndefined();
    finish(sessions[0] as FakeSession);
    await tick();
    // A reply about the same task stays in the live session.
    rt.sendPrompt('more on A', 'A');
    await tick();
    expect(sessions).toHaveLength(1);
    finish(sessions[0] as FakeSession);
    await tick();
    // Another task restarts the process without resume.
    rt.sendPrompt('task B', 'B');
    await new Promise((r) => setTimeout(r, 50));
    expect(sessions).toHaveLength(2);
    expect(sessions[1]?.cfg.resume).toBeUndefined();
    expect(rt.getStatus()).toBe('working');
    await rt.stop();
  });

  it('keeps the session for a reply to the task a restart interrupted', async () => {
    const { rt, sessions, events } = setup({
      sessionId: 'sess-old',
      budget: { freshSessionPerTask: true },
    });
    // Logged before the server restarted; that turn never completed.
    events.append({
      id: 'sent-a',
      ts: 1,
      agentId: 'a1',
      taskId: 'A',
      type: 'message_sent',
      text: 'task A',
    });
    rt.sendPrompt('continue', 'A');
    expect(sessions[0]?.cfg.resume).toBe('sess-old');
    await rt.stop();
  });

  it("gives an agent without its own tool list the preset's tools, not the whole surface", () => {
    const { rt, sessions } = setup({ tools: null, rolePresetId: 'engineer' });
    rt.sendPrompt('hi', null);
    expect(sessions[0]?.cfg.tools).toEqual(['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep']);
    const own = setup({ tools: ['Read'], rolePresetId: 'engineer' });
    own.rt.sendPrompt('hi', null);
    expect(own.sessions[0]?.cfg.tools).toEqual(['Read']);
  });

  it('keeps resuming across tasks when freshSessionPerTask is off', async () => {
    const { rt, sessions } = setup({ sessionId: 'sess-old' });
    rt.sendPrompt('task A', 'A');
    expect(sessions[0]?.cfg.resume).toBe('sess-old');
    await rt.stop();
  });

  it('interrupts a Haiku 5.5 turn the SDK prices at the default-model rate', async () => {
    const { rt, sessions, all } = setup({
      model: 'claude-haiku-5-5',
      budget: { maxBudgetUsd: 0.1 },
    });
    rt.sendPrompt('small fix', 'task1');
    const s = sessions[0] as FakeSession;
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'h1',
        model: 'claude-haiku-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'reading' }],
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 32_000,
          cache_read_input_tokens: 63_000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 32_000 },
          output_tokens: 50,
        },
      },
    });
    await tick();
    expect(s.interrupts).toBe(1);
    expect(all().some((e) => e.type === 'notification' && e.kind === 'budget')).toBe(true);
    await rt.stop();
  });

  it('counts the final output tokens from streamed message_delta events', async () => {
    const { rt, sessions } = setup({ budget: { maxBudgetUsd: 0.05 } });
    rt.sendPrompt('write a lot', 't1');
    const s = sessions[0] as FakeSession;
    s.emit({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: {
          id: 'm1',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      },
    });
    await tick();
    expect(s.interrupts).toBe(0);
    // 6,000 output tokens on Sonnet 5.5 = $0.06: only the delta reports them.
    s.emit({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_delta', delta: {}, usage: { output_tokens: 6_000 } },
    });
    await tick();
    expect(s.interrupts).toBe(1);
    await rt.stop();
  });

  it("also stops when the SDK's running total for the turn reaches the cap", async () => {
    const { rt, sessions } = setup({ model: 'claude-haiku-4-5', budget: { maxBudgetUsd: 0.1 } });
    rt.sendPrompt('first', 't1');
    const s = sessions[0] as FakeSession;
    s.sdkTotal = 0.5; // cumulative before this turn
    await tick();
    rt.sendPrompt('ignored until the turn ends', 't1');
    const finish = () =>
      s.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: 'ok',
        stop_reason: 'end_turn',
        total_cost_usd: s.sdkTotal,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
      });
    finish();
    await tick(); // the second prompt is dispatched; its baseline reading is 0.5
    expect(s.usageCalls).toBeGreaterThan(0);
    // The table prices this response at well under $0.10, but the SDK says the turn cost $0.15.
    s.sdkTotal = 0.65;
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'x1',
        model: 'claude-haiku-4-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, output_tokens: 100 },
      },
    });
    await tick();
    await tick();
    expect(s.interrupts).toBe(1);
    await rt.stop();
  });

  it('keeps working on its own estimate when the SDK cannot report a running total', async () => {
    const { rt, sessions } = setup({ budget: { maxBudgetUsd: 1 } });
    rt.sendPrompt('go', 't1');
    const s = sessions[0] as FakeSession;
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'a',
        model: 'claude-sonnet-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 10, output_tokens: 10 },
      },
    });
    await tick();
    expect(s.interrupts).toBe(0);
    expect(rt.getStatus()).toBe('working');
    await rt.stop();
  });

  it('words budget amounts with three decimals so the notice and the final cost agree', () => {
    expect(usd(0.0214)).toBe('$0.021');
    expect(usd(0.02)).toBe('$0.020');
    const reason = budgetStopReason(0.04, 0.0214, 0.02);
    expect(reason).toContain('budget of $0.020');
    expect(reason).toContain('interrupted at $0.021');
    expect(reason).toContain('the turn cost $0.040');
    expect(budgetStopReason(0.0214, 0.0214, 0.02)).not.toContain('the turn cost');
  });

  it('stores an interrupted turn at its own estimate when the SDK reports $0 and 0 tokens', async () => {
    const { rt, sessions, all } = setup({ budget: { maxBudgetUsd: 0.02 } });
    rt.sendPrompt('small fix', 'f4e2b15e');
    const s = sessions[0] as FakeSession;
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
    expect(s.interrupts).toBe(1);
    // The interrupted call is not in the SDK's result.
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
    await tick();
    const turn = all().find((e) => e.type === 'turn_completed');
    if (turn?.type !== 'turn_completed') throw new Error('no turn');
    // 10k cache writes at $4/M + 20k reads at $0.20/M + 300 output at $10/M + 5 input = $0.04701
    expect(turn.costUsd).toBeCloseTo(0.04701, 8);
    expect(turn).toMatchObject({
      ok: false,
      inputTokens: 5,
      outputTokens: 300,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 10_000,
    });
    expect(turn.errors?.[0]).toContain('interrupted at $0.047');
    await rt.stop();
  });

  it('keeps the SDK figure for a turn that ended normally', async () => {
    const { rt, sessions, all } = setup();
    rt.sendPrompt('go', 't1');
    const s = sessions[0] as FakeSession;
    s.emit({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'm1',
        model: 'claude-sonnet-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 100_000, output_tokens: 10 },
      },
    });
    s.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'ok',
      stop_reason: 'end_turn',
      total_cost_usd: 0.15,
      usage: { input_tokens: 100_000, output_tokens: 10 },
      modelUsage: {},
      permission_denials: [],
    });
    await tick();
    const turn = all().find((e) => e.type === 'turn_completed');
    expect(turn).toMatchObject({ costUsd: 0.15 });
    await rt.stop();
  });

  it("logs a prompt with the session it will run in, and without another turn's task", async () => {
    const { rt, sessions, events, all } = setup({
      sessionId: 'sess-old',
      budget: { freshSessionPerTask: true },
    });
    events.append({
      id: 'prev',
      ts: 1,
      agentId: 'a1',
      taskId: 'A',
      type: 'message_sent',
      text: 'A',
    });
    rt.sendPrompt('more on A', 'A'); // same task: resumes sess-old
    rt.sendPrompt('a chat line', null); // not a task prompt
    const sent = all().filter((e) => e.type === 'message_sent' && e.id !== 'prev');
    expect(sent[0]).toMatchObject({ sessionId: 'sess-old', taskId: 'A' });
    expect(sent[1]?.taskId).toBeUndefined();
    await rt.stop();
    // A new task starts a fresh session: its prompt must not claim sess-old.
    const fresh = setup({ sessionId: 'sess-old', budget: { freshSessionPerTask: true } });
    fresh.events.append({
      id: 'p',
      ts: 1,
      agentId: 'a1',
      taskId: 'A',
      type: 'message_sent',
      text: 'A',
    });
    fresh.rt.sendPrompt('task B', 'B');
    const b = fresh.all().find((e) => e.type === 'message_sent' && e.taskId === 'B');
    expect(b?.sessionId).toBeUndefined();
    expect(fresh.sessions[0]?.cfg.resume).toBeUndefined();
    void sessions;
    await fresh.rt.stop();
  });
});
