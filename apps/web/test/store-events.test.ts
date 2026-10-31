import { type AgentEvent, emptyUsage, type ServerMessage } from '@deskhaven/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../src/state/store.js';

const note = (seq: number): AgentEvent => ({
  id: `e${seq}`,
  seq,
  ts: seq,
  agentId: 'ada',
  type: 'notification',
  kind: 'test',
  message: `event ${seq}`,
});

describe('store event stream', () => {
  afterEach(() => {
    useAppStore.setState({ feed: [], transcripts: {}, lastSeq: 0, replay: null });
  });

  it('ignores events it already applied when a reconnect sends them again', () => {
    const { applyServerMessage } = useAppStore.getState();
    applyServerMessage({ type: 'events_batch', events: [note(1), note(2)] });
    applyServerMessage({ type: 'event', event: note(3) });
    // The server restarted; the resync overlaps what the feed already shows.
    applyServerMessage({ type: 'events_batch', events: [note(2), note(3), note(4)] });
    const ids = useAppStore.getState().feed.map((e) => e.id);
    expect(ids).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(useAppStore.getState().transcripts.ada?.map((e) => e.id)).toEqual([
      'e1',
      'e2',
      'e3',
      'e4',
    ]);
    expect(useAppStore.getState().lastSeq).toBe(4);
  });

  it('accepts the recent events again after a replay cleared the timeline', () => {
    const { applyServerMessage } = useAppStore.getState();
    applyServerMessage({ type: 'events_batch', events: [note(1), note(2)] });
    useAppStore.getState().stopReplay();
    expect(useAppStore.getState().lastSeq).toBe(0);
    applyServerMessage({ type: 'events_batch', events: [note(1), note(2)] });
    expect(useAppStore.getState().feed.map((e) => e.id)).toEqual(['e1', 'e2']);
  });

  it('starts over when the server log was reset below what the tab has seen', () => {
    const resync = vi.fn();
    useAppStore.setState({ requestResync: resync });
    const { applyServerMessage } = useAppStore.getState();
    applyServerMessage({ type: 'events_batch', events: [note(900), note(901)] });
    const hello = (lastSeq: number) =>
      ({
        type: 'hello',
        serverTime: 0,
        version: 'test',
        agents: [],
        tasks: [],
        rooms: [],
        settings: { soundEnabled: false },
        pendingPermissions: [],
        usage: {
          authModeInUse: 'API_KEY',
          totals: emptyUsage(),
          today: emptyUsage(),
          perAgent: {},
          rateLimits: [],
          killSwitch: false,
          running: 0,
          concurrencyCap: 4,
        },
        lastSeq,
      }) as unknown as ServerMessage;
    // Same database: nothing happens.
    applyServerMessage(hello(901));
    expect(resync).not.toHaveBeenCalled();
    // New database: seq restarted at 3.
    applyServerMessage(hello(3));
    expect(resync).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().lastSeq).toBe(0);
    expect(useAppStore.getState().feed).toEqual([]);
    applyServerMessage({ type: 'events_batch', events: [note(1), note(2), note(3)] });
    expect(useAppStore.getState().feed.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
  });
});
