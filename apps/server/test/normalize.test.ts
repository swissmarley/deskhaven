import { AgentEventSchema } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import {
  errorKindFromSdk,
  type NormalizeContext,
  normalizeHook,
  normalizeSdkMessage,
} from '../src/agent/normalize.js';
import type { HookInput, SDKMessage } from '../src/agent/sdk-adapter.js';

let n = 0;
const ctx: NormalizeContext = {
  agentId: 'a1',
  taskId: 'task1',
  now: () => 1000,
  newId: () => `id${++n}`,
};
const msg = (m: Record<string, unknown>): SDKMessage =>
  ({ uuid: 'u', session_id: 's1', ...m }) as unknown as SDKMessage;
const hook = (h: Record<string, unknown>): HookInput =>
  ({ session_id: 's1', transcript_path: '/t', cwd: '/w', ...h }) as unknown as HookInput;

function norm(m: SDKMessage) {
  const out = normalizeSdkMessage(m, ctx);
  for (const e of out) AgentEventSchema.parse(e);
  return out;
}
function normH(h: HookInput) {
  const out = normalizeHook(h, undefined, ctx);
  for (const e of out) AgentEventSchema.parse(e);
  return out;
}

describe('normalizeSdkMessage', () => {
  it('maps system/init to session_started with the apiKeySource', () => {
    const [e] = norm(
      msg({
        type: 'system',
        subtype: 'init',
        model: 'claude-sonnet-5-5',
        tools: ['Read', 'Bash'],
        permissionMode: 'default',
        apiKeySource: 'none',
        claude_code_version: '2.1.287',
        cwd: '/w',
        mcp_servers: [],
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
      }),
    );
    expect(e).toMatchObject({
      type: 'session_started',
      agentId: 'a1',
      taskId: 'task1',
      sessionId: 's1',
      model: 'claude-sonnet-5-5',
      apiKeySource: 'none',
      tools: ['Read', 'Bash'],
    });
  });

  it('splits assistant content into text and tool_started events', () => {
    const out = norm(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking…' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'README.md' } },
            { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'pnpm test' } },
          ],
        },
      }),
    );
    expect(out.map((e) => e.type)).toEqual(['assistant_text', 'tool_started', 'tool_started']);
    expect(out[1]).toMatchObject({
      toolUseId: 't1',
      tool: 'Read',
      category: 'read',
      summary: 'README.md',
    });
    expect(out[2]).toMatchObject({
      toolUseId: 't2',
      tool: 'Bash',
      category: 'bash',
      summary: 'pnpm test',
    });
  });

  it('turns assistant errors into typed error events', () => {
    const out = norm(
      msg({
        type: 'assistant',
        parent_tool_use_id: null,
        error: 'rate_limit',
        message: { role: 'assistant', content: [] },
      }),
    );
    expect(out[0]).toMatchObject({ type: 'error', kind: 'rate_limit', status: 429 });
    expect(errorKindFromSdk('authentication_failed')).toEqual({ kind: 'auth', status: 401 });
    expect(errorKindFromSdk('billing_error')).toEqual({ kind: 'billing', status: 402 });
    expect(errorKindFromSdk('oauth_org_not_allowed').kind).toBe('auth');
    expect(errorKindFromSdk('weird').kind).toBe('other');
  });

  it('maps stream deltas', () => {
    expect(
      norm(
        msg({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'hel' },
          },
        }),
      )[0],
    ).toMatchObject({ type: 'text_delta', text: 'hel' });
    expect(
      norm(
        msg({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: '…' },
          },
        }),
      )[0],
    ).toMatchObject({ type: 'thinking_delta' });
    expect(
      norm(
        msg({
          type: 'stream_event',
          parent_tool_use_id: null,
          event: { type: 'message_start', message: {} },
        }),
      ),
    ).toEqual([]);
  });

  it('maps result success and error subtypes to turn_completed', () => {
    const usage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 1,
    };
    const [ok] = norm(
      msg({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1200,
        duration_api_ms: 1000,
        num_turns: 2,
        result: 'done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0123,
        usage,
        modelUsage: {},
        permission_denials: [],
      }),
    );
    expect(ok).toMatchObject({
      type: 'turn_completed',
      ok: true,
      subtype: 'success',
      costUsd: 0.0123,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
      numTurns: 2,
      durationMs: 1200,
      result: 'done',
      taskId: 'task1',
    });
    const [bad] = norm(
      msg({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 9,
        stop_reason: null,
        total_cost_usd: 0.5,
        usage,
        modelUsage: {},
        permission_denials: [],
        errors: ['max turns'],
      }),
    );
    expect(bad).toMatchObject({
      type: 'turn_completed',
      ok: false,
      subtype: 'error_max_turns',
      errors: ['max turns'],
    });
    const out = norm(
      msg({
        type: 'result',
        subtype: 'success',
        is_error: true,
        api_error_status: 401,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 0,
        result: 'unauthorized',
        stop_reason: null,
        total_cost_usd: 0,
        usage,
        modelUsage: {},
        permission_denials: [],
      }),
    );
    expect(out.map((e) => e.type)).toEqual(['error', 'turn_completed']);
    expect(out[0]).toMatchObject({ kind: 'auth', status: 401 });
  });

  it('maps rate limit events, retries, compaction and tool results', () => {
    expect(
      norm(
        msg({
          type: 'rate_limit_event',
          rate_limit_info: {
            status: 'rejected',
            rateLimitType: 'five_hour',
            utilization: 1,
            resetsAt: 123,
          },
        }),
      )[0],
    ).toMatchObject({
      type: 'rate_limit',
      status: 'rejected',
      windowType: 'five_hour',
      utilization: 1,
      resetsAt: 123,
    });
    expect(
      norm(
        msg({
          type: 'system',
          subtype: 'api_retry',
          attempt: 2,
          max_retries: 10,
          retry_delay_ms: 4000,
          error_status: 429,
          error: 'rate_limit',
        }),
      )[0],
    ).toMatchObject({
      type: 'notification',
      kind: 'api_retry',
      message: expect.stringContaining('429'),
    });
    expect(
      norm(
        msg({
          type: 'system',
          subtype: 'compact_boundary',
          compact_metadata: { trigger: 'auto', pre_tokens: 1 },
        }),
      )[0],
    ).toMatchObject({ type: 'compaction', trigger: 'auto' });
    const results = norm(
      msg({
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false },
            { type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true },
          ],
        },
      }),
    );
    expect(results[0]).toMatchObject({ type: 'tool_finished', toolUseId: 't1', output: 'ok' });
    expect(results[1]).toMatchObject({ type: 'tool_failed', toolUseId: 't2', error: 'boom' });
  });

  it('replaces SDK diagnostic strings with readable reasons', () => {
    const usage = { input_tokens: 1, output_tokens: 1 };
    const [bad] = norm(
      msg({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 0,
        stop_reason: null,
        total_cost_usd: 0,
        usage,
        modelUsage: {},
        permission_denials: [],
        errors: ['[ede_diagnostic] result_type=user stop_reason=null'],
        terminal_reason: 'aborted_streaming',
      }),
    );
    expect(bad).toMatchObject({ type: 'turn_completed', ok: false, errors: ['Turn interrupted'] });
    const [maxed] = norm(
      msg({
        type: 'result',
        subtype: 'error_max_budget_usd',
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.1,
        usage,
        modelUsage: {},
        permission_denials: [],
        errors: ['Reached maximum budget ($0.001)'],
      }),
    );
    expect(maxed).toMatchObject({ errors: ['Reached maximum budget ($0.001)'] });
    const [weird] = norm(
      msg({
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: '[ede_diagnostic] result_type=user',
        stop_reason: null,
        total_cost_usd: 0,
        usage,
        modelUsage: {},
        permission_denials: [],
      }),
    );
    expect(weird).toMatchObject({ type: 'turn_completed', ok: true });
    expect((weird as { result?: string }).result).toBeUndefined();
  });

  it('never throws on unknown message types', () => {
    expect(norm(msg({ type: 'something_new', subtype: 'x' }))[0]).toMatchObject({
      type: 'unknown',
      raw: 'something_new/x',
    });
    expect(
      norm(
        msg({
          type: 'tool_progress',
          tool_use_id: 't',
          tool_name: 'Bash',
          parent_tool_use_id: null,
          elapsed_time_seconds: 3,
        }),
      ),
    ).toEqual([]);
  });
});

