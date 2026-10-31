import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/client.js';
import {
  INTERRUPTED_COST_MIGRATION_KEY,
  migrateTurnCosts,
  recoverInterruptedTurnCosts,
  TURN_COST_MIGRATION_KEY,
} from '../src/db/cost-migration.js';
import { localDate } from '../src/usage/date.js';

const DAY = new Date(2026, 9, 30, 12).getTime();

function legacyDb() {
  const { sqlite } = openDb(':memory:');
  // openDb already ran the migration on the empty database; start again from "before the fix".
  sqlite.prepare('DELETE FROM settings WHERE key = ?').run(TURN_COST_MIGRATION_KEY);
  const turn = (
    id: string,
    agentId: string,
    sessionId: string | null,
    taskId: string | null,
    costUsd: number,
    extra: Record<string, unknown> = {},
  ) =>
    sqlite
      .prepare(
        `INSERT INTO events (id, ts, agent_id, session_id, task_id, type, payload)
         VALUES (?, ?, ?, ?, ?, 'turn_completed', ?)`,
      )
      .run(
        id,
        DAY,
        agentId,
        sessionId,
        taskId,
        JSON.stringify({
          id,
          ts: DAY,
          agentId,
          ...(sessionId ? { sessionId } : {}),
          ...(taskId ? { taskId } : {}),
          type: 'turn_completed',
          ok: true,
          subtype: 'success',
          costUsd,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          numTurns: 1,
          durationMs: 1,
          ...extra,
        }),
      );
  const json = (table: 'agents' | 'tasks', id: string, doc: unknown) =>
    sqlite
      .prepare(
        table === 'agents'
          ? `INSERT INTO agents (id, json, status, session_id, created_at, updated_at) VALUES (?, ?, 'idle', NULL, 1, 1)`
          : `INSERT INTO tasks (id, json, status, assignee_agent_id, position, updated_at) VALUES (?, ?, 'done', NULL, 1, 1)`,
      )
      .run(id, JSON.stringify(doc));
  return { sqlite, turn, json };
}

const read = (sqlite: ReturnType<typeof openDb>['sqlite'], sql: string, ...args: unknown[]) =>
  sqlite.prepare(sql).get(...args) as Record<string, unknown>;

