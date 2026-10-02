import {
  type Agent,
  type AgentEvent,
  type Behavior,
  IDLE,
  mapEventToBehavior,
  type PermissionRequest,
  type Room,
  type ServerMessage,
  type Settings,
  type Task,
  type UsageSnapshot,
} from '@agenthotel/shared';
import { create } from 'zustand';
import type { ConnectionState } from '../net/ws.js';
import { worldBus } from './bus.js';

const FEED_LIMIT = 1500;
const TRANSCRIPT_LIMIT = 600;
const FEED_HIDDEN = new Set<AgentEvent['type']>(['text_delta', 'thinking_delta', 'unknown']);

export interface Notice {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  agentId?: string;
}

export interface AppState {
  connection: ConnectionState;
  serverVersion: string | null;
  agents: Record<string, Agent>;
  tasks: Record<string, Task>;
  rooms: Record<string, Room>;
  settings: Settings | null;
  usage: UsageSnapshot | null;
  killSwitch: boolean;
  /** Pending permission requests by id. */
  permissions: Record<string, PermissionRequest>;
  /** Global feed (persisted event types only), oldest first. */
  feed: AgentEvent[];
  transcripts: Record<string, AgentEvent[]>;
  /** Streaming text of the current turn per agent. */
  liveText: Record<string, string>;
  behaviors: Record<string, Behavior>;
  openTools: Record<string, string[]>;
  seeds: Record<string, number>;
  lastSeq: number;
  selectedAgentId: string | null;
  sideTab: 'agents' | 'inspector' | 'feed' | 'settings' | 'board';
  boardOpen: boolean;
  notices: Notice[];
  soundEnabled: boolean;

  setConnection: (c: ConnectionState) => void;
  applyServerMessage: (m: ServerMessage) => void;
  selectAgent: (id: string | null) => void;
  setSideTab: (tab: AppState['sideTab']) => void;
  setBoardOpen: (open: boolean) => void;
  pushNotice: (level: Notice['level'], message: string, agentId?: string) => void;
  dismissNotice: (id: number) => void;
  setSoundEnabled: (on: boolean) => void;
}

let noticeSeq = 0;

export const useAppStore = create<AppState>((set, get) => ({
  connection: 'closed',
  serverVersion: null,
  agents: {},
  tasks: {},
  rooms: {},
  settings: null,
  usage: null,
  killSwitch: false,
  permissions: {},
  feed: [],
  transcripts: {},
  liveText: {},
  behaviors: {},
  openTools: {},
  seeds: {},
  lastSeq: 0,
  selectedAgentId: null,
  sideTab: 'agents',
  boardOpen: true,
  notices: [],
  soundEnabled: true,

  setConnection: (connection) => set({ connection }),
  selectAgent: (selectedAgentId) =>
    set({ selectedAgentId, sideTab: selectedAgentId ? 'inspector' : get().sideTab }),
  setSideTab: (sideTab) => set({ sideTab }),
  setBoardOpen: (boardOpen) => set({ boardOpen }),
  pushNotice: (level, message, agentId) =>
    set((s) => ({
      notices: [...s.notices.slice(-9), { id: ++noticeSeq, level, message, agentId }],
    })),
  dismissNotice: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  setSoundEnabled: (soundEnabled) => set({ soundEnabled }),

  applyServerMessage: (m) => {
    switch (m.type) {
      case 'hello': {
        const agents = Object.fromEntries(m.agents.map((a) => [a.id, a]));
        const behaviors: Record<string, Behavior> = {};
        for (const a of m.agents) behaviors[a.id] = get().behaviors[a.id] ?? initialBehavior(a);
        set({
          serverVersion: m.version,
          agents,
          tasks: Object.fromEntries(m.tasks.map((t) => [t.id, t])),
          rooms: Object.fromEntries(m.rooms.map((r) => [r.id, r])),
          settings: m.settings,
          usage: m.usage,
          killSwitch: m.usage.killSwitch,
          permissions: Object.fromEntries(m.pendingPermissions.map((p) => [p.id, p])),
          behaviors,
          soundEnabled: m.settings.soundEnabled,
        });
        break;
      }
      case 'pong':
        break;
      case 'event':
        applyEvent(m.event, set, get, true);
        break;
      case 'events_batch':
        for (const e of m.events) applyEvent(e, set, get, false);
        break;
      case 'agent_upserted':
        set((s) => ({
          agents: { ...s.agents, [m.agent.id]: m.agent },
          behaviors: s.behaviors[m.agent.id]
            ? s.behaviors
            : { ...s.behaviors, [m.agent.id]: initialBehavior(m.agent) },
        }));
        break;
      case 'agent_removed':
        set((s) => {
          const agents = { ...s.agents };
          delete agents[m.agentId];
          const behaviors = { ...s.behaviors };
          delete behaviors[m.agentId];
          return {
            agents,
            behaviors,
            selectedAgentId: s.selectedAgentId === m.agentId ? null : s.selectedAgentId,
          };
        });
        break;
      case 'task_upserted':
        set((s) => ({ tasks: { ...s.tasks, [m.task.id]: m.task } }));
        break;
      case 'task_removed':
        set((s) => {
          const tasks = { ...s.tasks };
          delete tasks[m.taskId];
          return { tasks };
        });
        break;
      case 'room_updated':
        set((s) => ({ rooms: { ...s.rooms, [m.room.id]: m.room } }));
        break;
      case 'settings_updated':
        set({ settings: m.settings, soundEnabled: m.settings.soundEnabled });
        break;
      case 'permission_upserted':
        set((s) => {
          const permissions = { ...s.permissions };
          if (m.request.status === 'pending') permissions[m.request.id] = m.request;
          else delete permissions[m.request.id];
          return { permissions };
        });
        break;
      case 'usage':
        set({ usage: m.usage, killSwitch: m.usage.killSwitch });
        break;
      case 'notice':
        get().pushNotice(m.level, m.message, m.agentId);
        break;
      case 'kill_switch':
        set({ killSwitch: m.active });
        break;
    }
  },
}));

