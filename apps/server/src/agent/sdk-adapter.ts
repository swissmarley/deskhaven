/**
 * The ONLY file that imports types from the Agent SDK. Everything else works with Deskhaven's own
 * types, so an SDK upgrade touches this file and the normaliser.
 *
 * Facts this relies on (verified against sdk.d.ts 0.3.287, see ARCHITECTURE.md §3):
 * - `Options.env` replaces the subprocess environment.
 * - `permissionMode` must be passed explicitly; `'default'` routes prompts through `canUseTool`.
 * - `hooks` take `HookCallbackMatcher[]` per event; callbacks receive `(input, toolUseID, { signal })`.
 */

import {
  type CanUseTool,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
  type McpServerConfig,
  type Options,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '@deskhaven/shared';

export type {
  CanUseTool,
  HookInput,
  McpServerConfig,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
export { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

export interface SessionConfig {
  cwd: string;
  model: string;
  /** Appended to the Claude Code preset system prompt. */
  systemPromptAppend: string;
  /** null = the whole Claude Code tool set. */
  tools: string[] | null;
  allowedTools: string[];
  permissionMode: PermissionMode;
  resume?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  env: Record<string, string | undefined>;
  additionalDirectories?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  strictMcpConfig?: boolean;
  effort?: Options['effort'];
}

export interface SessionCallbacks {
  onMessage: (message: SDKMessage) => void;
  onHook: (input: HookInput, toolUseId: string | undefined) => void;
  canUseTool: CanUseTool;
  onStderr?: (line: string) => void;
  /** Return a reason to block a PreToolUse (workdir boundary), or null to let it proceed. */
  preToolGuard?: (input: HookInput) => string | null;
}

export interface PromptQueue {
  iterable: AsyncIterable<SDKUserMessage>;
  push(text: string): void;
  end(): void;
  readonly ended: boolean;
}

/** Async queue that turns `push()` calls into the SDK's streaming-input iterable. */
export function createPromptQueue(): PromptQueue {
  const items: SDKUserMessage[] = [];
  let waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  let ended = false;
  const done: IteratorResult<SDKUserMessage> = { value: undefined, done: true };
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          const head = items.shift();
          if (head) return Promise.resolve({ value: head, done: false });
          if (ended) return Promise.resolve(done);
          return new Promise((r) => {
            waiting = r;
          });
        },
        return(): Promise<IteratorResult<SDKUserMessage>> {
          ended = true;
          return Promise.resolve(done);
        },
      };
    },
  };
  return {
    iterable,
    get ended() {
      return ended;
    },
    push(text: string) {
      if (ended) return;
      const msg: SDKUserMessage = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      };
      if (waiting) {
        const w = waiting;
        waiting = null;
        w({ value: msg, done: false });
      } else items.push(msg);
    },
    end() {
      ended = true;
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(done);
      }
    },
  };
}

export const HOOK_EVENTS_USED: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PermissionDenied',
  'SessionStart',
  'PreCompact',
];

export interface AgentSession {
  query: Query;
  prompts: PromptQueue;
  abort: AbortController;
}

export function buildOptions(
  cfg: SessionConfig,
  cb: SessionCallbacks,
  abort: AbortController,
): Options {
  const hookCb: HookCallback = async (input, toolUseId) => {
    cb.onHook(input, toolUseId);
    if (input.hook_event_name === 'PreToolUse' && cb.preToolGuard) {
      const reason = cb.preToolGuard(input);
      if (reason) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        };
      }
    }
    return {};
  };
  const matcher: HookCallbackMatcher[] = [{ hooks: [hookCb] }];
  const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const ev of HOOK_EVENTS_USED) hooks[ev] = matcher;

  const options: Options = {
    cwd: cfg.cwd,
    model: cfg.model,
    env: cfg.env,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: cfg.systemPromptAppend },
    allowedTools: cfg.allowedTools,
    permissionMode: cfg.permissionMode,
    canUseTool: cb.canUseTool,
    hooks,
    includePartialMessages: true,
    forwardSubagentText: true,
    settingSources: ['project'],
    abortController: abort,
    persistSession: true,
    ...(cfg.tools ? { tools: cfg.tools } : {}),
    ...(cfg.resume ? { resume: cfg.resume } : {}),
    ...(cfg.maxTurns ? { maxTurns: cfg.maxTurns } : {}),
    ...(cfg.maxBudgetUsd ? { maxBudgetUsd: cfg.maxBudgetUsd } : {}),
    ...(cfg.additionalDirectories?.length
      ? { additionalDirectories: cfg.additionalDirectories }
      : {}),
    ...(cfg.mcpServers ? { mcpServers: cfg.mcpServers } : {}),
    ...(cfg.strictMcpConfig ? { strictMcpConfig: true } : {}),
    ...(cfg.effort ? { effort: cfg.effort } : {}),
    ...(cb.onStderr ? { stderr: cb.onStderr } : {}),
  };
  return options;
}

/** Start one long-lived session in streaming-input mode. Prompts are pushed through `prompts`. */
export function startAgentSession(cfg: SessionConfig, cb: SessionCallbacks): AgentSession {
  const abort = new AbortController();
  const prompts = createPromptQueue();
  const q = query({ prompt: prompts.iterable, options: buildOptions(cfg, cb, abort) });
  return { query: q, prompts, abort };
}
