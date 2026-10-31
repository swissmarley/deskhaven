import { DEFAULT_ROOM_ID, defaultRoom } from '@deskhaven/shared';
import { AgentManager } from '../src/agent/manager.js';
import { PermissionBroker } from '../src/agent/permission-broker.js';
import type { RuntimeDeps } from '../src/agent/runtime.js';
import {
  type AgentSession,
  createPromptQueue,
  type Query,
  type SDKMessage,
  type SessionConfig,
} from '../src/agent/sdk-adapter.js';
import { AgentService } from '../src/agents/service.js';
import type { AuthProvider } from '../src/auth/types.js';
import { openDb } from '../src/db/client.js';
import { EventStore } from '../src/events/store.js';
import { SettingsService } from '../src/settings/service.js';
import { TaskService } from '../src/tasks/service.js';
import type { WorktreeService } from '../src/worktree/service.js';
import { WsHub } from '../src/ws/hub.js';

/** A fake SDK session: records its config and prompts, yields what the test emits. */
export class FakeLiveSession {
  readonly prompts: string[] = [];
  private readonly buffer: SDKMessage[] = [];
  private waiting: ((r: IteratorResult<SDKMessage>) => void) | null = null;
  closed = false;
  constructor(readonly cfg: SessionConfig) {}

  emit(m: Record<string, unknown>): void {
    const msg = { uuid: 'u', session_id: 'sess', ...m } as unknown as SDKMessage;
    const w = this.waiting;
    this.waiting = null;
    if (w) w({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  /** A minimal successful `result`, which ends the current turn. */
  finishTurn(): void {
    this.emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      result: 'done',
      stop_reason: 'end_turn',
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      modelUsage: {},
      permission_denials: [],
    });
  }

  close(): void {
    this.closed = true;
    const w = this.waiting;
    this.waiting = null;
    if (w) w({ value: undefined, done: true });
  }

  asQuery(): Query {
    const q = {
      [Symbol.asyncIterator]: () => q,
      next: (): Promise<IteratorResult<SDKMessage>> => {
        const head = this.buffer.shift();
        if (head) return Promise.resolve({ value: head, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => {
          this.waiting = r;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
      interrupt: async () => ({ still_queued: [] }),
    };
    return q as unknown as Query;
  }
}

export const apiKeyAuth = (key: string | null): AuthProvider => ({
  mode: 'API_KEY',
  probe: async () => ({}) as never,
  childEnv: (b) => (key ? { ...b, ANTHROPIC_API_KEY: key } : { ...b }),
  constraints: () => ({ bindHost: null, defaultConcurrency: 4 }),
});

/** Real AgentService / EventStore / TaskService / AgentManager over an in-memory DB, fake SDK. */
export function managerHarness(
  opts: {
    cap?: number;
    auth?: () => AuthProvider;
    workdir?: string;
    baseEnv?: Record<string, string>;
  } = {},
) {
  const { db } = openDb(':memory:');
  const hub = new WsHub();
  const settings = new SettingsService(db);
  settings.update({ concurrencyCap: opts.cap ?? 1 });
  const events = new EventStore(db, hub);
  const broker = new PermissionBroker({ db, timeoutMs: () => 0, onUpsert: () => {} });
  const room = () => ({ ...defaultRoom(), id: DEFAULT_ROOM_ID });
  const agents = new AgentService(db, hub, settings, room);
  const sessions: FakeLiveSession[] = [];
  const defaultAuth = apiKeyAuth('sk-ant-test-key');
  const startSession: RuntimeDeps['startSession'] = (cfg): AgentSession => {
    const fake = new FakeLiveSession(cfg);
    sessions.push(fake);
    const prompts = createPromptQueue();
    const push = prompts.push.bind(prompts);
    prompts.push = (text: string) => {
      fake.prompts.push(text);
      push(text);
    };
    const end = prompts.end.bind(prompts);
    prompts.end = () => {
      end();
      fake.close();
    };
    return { query: fake.asQuery(), prompts, abort: new AbortController() };
  };
  const desks: number[] = [];
  const manager = new AgentManager({
    agents,
    hub,
    concurrencyCap: () => settings.get().concurrencyCap,
    onDesksChanged: (busy) => desks.push(busy),
    runtimeDeps: {
      auth: opts.auth ?? (() => defaultAuth),
      events,
      broker,
      settings: () => settings.get(),
      baseEnv: () => ({ PATH: '/bin', ...opts.baseEnv }),
      log: { info() {}, warn() {}, error() {}, debug() {} },
      // As in app.ts: the agent's and the day's totals come from the emitted turn.
      onTurn: (id, _taskId, turn) => agents.addUsage(id, turn),
      onApiKeySource: () => {},
      startSession,
      stopGraceMs: 50,
    },
  });
  const tasks = new TaskService(db, hub, {
    manager,
    agents,
    events,
    worktrees: { changedFiles: async () => [] } as unknown as WorktreeService,
    log: { warn() {} },
  });
  events.onEvent((e) => tasks.onEvent(e));
  const hire = (name: string) =>
    agents.create({
      name,
      rolePresetId: 'engineer',
      workdir: opts.workdir ?? process.cwd(),
      useWorktree: false,
    });
  return { db, settings, events, agents, manager, tasks, sessions, hire, desks };
}

export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
