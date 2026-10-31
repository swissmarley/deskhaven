import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrateTurnCosts, recoverInterruptedTurnCosts } from './cost-migration.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/** Hand-written, idempotent migrations. Boring on purpose: no CLI, no snapshot files. */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS agents (
     id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, session_id TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS tasks (
     id TEXT PRIMARY KEY, json TEXT NOT NULL, status TEXT NOT NULL, assignee_agent_id TEXT,
     position REAL NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
   CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_agent_id);`,
  `CREATE TABLE IF NOT EXISTS events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL,
     agent_id TEXT NOT NULL, session_id TEXT, task_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS events_agent_seq_idx ON events(agent_id, seq);
   CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);`,
  `CREATE TABLE IF NOT EXISTS permission_requests (
     id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL,
     created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS perm_status_idx ON permission_requests(status);`,
  `CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS role_presets (id TEXT PRIMARY KEY, json TEXT NOT NULL, builtin INTEGER NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS usage_daily (
     date TEXT NOT NULL, agent_id TEXT NOT NULL, cost_usd REAL NOT NULL, input_tokens INTEGER NOT NULL,
     output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL, cache_creation_tokens INTEGER NOT NULL,
     turns INTEGER NOT NULL, PRIMARY KEY(date, agent_id));`,
  `CREATE TABLE IF NOT EXISTS worktree_trees (
     agent_id TEXT PRIMARY KEY, tree TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
];

export function openDb(dbPath: string): { db: Db; sqlite: Database.Database } {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  for (const m of MIGRATIONS) sqlite.exec(m);
  const presetCols = sqlite.prepare('PRAGMA table_info(role_presets)').all() as { name: string }[];
  if (!presetCols.some((c) => c.name === 'base_hash')) {
    sqlite.exec('ALTER TABLE role_presets ADD COLUMN base_hash TEXT;');
  }
  // Data migration: stored turn costs were the SDK's cumulative total (fixed 2026-10-31).
  migrateTurnCosts(sqlite);
  // Turns stopped by the per-turn cap were stored without the call that was cut off (fixed 2026-10-31).
  recoverInterruptedTurnCosts(sqlite);
  return { db: drizzle(sqlite, { schema }), sqlite };
}
