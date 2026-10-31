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
} from '@deskhaven/shared';
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

export interface ReplayState {
  events: AgentEvent[];
  index: number;
  speed: number;
  playing: boolean;
  label: string;
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
  sideTab: 'agents' | 'inspector' | 'feed' | 'settings' | 'board' | 'room' | 'replay';
  boardOpen: boolean;
  notices: Notice[];
  soundEnabled: boolean;
  /** Non-null while the viewer replays logged events; live events are ignored meanwhile. */
  replay: ReplayState | null;
  /** Installed by the WebSocket owner; asks the server for a fresh snapshot. */
  requestResync: () => void;

  setConnection: (c: ConnectionState) => void;
  applyServerMessage: (m: ServerMessage) => void;
  selectAgent: (id: string | null) => void;
  setSideTab: (tab: AppState['sideTab']) => void;
  setBoardOpen: (open: boolean) => void;
  pushNotice: (level: Notice['level'], message: string, agentId?: string) => void;
  dismissNotice: (id: number) => void;
  setSoundEnabled: (on: boolean) => void;
  startReplay: (events: AgentEvent[], label: string, speed?: number) => void;
  setReplayPlaying: (playing: boolean) => void;
  setReplaySpeed: (speed: number) => void;
  /** Apply the next replay event (returns false at the end). */
  replayStep: () => boolean;
  /** Jump to an index, rebuilding state from the start of the range. */
  replaySeek: (index: number) => void;
  stopReplay: () => void;
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
  replay: null,
  requestResync: () => {},

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
  startReplay: (events, label, speed = 4) => {
    set({ ...clearedTimeline(get()), replay: { events, index: 0, speed, playing: true, label } });
  },
  setReplayPlaying: (playing) => set((s) => (s.replay ? { replay: { ...s.replay, playing } } : {})),
  setReplaySpeed: (speed) => set((s) => (s.replay ? { replay: { ...s.replay, speed } } : {})),
  replayStep: () => {
    const r = get().replay;
    if (!r) return false;
    const ev = r.events[r.index];
    if (!ev) {
      set({ replay: { ...r, playing: false } });
      return false;
    }
    applyEvent(ev, set, get, true, true);
    set((s) => (s.replay ? { replay: { ...s.replay, index: r.index + 1 } } : {}));
    return true;
  },
  replaySeek: (index) => {
    const r = get().replay;
    if (!r) return;
    const target = Math.max(0, Math.min(index, r.events.length));
    set({ ...clearedTimeline(get()), replay: { ...r, index: 0 } });
    for (let i = 0; i < target; i++) {
      const ev = r.events[i];
      if (ev) applyEvent(ev, set, get, false, true);
    }
    set((s) => (s.replay ? { replay: { ...s.replay, index: target } } : {}));
  },
  stopReplay: () => {
    set({ ...clearedTimeline(get()), replay: null });
    get().requestResync();
  },

  applyServerMessage: (m) => {
    switch (m.type) {
      case 'hello': {
        // The server's log restarted below what this tab has seen (the database was reset): every new
        // event would look already applied. Start the timeline over and ask for the recent events.
        if (m.lastSeq !== undefined && m.lastSeq < get().lastSeq) {
          set({ ...clearedTimeline(get()), lastSeq: 0 });
          get().requestResync();
        }
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
        if (!get().replay) applyEvent(m.event, set, get, true);
        break;
      case 'events_batch':
        if (!get().replay) for (const e of m.events) applyEvent(e, set, get, false);
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
    case 'waiting':
      return { kind: 'wait' };
    default:
      return IDLE;
  }
}

/** Feed, transcripts, live text and behaviours reset to a blank timeline (agents become idle). */
function clearedTimeline(s: AppState): Partial<AppState> {
  const behaviors: Record<string, Behavior> = {};
  for (const id of Object.keys(s.agents)) behaviors[id] = IDLE;
  // lastSeq goes back to 0 so the resync after a replay sends the recent events again.
  return {
    feed: [],
    transcripts: {},
    liveText: {},
    openTools: {},
    behaviors,
    seeds: {},
    lastSeq: 0,
  };
}

type Set = (fn: Partial<AppState> | ((s: AppState) => Partial<AppState>)) => void;
type Get = () => AppState;

function applyEvent(event: AgentEvent, set: Set, get: Get, live: boolean, replaying = false): void {
  const s = get();
  // A reconnect (for example after the server restarted) can deliver events already applied: the
  // server replays from the seq the client sent, and an old server or a race can overlap. Applying
  // one twice duplicated feed rows and made React warn about duplicate keys on every render.
  if (!replaying && event.seq !== undefined && event.seq <= s.lastSeq) return;
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
  if (event.type === 'error' && live && !replaying) {
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
  if (event.type === 'rate_limit' && event.status !== 'allowed' && live && !replaying) {
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

// The store is a singleton shared by React and the Pixi bridge: a hot update would create a second copy,
// so force a full reload instead (dev only; Vite strips this in production builds).
if (import.meta.hot) import.meta.hot.accept(() => import.meta.hot?.invalidate());
