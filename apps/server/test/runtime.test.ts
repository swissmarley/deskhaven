import { type Agent, AgentSchema, emptyUsage } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '../src/agent/permission-broker.js';
import { AgentRuntime, type RuntimeDeps } from '../src/agent/runtime.js';
import type {
  AgentSession,
  HookInput,
  Query,
  SDKMessage,
  SessionCallbacks,
  SessionConfig,
} from '../src/agent/sdk-adapter.js';
import { createPromptQueue } from '../src/agent/sdk-adapter.js';
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

describe('AgentRuntime', () => {
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
});
