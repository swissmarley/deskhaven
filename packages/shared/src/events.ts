import { z } from 'zod';

/**
 * ONE typed event schema for everything an agent does. The server normalises SDK messages and hooks
 * into these; the client, the feed, the inspector and replay all consume them.
 */

export const AgentStatusSchema = z.enum([
  'idle',
  'working',
  'needs_input',
  'paused',
  'stopped',
  'waiting',
  'error',
]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const ToolCategorySchema = z.enum([
  'read',
  'edit',
  'bash',
  'web',
  'subagent',
  'ask',
  'plan',
  'todo',
  'mcp',
  'other',
]);

export const PermissionDecisionSchema = z.enum(['allow', 'allow_session', 'deny', 'timeout']);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

export const ErrorKindSchema = z.enum(['auth', 'rate_limit', 'billing', 'overloaded', 'other']);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  patch: z.string(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

const base = {
  id: z.string(),
  seq: z.number().int().nonnegative().optional(),
  ts: z.number(),
  agentId: z.string(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
};

const toolBase = {
  toolUseId: z.string(),
  tool: z.string(),
  category: ToolCategorySchema,
  parentToolUseId: z.string().nullable().optional(),
};

export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('session_started'),
    model: z.string(),
    tools: z.array(z.string()),
    permissionMode: z.string(),
    apiKeySource: z.string(),
    claudeCodeVersion: z.string().optional(),
    cwd: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('status'), status: AgentStatusSchema }),
  z.object({
    ...base,
    type: z.literal('text_delta'),
    text: z.string(),
    parentToolUseId: z.string().nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('thinking_delta'),
    parentToolUseId: z.string().nullable().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('assistant_text'),
    text: z.string(),
    parentToolUseId: z.string().nullable().optional(),
  }),
  z.object({
    ...base,
    ...toolBase,
    type: z.literal('tool_started'),
    input: z.unknown(),
    summary: z.string(),
  }),
  z.object({
    ...base,
    ...toolBase,
    type: z.literal('tool_finished'),
    durationMs: z.number().optional(),
    summary: z.string(),
    output: z.string().optional(),
    diffs: z.array(FileDiffSchema).optional(),
  }),
  z.object({
    ...base,
    ...toolBase,
    type: z.literal('tool_failed'),
    error: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('permission_requested'),
    requestId: z.string(),
    toolUseId: z.string(),
    tool: z.string(),
    category: ToolCategorySchema,
    input: z.unknown(),
    title: z.string().optional(),
    description: z.string().optional(),
    hasSuggestions: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal('permission_resolved'),
    requestId: z.string(),
    tool: z.string(),
    category: ToolCategorySchema,
    decision: PermissionDecisionSchema,
    message: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('subagent_started'),
    subagentId: z.string(),
    subagentType: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('subagent_stopped'),
    subagentId: z.string(),
    subagentType: z.string(),
    summary: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('notification'), message: z.string(), kind: z.string() }),
  z.object({
    ...base,
    type: z.literal('turn_completed'),
    ok: z.boolean(),
    subtype: z.string(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheReadTokens: z.number(),
    cacheCreationTokens: z.number(),
    numTurns: z.number(),
    durationMs: z.number(),
    result: z.string().optional(),
    errors: z.array(z.string()).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('error'),
    kind: ErrorKindSchema,
    status: z.number().optional(),
    message: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('rate_limit'),
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    windowType: z.string().optional(),
    utilization: z.number().optional(),
    resetsAt: z.number().optional(),
  }),
  z.object({ ...base, type: z.literal('interrupted') }),
  z.object({ ...base, type: z.literal('compaction'), trigger: z.string() }),
  z.object({ ...base, type: z.literal('task_assigned'), title: z.string() }),
  z.object({ ...base, type: z.literal('task_done'), ok: z.boolean() }),
  z.object({ ...base, type: z.literal('message_sent'), text: z.string() }),
  z.object({ ...base, type: z.literal('unknown'), raw: z.string() }),
]);

export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentEventType = AgentEvent['type'];
export type AgentEventOf<T extends AgentEventType> = Extract<AgentEvent, { type: T }>;
