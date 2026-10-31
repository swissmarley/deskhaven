import type { AgentEvent } from '@deskhaven/shared';
import { afterEach, describe, expect, it } from 'vitest';
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
});
