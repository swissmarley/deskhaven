import {
  type AgentEvent,
  classifyTool,
  type ErrorKind,
  summarizeToolInput,
  truncate,
} from '@agenthotel/shared';
import type { HookInput, SDKMessage } from './sdk-adapter.js';

export interface NormalizeContext {
  agentId: string;
  taskId?: string;
  sessionId?: string;
  now: () => number;
  newId: () => string;
}

const base = (ctx: NormalizeContext, sessionId?: string) => ({
  id: ctx.newId(),
  ts: ctx.now(),
  agentId: ctx.agentId,
  ...(ctx.taskId ? { taskId: ctx.taskId } : {}),
  ...((sessionId ?? ctx.sessionId) ? { sessionId: sessionId ?? ctx.sessionId } : {}),
});

export function errorKindFromSdk(error: string | undefined): { kind: ErrorKind; status?: number } {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
      return { kind: 'auth', status: 401 };
    case 'billing_error':
      return { kind: 'billing', status: 402 };
    case 'rate_limit':
      return { kind: 'rate_limit', status: 429 };
    case 'overloaded':
      return { kind: 'overloaded', status: 529 };
    default:
      return { kind: 'other' };
  }
}

export function errorKindFromStatus(status: number | null | undefined): ErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  return 'other';
}

function stringifyOutput(value: unknown, max = 2000): string {
  if (typeof value === 'string') return truncate(value, max);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return '[unserialisable]';
  }
}

/** SDK message → zero or more AgentEvents. Pure. Unknown shapes become `unknown` events, never throws. */
export function normalizeSdkMessage(m: SDKMessage, ctx: NormalizeContext): AgentEvent[] {
  const sid = 'session_id' in m && typeof m.session_id === 'string' ? m.session_id : undefined;
  const b = () => base(ctx, sid);
  switch (m.type) {
    case 'system': {
      switch (m.subtype) {
        case 'init':
          return [
            {
              ...b(),
              type: 'session_started',
              model: m.model,
              tools: m.tools,
              permissionMode: m.permissionMode,
              apiKeySource: m.apiKeySource,
              claudeCodeVersion: m.claude_code_version,
              cwd: m.cwd,
            },
          ];
        case 'api_retry': {
          const { kind } = errorKindFromSdk(m.error);
          return [
            {
              ...b(),
              type: 'notification',
              kind: 'api_retry',
              message: `API ${m.error_status ?? kind} — retry ${m.attempt}/${m.max_retries} in ${Math.round(m.retry_delay_ms / 1000)}s`,
            },
          ];
        }
        case 'compact_boundary':
          return [{ ...b(), type: 'compaction', trigger: m.compact_metadata.trigger }];
        case 'permission_denied':
          return [
            {
              ...b(),
              type: 'notification',
              kind: 'permission_denied',
              message: `${m.tool_name}: ${m.message}`,
            },
          ];
        case 'task_started':
          return [{ ...b(), type: 'notification', kind: 'task_started', message: m.description }];
        case 'task_notification':
          return [
            {
              ...b(),
              type: 'notification',
              kind: `task_${m.status}`,
              message: truncate(m.summary, 200),
            },
          ];
        case 'notification':
          return [{ ...b(), type: 'notification', kind: 'notice', message: m.text }];
        default:
          return [];
      }
    }
    case 'assistant': {
      const out: AgentEvent[] = [];
      const parent = m.parent_tool_use_id;
      if (m.error) {
        const { kind, status } = errorKindFromSdk(m.error);
        out.push({ ...b(), type: 'error', kind, status, message: m.error });
      }
      for (const block of m.message.content) {
        if (block.type === 'text' && block.text.trim()) {
          out.push({ ...b(), type: 'assistant_text', text: block.text, parentToolUseId: parent });
        } else if (block.type === 'tool_use') {
          const category = classifyTool(block.name);
          out.push({
            ...b(),
            type: 'tool_started',
            toolUseId: block.id,
            tool: block.name,
            category,
            input: block.input,
            summary: truncate(summarizeToolInput(block.name, block.input), 120),
            parentToolUseId: parent,
          });
        }
      }
      return out;
    }
    case 'stream_event': {
      const ev = m.event;
      if (ev.type === 'content_block_delta') {
        if (ev.delta.type === 'text_delta') {
          return [
            {
              ...b(),
              type: 'text_delta',
              text: ev.delta.text,
              parentToolUseId: m.parent_tool_use_id,
            },
          ];
        }
        if (ev.delta.type === 'thinking_delta') {
          return [{ ...b(), type: 'thinking_delta', parentToolUseId: m.parent_tool_use_id }];
        }
      }
      return [];
    }
    case 'user': {
      // Tool results arrive here; hooks are the primary source for tool_finished, this is the fallback.
      const content = m.message.content;
      if (typeof content === 'string') return [];
      const out: AgentEvent[] = [];
      for (const block of content) {
        if (block.type === 'tool_result') {
          const text =
            typeof block.content === 'string' ? block.content : stringifyOutput(block.content);
          out.push(
            block.is_error
              ? {
                  ...b(),
                  type: 'tool_failed',
                  toolUseId: block.tool_use_id,
                  tool: '?',
                  category: 'other',
                  error: truncate(text, 500),
                  parentToolUseId: m.parent_tool_use_id,
                }
              : {
                  ...b(),
                  type: 'tool_finished',
                  toolUseId: block.tool_use_id,
                  tool: '?',
                  category: 'other',
                  summary: '',
                  output: truncate(text, 2000),
                  parentToolUseId: m.parent_tool_use_id,
                },
          );
        }
      }
      return out;
    }
    case 'result': {
      const out: AgentEvent[] = [];
      const usage = m.usage;
      const common = {
        subtype: m.subtype,
        costUsd: m.total_cost_usd,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
        numTurns: m.num_turns,
        durationMs: m.duration_ms,
      };
      if (m.subtype === 'success') {
        if (m.is_error && m.api_error_status) {
          out.push({
            ...b(),
            type: 'error',
            kind: errorKindFromStatus(m.api_error_status),
            status: m.api_error_status,
            message: truncate(m.result, 300),
          });
        }
        out.push({ ...b(), type: 'turn_completed', ok: !m.is_error, result: m.result, ...common });
      } else {
        out.push({ ...b(), type: 'turn_completed', ok: false, errors: m.errors, ...common });
      }
      return out;
    }
    case 'rate_limit_event': {
      const info = m.rate_limit_info;
      return [
        {
          ...b(),
          type: 'rate_limit',
          status: info.status,
          windowType: info.rateLimitType,
          utilization: info.utilization,
          resetsAt: info.resetsAt,
        },
      ];
    }
    case 'auth_status':
      return m.error ? [{ ...b(), type: 'error', kind: 'auth', message: m.error }] : [];
    case 'tool_progress':
    case 'tool_use_summary':
      return [];
    default:
      return [
        {
          ...b(),
          type: 'unknown',
          raw: `${(m as { type: string }).type}${'subtype' in m ? `/${String((m as { subtype?: string }).subtype)}` : ''}`,
        },
      ];
  }
}