function initialBehavior(a: Agent): Behavior {
  switch (a.status) {
    case 'paused':
      return { kind: 'nap' };
    case 'stopped':
      return { kind: 'leave' };
    case 'waiting':
      return { kind: 'wait' };
    default:
      return IDLE;
  }
}

type Set = (fn: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;
type Get = () => AppState;

function applyEvent(event: AgentEvent, set: Set, get: Get, live: boolean): void {
  const s = get();
  const agentId = event.agentId;
  // open-tool bookkeeping first so the behaviour mapping sees the post-event state
  let open = s.openTools[agentId] ?? [];
  if (event.type === 'tool_started')
    open = open.includes(event.toolUseId) ? open : [...open, event.toolUseId];
  else if (event.type === 'tool_finished' || event.type === 'tool_failed')
    open = open.filter((t) => t !== event.toolUseId);
  else if (
    event.type === 'turn_completed' ||
    event.type === 'interrupted' ||
    (event.type === 'status' && event.status === 'stopped')
  )
    open = [];

  const seed = (s.seeds[agentId] ?? 0) + 1;
  const current = s.behaviors[agentId] ?? IDLE;
  const behavior = mapEventToBehavior(event, {
    current,
    hasOpenTool: open.length > 0,
    seed: event.seq ?? seed,
  });
  const behaviorChanged = JSON.stringify(behavior) !== JSON.stringify(current);

  const patch: Partial<AppState> = {
    openTools: { ...s.openTools, [agentId]: open },
    seeds: { ...s.seeds, [agentId]: seed },
    behaviors: behaviorChanged ? { ...s.behaviors, [agentId]: behavior } : s.behaviors,
    lastSeq: Math.max(s.lastSeq, event.seq ?? 0),
  };

  if (event.type === 'text_delta') {
    if (!event.parentToolUseId)
      patch.liveText = { ...s.liveText, [agentId]: (s.liveText[agentId] ?? '') + event.text };
  } else {
    if (
      event.type === 'assistant_text' ||
      event.type === 'turn_completed' ||
      event.type === 'message_sent'
    ) {
      patch.liveText = { ...s.liveText, [agentId]: '' };
    }
    if (!FEED_HIDDEN.has(event.type)) {
      const feed = [...s.feed, event];
      patch.feed = feed.length > FEED_LIMIT ? feed.slice(feed.length - FEED_LIMIT) : feed;
      const t = [...(s.transcripts[agentId] ?? []), event];
      patch.transcripts = {
        ...s.transcripts,
        [agentId]: t.length > TRANSCRIPT_LIMIT ? t.slice(t.length - TRANSCRIPT_LIMIT) : t,
      };
    }
  }
  if (event.type === 'error' && live) {
    const label =
      event.kind === 'auth'
        ? 'Authentication'
        : event.kind === 'rate_limit'
          ? 'Rate limit'
          : event.kind === 'billing'
            ? 'Billing'
            : 'Error';
    patch.notices = [
      ...s.notices.slice(-9),
      { id: ++noticeSeq, level: 'error', message: `${label}: ${event.message}`, agentId },
    ];
  }
  if (event.type === 'rate_limit' && event.status !== 'allowed' && live) {
    const when = event.resetsAt
      ? ` (resets ${new Date(event.resetsAt * (event.resetsAt < 1e12 ? 1000 : 1)).toLocaleTimeString()})`
      : '';
    patch.notices = [
      ...s.notices.slice(-9),
      {
        id: ++noticeSeq,
        level: event.status === 'rejected' ? 'error' : 'warn',
        message: `Plan limit ${event.windowType ?? ''} ${event.status === 'rejected' ? 'reached' : 'nearly reached'}${when}`,
        agentId,
      },
    ];
  }
  set(patch);
  if (live) worldBus.emit({ event, behavior, behaviorChanged });
}

export const selectAgentList = (s: AppState): Agent[] =>
  Object.values(s.agents).sort((a, b) => a.createdAt - b.createdAt);
export const selectPendingPermissions = (s: AppState): PermissionRequest[] =>
  Object.values(s.permissions).sort((a, b) => a.createdAt - b.createdAt);
