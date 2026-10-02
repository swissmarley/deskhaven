import { z } from 'zod';
import {
  AgentSchema,
  PermissionRequestSchema,
  RoomSchema,
  SettingsSchema,
  TaskSchema,
  UsageSnapshotSchema,
} from './dto.js';
import { AgentEventSchema } from './events.js';

/** Browser → server over WebSocket. Commands go over REST; the socket is for sync. */
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), sinceSeq: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Server → browser. */
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    serverTime: z.number(),
    version: z.string(),
    agents: z.array(AgentSchema),
    tasks: z.array(TaskSchema),
    rooms: z.array(RoomSchema),
    settings: SettingsSchema,
    pendingPermissions: z.array(PermissionRequestSchema),
    usage: UsageSnapshotSchema,
  }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('event'), event: AgentEventSchema }),
  z.object({ type: z.literal('events_batch'), events: z.array(AgentEventSchema) }),
  z.object({ type: z.literal('agent_upserted'), agent: AgentSchema }),
  z.object({ type: z.literal('agent_removed'), agentId: z.string() }),
  z.object({ type: z.literal('task_upserted'), task: TaskSchema }),
  z.object({ type: z.literal('task_removed'), taskId: z.string() }),
  z.object({ type: z.literal('room_updated'), room: RoomSchema }),
  z.object({ type: z.literal('settings_updated'), settings: SettingsSchema }),
  z.object({ type: z.literal('permission_upserted'), request: PermissionRequestSchema }),
  z.object({ type: z.literal('usage'), usage: UsageSnapshotSchema }),
  z.object({
    type: z.literal('notice'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
    agentId: z.string().optional(),
  }),
  z.object({ type: z.literal('kill_switch'), active: z.boolean() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