/** Hook input → AgentEvents. Pure. */
export function normalizeHook(
  input: HookInput,
  _toolUseId: string | undefined,
  ctx: NormalizeContext,
): AgentEvent[] {
  const b = () => base(ctx, input.session_id);
  const parent = input.agent_id ? `agent:${input.agent_id}` : null;
  switch (input.hook_event_name) {
    case 'PreToolUse': {
      const category = classifyTool(input.tool_name);
      return [
        {
          ...b(),
          type: 'tool_started',
          toolUseId: input.tool_use_id,
          tool: input.tool_name,
          category,
          input: input.tool_input,
          summary: truncate(summarizeToolInput(input.tool_name, input.tool_input), 120),
          parentToolUseId: parent,
        },
      ];
    }
    case 'PostToolUse':
      return [
        {
          ...b(),
          type: 'tool_finished',
          toolUseId: input.tool_use_id,
          tool: input.tool_name,
          category: classifyTool(input.tool_name),
          durationMs: input.duration_ms,
          summary: truncate(summarizeToolInput(input.tool_name, input.tool_input), 120),
          output: stringifyOutput(input.tool_response),
          parentToolUseId: parent,
        },
      ];
    case 'PostToolUseFailure':
      return [
        {
          ...b(),
          type: 'tool_failed',
          toolUseId: input.tool_use_id,
          tool: input.tool_name,
          category: classifyTool(input.tool_name),
          error: truncate(input.error, 500),
          parentToolUseId: parent,
        },
      ];
    case 'Notification':
      return [
        { ...b(), type: 'notification', kind: input.notification_type, message: input.message },
      ];
    case 'SubagentStart':
      return [
        {
          ...b(),
          type: 'subagent_started',
          subagentId: input.agent_id,
          subagentType: input.agent_type,
        },
      ];
    case 'SubagentStop':
      return [
        {
          ...b(),
          type: 'subagent_stopped',
          subagentId: input.agent_id,
          subagentType: input.agent_type,
          summary: input.last_assistant_message
            ? truncate(input.last_assistant_message, 200)
            : undefined,
        },
      ];
    case 'PermissionDenied':
      return [
        {
          ...b(),
          type: 'notification',
          kind: 'permission_denied',
          message: `${input.tool_name}: ${input.reason}`,
        },
      ];
    case 'SessionStart':
      return [
        { ...b(), type: 'notification', kind: 'session_start', message: `session ${input.source}` },
      ];
    case 'PreCompact':
      return [{ ...b(), type: 'compaction', trigger: input.trigger }];
    default:
      return [];
  }
}