describe('normalizeHook', () => {
  it('maps the tool lifecycle hooks', () => {
    expect(
      normH(
        hook({
          hook_event_name: 'PreToolUse',
          tool_name: 'Edit',
          tool_input: { file_path: 'a.ts' },
          tool_use_id: 't1',
        }),
      )[0],
    ).toMatchObject({
      type: 'tool_started',
      toolUseId: 't1',
      tool: 'Edit',
      category: 'edit',
      summary: 'a.ts',
      parentToolUseId: null,
    });
    expect(
      normH(
        hook({
          hook_event_name: 'PostToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          tool_response: { stdout: 'a\nb' },
          tool_use_id: 't2',
          duration_ms: 40,
          agent_id: 'sub1',
        }),
      )[0],
    ).toMatchObject({
      type: 'tool_finished',
      toolUseId: 't2',
      durationMs: 40,
      output: expect.stringContaining('stdout'),
      parentToolUseId: 'agent:sub1',
    });
    expect(
      normH(
        hook({
          hook_event_name: 'PostToolUseFailure',
          tool_name: 'Bash',
          tool_input: {},
          tool_use_id: 't3',
          error: 'exit 1',
        }),
      )[0],
    ).toMatchObject({ type: 'tool_failed', error: 'exit 1' });
  });

  it('maps subagents, notifications, denials and compaction', () => {
    expect(
      normH(hook({ hook_event_name: 'SubagentStart', agent_id: 's1', agent_type: 'Explore' }))[0],
    ).toMatchObject({ type: 'subagent_started', subagentId: 's1', subagentType: 'Explore' });
    expect(
      normH(
        hook({
          hook_event_name: 'SubagentStop',
          agent_id: 's1',
          agent_type: 'Explore',
          stop_hook_active: false,
          agent_transcript_path: '/p',
          last_assistant_message: 'found it',
        }),
      )[0],
    ).toMatchObject({ type: 'subagent_stopped', summary: 'found it' });
    expect(
      normH(
        hook({
          hook_event_name: 'Notification',
          message: 'needs you',
          notification_type: 'idle_prompt',
        }),
      )[0],
    ).toMatchObject({ type: 'notification', kind: 'idle_prompt' });
    expect(
      normH(
        hook({
          hook_event_name: 'PermissionDenied',
          tool_name: 'Bash',
          tool_input: {},
          tool_use_id: 't',
          reason: 'rule',
        }),
      )[0],
    ).toMatchObject({ type: 'notification', kind: 'permission_denied' });
    expect(
      normH(
        hook({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null }),
      )[0],
    ).toMatchObject({ type: 'compaction', trigger: 'manual' });
    expect(normH(hook({ hook_event_name: 'Stop', stop_hook_active: false }))).toEqual([]);
  });
});
