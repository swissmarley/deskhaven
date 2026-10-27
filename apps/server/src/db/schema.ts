import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Document-style tables: the validated DTO lives in `json`, a few columns are lifted out for filtering.
 * Events are append-only and are the source of truth for replay and the inspector.
 */

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  json: text('json').notNull(),
  status: text('status').notNull(),
  sessionId: text('session_id'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    json: text('json').notNull(),
    status: text('status').notNull(),
    assigneeAgentId: text('assignee_agent_id'),
    position: real('position').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('tasks_status_idx').on(t.status),
    index('tasks_assignee_idx').on(t.assigneeAgentId),
  ],
);

export const events = sqliteTable(
  'events',
  {
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    ts: integer('ts').notNull(),
    agentId: text('agent_id').notNull(),
    sessionId: text('session_id'),
    taskId: text('task_id'),
    type: text('type').notNull(),
    payload: text('payload').notNull(),
  },
  (t) => [index('events_agent_seq_idx').on(t.agentId, t.seq), index('events_ts_idx').on(t.ts)],
);

export const permissionRequests = sqliteTable(
  'permission_requests',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    status: text('status').notNull(),
    json: text('json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('perm_status_idx').on(t.status)],
);

export const rooms = sqliteTable('rooms', {
  id: text('id').primaryKey(),
  json: text('json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const rolePresets = sqliteTable('role_presets', {
  id: text('id').primaryKey(),
  json: text('json').notNull(),
  builtin: integer('builtin').notNull(),
  /** Hash of the shipped built-in this row was seeded, reset, migrated, or saved against. */
  baseHash: text('base_hash'),
});

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    date: text('date').notNull(),
    agentId: text('agent_id').notNull(),
    costUsd: real('cost_usd').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    cacheCreationTokens: integer('cache_creation_tokens').notNull(),
    turns: integer('turns').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.agentId] })],
);