describe('turn cost migration', () => {
  it('rewrites cumulative turn costs to each turn and corrects task, agent and daily totals', () => {
    const { sqlite, turn, json } = legacyDb();
    // Ada, one session: the SDK reported 0.165, 0.185, then 0.512 after a resume (cumulative).
    turn('e1', 'ada', 's1', 'tA', 0.165);
    turn('e2', 'ada', 's1', 'tA', 0.185);
    turn('e3', 'ada', 's1', 'tB', 0.512);
    // A new session restarts the counter; a /clear-style drop counts the whole new total.
    turn('e4', 'ada', 's2', 'tB', 0.05);
    turn('e5', 'ada', 's2', 'tB', 0.02);
    // Bea: one turn, nothing to correct.
    turn('e6', 'bea', 's3', 'tC', 0.1);
    const adaSum = 0.165 + 0.185 + 0.512 + 0.05 + 0.02;
    json('agents', 'ada', { id: 'ada', usage: { costUsd: adaSum, turns: 5 } });
    json('agents', 'bea', { id: 'bea', usage: { costUsd: 0.1, turns: 1 } });
    json('tasks', 'tA', { id: 'tA', costUsd: 0.35 });
    json('tasks', 'tB', { id: 'tB', costUsd: 0.582 });
    json('tasks', 'tC', { id: 'tC', costUsd: 0.1 });
    const date = localDate(new Date(DAY));
    for (const [agentId, cost] of [
      ['ada', adaSum],
      ['bea', 0.1],
    ] as const)
      sqlite
        .prepare(`INSERT INTO usage_daily VALUES (?, ?, ?, 0, 0, 0, 0, 1)`)
        .run(date, agentId, cost);

    const report = migrateTurnCosts(sqlite);
    expect(report?.events).toBe(6);

    const cost = (id: string) =>
      JSON.parse(String(read(sqlite, 'SELECT payload FROM events WHERE id = ?', id).payload));
    expect(cost('e1')).toMatchObject({ costUsd: 0.165, sessionCostUsd: 0.165 });
    expect(cost('e2').costUsd).toBeCloseTo(0.02, 9);
    expect(cost('e3').costUsd).toBeCloseTo(0.327, 9);
    expect(cost('e3').sessionCostUsd).toBe(0.512);
    expect(cost('e4').costUsd).toBe(0.05);
    expect(cost('e5').costUsd).toBe(0.02);
    expect(cost('e6').costUsd).toBe(0.1);

    const doc = (table: string, id: string) =>
      JSON.parse(String(read(sqlite, `SELECT json FROM ${table} WHERE id = ?`, id).json));
    const adaReal = 0.165 + 0.02 + 0.327 + 0.05 + 0.02;
    expect(doc('agents', 'ada').usage.costUsd).toBeCloseTo(adaReal, 9);
    expect(doc('agents', 'bea').usage.costUsd).toBe(0.1);
    expect(doc('tasks', 'tA').costUsd).toBeCloseTo(0.185, 9);
    expect(doc('tasks', 'tB').costUsd).toBeCloseTo(0.397, 9);
    expect(doc('tasks', 'tC').costUsd).toBe(0.1);
    expect(
      Number(
        read(
          sqlite,
          'SELECT cost_usd FROM usage_daily WHERE date = ? AND agent_id = ?',
          date,
          'ada',
        ).cost_usd,
      ),
    ).toBeCloseTo(adaReal, 9);
    expect(report?.deltaUsd).toBeCloseTo(adaReal - adaSum, 9);
  });

  it('runs once, and leaves turns written by the fixed runtime alone', () => {
    const { sqlite, turn, json } = legacyDb();
    turn('n1', 'ada', 's1', 'tA', 0.1, { sessionCostUsd: 0.1 });
    turn('n2', 'ada', 's1', 'tA', 0.05, { sessionCostUsd: 0.15 });
    turn('o1', 'ada', 's1', 'tA', 0.2); // a legacy row after them in the same session
    json('tasks', 'tA', { id: 'tA', costUsd: 0.35 });
    const first = migrateTurnCosts(sqlite);
    expect(first?.events).toBe(1);
    const task = () =>
      JSON.parse(String(read(sqlite, 'SELECT json FROM tasks WHERE id = ?', 'tA').json)).costUsd;
    expect(task()).toBeCloseTo(0.2, 9);
    expect(migrateTurnCosts(sqlite)).toBeNull();
    expect(task()).toBeCloseTo(0.2, 9);
  });

  it('recovers the estimate of turns the per-turn cap stopped and the SDK stored at $0', () => {
    const { sqlite, turn, json } = legacyDb();
    sqlite.prepare('DELETE FROM settings WHERE key = ?').run(INTERRUPTED_COST_MIGRATION_KEY);
    const notice = (id: string, agentId: string, taskId: string, message: string) =>
      sqlite
        .prepare(
          `INSERT INTO events (id, ts, agent_id, session_id, task_id, type, payload)
           VALUES (?, ?, ?, 's1', ?, 'notification', ?)`,
        )
        .run(
          id,
          DAY,
          agentId,
          taskId,
          JSON.stringify({
            id,
            ts: DAY,
            agentId,
            taskId,
            type: 'notification',
            kind: 'budget',
            message,
          }),
        );
    // f4e2b15e: stopped at $0.045, stored at $0.
    notice(
      'n1',
      'eng',
      'f4e2b15e',
      'Tester-Eng reached the per-turn budget ($0.045 of $0.020 estimated). Interrupting the turn.',
    );
    turn('t1', 'eng', 's1', 'f4e2b15e', 0, { ok: false, sessionCostUsd: 0.3 });
    // Stored by the fixed runtime at the estimate already: untouched.
    notice(
      'n2',
      'eng',
      'other',
      'Tester-Eng reached the per-turn budget ($0.031 of $0.020 estimated). Interrupting the turn.',
    );
    turn('t2', 'eng', 's1', 'other', 0.031, { ok: false, sessionCostUsd: 0.3 });
    // A failed turn with no budget notice before it: untouched.
    turn('t3', 'eng', 's1', 'third', 0, { ok: false, sessionCostUsd: 0.3 });
    json('agents', 'eng', { id: 'eng', usage: { costUsd: 0.5 } });
    json('tasks', 'f4e2b15e', { id: 'f4e2b15e', costUsd: 0 });
    json('tasks', 'other', { id: 'other', costUsd: 0.031 });
    const date = localDate(new Date(DAY));
    sqlite.prepare('INSERT INTO usage_daily VALUES (?, ?, ?, 0, 0, 0, 0, 3)').run(date, 'eng', 0.5);

    const report = recoverInterruptedTurnCosts(sqlite);
    expect(report?.events).toBe(1);
    expect(report?.deltaUsd).toBeCloseTo(0.045, 9);
    const payload = (id: string) =>
      JSON.parse(String(read(sqlite, 'SELECT payload FROM events WHERE id = ?', id).payload));
    expect(payload('t1').costUsd).toBeCloseTo(0.045, 9);
    expect(payload('t2').costUsd).toBe(0.031);
    expect(payload('t3').costUsd).toBe(0);
    const doc = (table: string, id: string) =>
      JSON.parse(String(read(sqlite, `SELECT json FROM ${table} WHERE id = ?`, id).json));
    expect(doc('tasks', 'f4e2b15e').costUsd).toBeCloseTo(0.045, 9);
    expect(doc('tasks', 'other').costUsd).toBe(0.031);
    expect(doc('agents', 'eng').usage.costUsd).toBeCloseTo(0.545, 9);
    expect(
      Number(
        read(
          sqlite,
          'SELECT cost_usd FROM usage_daily WHERE date = ? AND agent_id = ?',
          date,
          'eng',
        ).cost_usd,
      ),
    ).toBeCloseTo(0.545, 9);
    // Runs once.
    expect(recoverInterruptedTurnCosts(sqlite)).toBeNull();
    expect(doc('tasks', 'f4e2b15e').costUsd).toBeCloseTo(0.045, 9);
  });
});
