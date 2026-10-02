import type { AgentEvent } from '@agenthotel/shared';
import { type JSX, useEffect, useState } from 'react';
import { api } from '../net/api.js';
import { useAppStore } from '../state/store.js';
import { describeEvent, fmtTime } from './eventText.js';

const RANGES = [
  { id: '5', label: 'Last 5 min', ms: 5 * 60_000 },
  { id: '15', label: 'Last 15 min', ms: 15 * 60_000 },
  { id: '60', label: 'Last hour', ms: 60 * 60_000 },
  { id: 'all', label: 'Everything', ms: 0 },
];
const SPEEDS = [1, 4, 16, 64];
const MAX_GAP_MS = 2500;

/** Replays the persisted event log through the same store + behaviour mapping as live traffic. */
export function ReplayPanel(): JSX.Element {
  const replay = useAppStore((s) => s.replay);
  const agents = useAppStore((s) => s.agents);
  const pushNotice = useAppStore((s) => s.pushNotice);
  const [range, setRange] = useState('15');
  const [summary, setSummary] = useState<{
    count: number;
    firstTs: number | null;
    lastTs: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    void api
      .eventsSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  }, []);

  // Playback loop: schedule the next event by its real spacing divided by the speed. `replay` is a new
  // object after every step, so the effect re-arms itself until the range is exhausted.
  useEffect(() => {
    if (!replay?.playing) return;
    const cur = replay.events[replay.index];
    const prev = replay.events[replay.index - 1];
    if (!cur) {
      useAppStore.getState().setReplayPlaying(false);
      return;
    }
    const gap = prev ? Math.min(MAX_GAP_MS, Math.max(30, (cur.ts - prev.ts) / replay.speed)) : 30;
    const handle = window.setTimeout(() => {
      useAppStore.getState().replayStep();
    }, gap);
    return () => window.clearTimeout(handle);
  }, [replay]);

  const load = async () => {
    setLoading(true);
    try {
      const r = RANGES.find((x) => x.id === range) ?? RANGES[1];
      const fromTs = r?.ms ? Date.now() - r.ms : undefined;
      const events: AgentEvent[] = await api.events({
        asc: true,
        limit: 5000,
        ...(fromTs ? { fromTs } : {}),
      });
      if (!events.length) {
        pushNotice('info', 'No events in that range');
        return;
      }
      useAppStore.getState().startReplay(events, r?.label ?? 'Replay');
    } catch (err) {
      pushNotice('error', String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  };

  const current = replay?.events[Math.max(0, (replay?.index ?? 1) - 1)];

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Replay</h3>
        {summary ? (
          <span className="muted small">
            {summary.count} events{summary.firstTs ? ` since ${fmtTime(summary.firstTs)}` : ''}
          </span>
        ) : null}
      </div>
      {!replay ? (
        <>
          <p className="muted small">
            Every event is logged to SQLite. Pick a range and watch the office act it out again;
            live events are held back until you stop.
          </p>
          <div className="row">
            <select value={range} onChange={(e) => setRange(e.target.value)}>
              {RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="primary"
              disabled={loading}
              onClick={() => void load()}
            >
              {loading ? 'Loading…' : 'Start replay'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row wrap">
            <button
              type="button"
              onClick={() => useAppStore.getState().setReplayPlaying(!replay.playing)}
            >
              {replay.playing ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              onClick={() => useAppStore.getState().replayStep()}
              disabled={replay.playing}
            >
              Step
            </button>
            {SPEEDS.map((sp) => (
              <button
                type="button"
                key={sp}
                className={replay.speed === sp ? 'primary' : ''}
                onClick={() => useAppStore.getState().setReplaySpeed(sp)}
              >
                {sp}×
              </button>
            ))}
            <button
              type="button"
              className="danger"
              onClick={() => useAppStore.getState().stopReplay()}
            >
              Stop
            </button>
          </div>
          <input
            type="range"
            min={0}
            max={replay.events.length}
            value={replay.index}
            onChange={(e) => useAppStore.getState().replaySeek(Number(e.target.value))}
            style={{ width: '100%' }}
          />
          <p className="muted small">
            {replay.label} · {replay.index} / {replay.events.length}
            {current
              ? ` · ${fmtTime(current.ts)} · ${agents[current.agentId]?.name ?? 'agent'}: ${describeEvent(current).text.slice(0, 80)}`
              : ''}
          </p>
        </>
      )}
    </div>
  );
}
