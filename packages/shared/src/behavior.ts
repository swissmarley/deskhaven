import type { AgentEvent } from './events.js';
import type { ToolCategory } from './tools.js';

/** What an avatar visibly does. The world renderer turns these into movement + animation. */
export type Behavior =
  | { kind: 'idle'; variant: 'wander' | 'sofa' | 'coffee' }
  | { kind: 'thinking' }
  | { kind: 'reading'; label: string }
  | { kind: 'typing'; label: string }
  | { kind: 'terminal'; command: string }
  | { kind: 'browsing'; query: string }
  | { kind: 'delegating'; label: string }
  | { kind: 'working'; label: string }
  | { kind: 'raise_hand'; reason: 'permission' | 'question' | 'plan' | 'input' }
  | {
      kind: 'sweat';
      reason: 'tool_failed' | 'error' | 'auth' | 'rate_limit' | 'billing';
      message: string;
    }
  | { kind: 'cooldown'; resetsAt?: number }
  | { kind: 'celebrate' }
  | { kind: 'nap' }
  | { kind: 'wait' }
  | { kind: 'leave' };

export type BehaviorKind = Behavior['kind'];

export interface BehaviorContext {
  /** Behaviour the avatar currently shows. */
  current: Behavior;
  /** True while at least one tool call of this agent is still running. */
  hasOpenTool: boolean;
  /** Deterministic seed so idle variants are testable (e.g. event seq or a counter). */
  seed: number;
}

export const IDLE: Behavior = { kind: 'idle', variant: 'wander' };
export const THINKING: Behavior = { kind: 'thinking' };

export function idleVariant(seed: number): Behavior {
  const variants = ['wander', 'sofa', 'coffee'] as const;
  const v = variants[Math.abs(Math.trunc(seed)) % variants.length] ?? 'wander';
  return { kind: 'idle', variant: v };
}

export function behaviorForTool(category: ToolCategory, tool: string, summary: string): Behavior {
  switch (category) {
    case 'read':
      return { kind: 'reading', label: summary };
    case 'edit':
      return { kind: 'typing', label: summary };
    case 'bash':
      return { kind: 'terminal', command: summary };
    case 'web':
      return { kind: 'browsing', query: summary };
    case 'subagent':
      return { kind: 'delegating', label: summary };
    case 'ask':
      return { kind: 'raise_hand', reason: 'question' };
    case 'plan':
      return { kind: 'raise_hand', reason: 'plan' };
    case 'todo':
      return { kind: 'working', label: 'planning' };
    case 'mcp':
      return { kind: 'working', label: tool.replace(/^mcp__/, '').replace(/__/g, ' / ') };
    default:
      return { kind: 'working', label: tool };
  }
}

/**
 * The single pure mapping from events to behaviours. No I/O, no randomness beyond `ctx.seed`.
 */
export function mapEventToBehavior(event: AgentEvent, ctx: BehaviorContext): Behavior {
  switch (event.type) {
    case 'session_started':
      return ctx.current.kind === 'leave' ? idleVariant(ctx.seed) : ctx.current;
    case 'status':
      switch (event.status) {
        case 'idle':
          return idleVariant(ctx.seed);
        case 'working':
          return isActive(ctx.current) ? ctx.current : THINKING;
        case 'needs_input':
          return ctx.current.kind === 'raise_hand'
            ? ctx.current
            : { kind: 'raise_hand', reason: 'input' };
        case 'paused':
          return { kind: 'nap' };
        case 'stopped':
          // Off duty: the agent stays visible by the door; `leave` is reserved for removal.
          return { kind: 'wait' };
        case 'waiting':
          return { kind: 'wait' };
        case 'error':
          return ctx.current.kind === 'sweat'
            ? ctx.current
            : { kind: 'sweat', reason: 'error', message: '' };
      }
      return ctx.current;
    case 'text_delta':
    case 'thinking_delta':
    case 'assistant_text':
      if (ctx.hasOpenTool) return ctx.current;
      return THINKING;
    case 'tool_started':
      return behaviorForTool(event.category, event.tool, event.summary);
    case 'tool_finished':
      return ctx.hasOpenTool ? ctx.current : THINKING;
    case 'tool_failed':
      return { kind: 'sweat', reason: 'tool_failed', message: event.error };
    case 'permission_requested':
      return { kind: 'raise_hand', reason: 'permission' };
    case 'permission_resolved':
      if (event.decision === 'allow' || event.decision === 'allow_session') {
        return behaviorForTool(event.category, event.tool, event.tool);
      }
      return THINKING;
    case 'subagent_started':
      return { kind: 'delegating', label: event.description ?? event.subagentType };
    case 'subagent_stopped':
    case 'notification':
      return ctx.current;
    case 'turn_completed':
      if (!event.ok)
        return { kind: 'sweat', reason: 'error', message: event.errors?.[0] ?? event.subtype };
      return event.taskId ? { kind: 'celebrate' } : idleVariant(ctx.seed);
    case 'error':
      switch (event.kind) {
        case 'auth':
          return { kind: 'sweat', reason: 'auth', message: event.message };
        case 'rate_limit':
          return { kind: 'sweat', reason: 'rate_limit', message: event.message };
        case 'billing':
          return { kind: 'sweat', reason: 'billing', message: event.message };
        default:
          return { kind: 'sweat', reason: 'error', message: event.message };
      }
    case 'rate_limit':
      return event.status === 'rejected'
        ? { kind: 'cooldown', resetsAt: event.resetsAt }
        : ctx.current;
    case 'interrupted':
      return idleVariant(ctx.seed);
    case 'compaction':
    case 'task_assigned':
    case 'message_sent':
      return THINKING;
    case 'task_done':
      return event.ok
        ? { kind: 'celebrate' }
        : { kind: 'sweat', reason: 'error', message: 'task failed' };
    case 'unknown':
      return ctx.current;
  }
}

function isActive(b: Behavior): boolean {
  switch (b.kind) {
    case 'thinking':
    case 'reading':
    case 'typing':
    case 'terminal':
    case 'browsing':
    case 'delegating':
    case 'working':
    case 'raise_hand':
      return true;
    default:
      return false;
  }
}

/** Which furniture station a behaviour wants. `own_desk` resolves to the agent's assigned desk. */
export type Station =
  | 'own_desk'
  | 'bookshelf'
  | 'server_rack'
  | 'library_pc'
  | 'coffee_machine'
  | 'sofa'
  | 'whiteboard'
  | 'door'
  | 'stay'
  | 'roam';

export function stationForBehavior(b: Behavior): Station {
  switch (b.kind) {
    case 'idle':
      return b.variant === 'sofa' ? 'sofa' : b.variant === 'coffee' ? 'coffee_machine' : 'roam';
    case 'thinking':
      return 'stay';
    case 'reading':
      return 'bookshelf';
    case 'typing':
    case 'working':
    case 'nap':
      return 'own_desk';
    case 'terminal':
      return 'server_rack';
    case 'browsing':
      return 'library_pc';
    case 'delegating':
      return 'whiteboard';
    case 'raise_hand':
    case 'sweat':
    case 'cooldown':
    case 'celebrate':
      return 'stay';
    case 'wait':
      return 'door';
    case 'leave':
      return 'door';
  }
}
