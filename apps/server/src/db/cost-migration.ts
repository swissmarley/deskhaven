import type Database from 'better-sqlite3';
import { turnCostFromCumulative } from '../agent/turn-cost.js';
import { localDate } from '../usage/date.js';

/** Settings row that records the migration ran, so later boots skip the scan. */
export const TURN_COST_MIGRATION_KEY = 'migration.turn_cost_per_turn';

export interface TurnCostMigrationReport {
  /** turn_completed events rewritten from the cumulative total to the turn's share. */
  events: number;
  /** Sum of the corrections applied (negative: the totals were too high). */
  deltaUsd: number;
}

interface TurnRow {
  seq: number;
  id: string;
  ts: number;
  agent_id: string;
  session_id: string | null;
  task_id: string | null;
  payload: string;
}

/**
 * Before 2026-10-31 every `turn_completed.costUsd` held the SDK's `total_cost_usd`, which is
 * cumulative for the process (a resumed process continues from the saved total), and every total
 * summed it as if it were per turn. This rewrites each stored turn to its share, the same way the
 * runtime now does (difference from the previous turn of the same session; a drop means the counter
 * restarted), keeps the raw value in `sessionCostUsd`, and applies the correction to the task, the
 * agent's all-time usage and the daily row of that turn. Corrections, not recomputation: a task or
 * agent whose events were pruned keeps the part of its total this log cannot account for.
 *
 * Idempotent: turns that already carry `sessionCostUsd` are taken as correct, and a settings row
 * marks the run. Returns null when it had already run.
 */
export function migrateTurnCosts(sqlite: Database.Database): TurnCostMigrationReport | null {
  const done = sqlite
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(TURN_COST_MIGRATION_KEY) as { value: string } | undefined;
  if (done) return null;

  const rows = sqlite
    .prepare(
      `SELECT seq, id, ts, agent_id, session_id, task_id, payload FROM events
       WHERE type = 'turn_completed' ORDER BY seq ASC`,
    )
    .all() as TurnRow[];

  const lastTotal = new Map<string, number>();
  const byTask = new Map<string, number>();
  const byAgent = new Map<string, number>();
  const byDay = new Map<string, { date: string; agentId: string; delta: number }>();
  const updates: { seq: number; payload: string }[] = [];
  let deltaUsd = 0;

  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = `${row.agent_id}\u0000${row.session_id ?? ''}`;
    const prior = typeof payload.sessionCostUsd === 'number' ? payload.sessionCostUsd : null;
    if (prior !== null) {
      lastTotal.set(key, prior);
      continue;
    }
    const raw = typeof payload.costUsd === 'number' ? payload.costUsd : 0;
    const share = turnCostFromCumulative(raw, lastTotal.get(key) ?? 0);
    if (raw > 0) lastTotal.set(key, raw);
    const delta = share - raw;
    updates.push({
      seq: row.seq,
      payload: JSON.stringify({ ...payload, costUsd: share, sessionCostUsd: raw }),
    });
    if (delta === 0) continue;
    deltaUsd += delta;
    if (row.task_id) byTask.set(row.task_id, (byTask.get(row.task_id) ?? 0) + delta);
    byAgent.set(row.agent_id, (byAgent.get(row.agent_id) ?? 0) + delta);
    const date = localDate(new Date(row.ts));
    const dayKey = `${date}\u0000${row.agent_id}`;
    const day = byDay.get(dayKey) ?? { date, agentId: row.agent_id, delta: 0 };
    day.delta += delta;
    byDay.set(dayKey, day);
  }

  const apply = sqlite.transaction(() => {
    const setPayload = sqlite.prepare('UPDATE events SET payload = ? WHERE seq = ?');
    for (const u of updates) setPayload.run(u.payload, u.seq);

    const getJson = (table: 'tasks' | 'agents', id: string) =>
      sqlite.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id) as
        | { json: string }
        | undefined;
    const setJson = (table: 'tasks' | 'agents') =>
      sqlite.prepare(`UPDATE ${table} SET json = ? WHERE id = ?`);
    const setTask = setJson('tasks');
    for (const [id, delta] of byTask) {
      const row = getJson('tasks', id);
      if (!row) continue;
      const task = JSON.parse(row.json) as { costUsd?: number };
      task.costUsd = Math.max(0, (task.costUsd ?? 0) + delta);
      setTask.run(JSON.stringify(task), id);
    }
    const setAgent = setJson('agents');
    for (const [id, delta] of byAgent) {
      const row = getJson('agents', id);
      if (!row) continue;
      const agent = JSON.parse(row.json) as { usage?: { costUsd?: number } };
      if (!agent.usage) continue;
      agent.usage.costUsd = Math.max(0, (agent.usage.costUsd ?? 0) + delta);
      setAgent.run(JSON.stringify(agent), id);
    }
    const setDay = sqlite.prepare(
      'UPDATE usage_daily SET cost_usd = MAX(0, cost_usd + ?) WHERE date = ? AND agent_id = ?',
    );
    for (const d of byDay.values()) setDay.run(d.delta, d.date, d.agentId);

    sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run(
        TURN_COST_MIGRATION_KEY,
        JSON.stringify({ at: new Date().toISOString(), events: updates.length, deltaUsd }),
      );
  });
  apply();
  return { events: updates.length, deltaUsd };
}
