import type { AgentEvent } from '@deskhaven/shared';

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function fmtUsd(v: number): string {
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** One-line, chat-log style description of an event. */
export function describeEvent(e: AgentEvent): {
  icon: string;
  text: string;
  tone: 'muted' | 'normal' | 'warn' | 'error' | 'ok';
} {
  switch (e.type) {
    case 'session_started':
      return {
        icon: '⚡',
        text: `session started (${e.model}, auth ${e.apiKeySource === 'none' ? 'subscription' : e.apiKeySource})`,
        tone: 'muted',
      };
    case 'status':
      return { icon: '·', text: `is ${e.status.replace('_', ' ')}`, tone: 'muted' };
    case 'assistant_text':
      return { icon: '💬', text: e.text, tone: 'normal' };
    case 'tool_started':
      return { icon: toolIcon(e.category), text: `${e.tool} ${e.summary}`.trim(), tone: 'normal' };
    case 'tool_finished':
      return {
        icon: '✓',
        text: `${e.tool} done${e.durationMs ? ` in ${Math.round(e.durationMs)}ms` : ''}${e.diffs?.length ? ` · ${e.diffs.length} diff` : ''}`,
        tone: 'muted',
      };
    case 'tool_failed':
      return { icon: '✗', text: `${e.tool} failed: ${e.error}`, tone: 'error' };
    case 'permission_requested':
      return { icon: '✋', text: e.title ?? `asks permission for ${e.tool}`, tone: 'warn' };
    case 'permission_resolved':
      return {
        icon: e.decision.startsWith('allow') ? '👍' : '🚫',
        text: `${e.tool}: ${e.decision.replace('_', ' ')}${e.message ? ` (${e.message})` : ''}`,
        tone: e.decision.startsWith('allow') ? 'ok' : 'warn',
      };
    case 'subagent_started':
      return {
        icon: '🧑‍🎓',
        text: `intern ${e.subagentType} arrives${e.description ? `: ${e.description}` : ''}`,
        tone: 'muted',
      };
    case 'subagent_stopped':
      return {
        icon: '🚪',
        text: `intern ${e.subagentType} leaves${e.summary ? `: ${e.summary}` : ''}`,
        tone: 'muted',
      };
    case 'notification':
      return {
        icon: '🔔',
        text: `${e.kind}: ${e.message}`,
        tone: e.kind === 'permission_denied' ? 'warn' : 'muted',
      };
    case 'turn_completed':
      return {
        icon: e.ok ? '●' : '○',
        text: `turn ${e.ok ? 'done' : `ended (${e.subtype})`} · ${fmtUsd(e.costUsd)} · ${fmtTokens(e.inputTokens + e.outputTokens)} tok`,
        tone: e.ok ? 'ok' : 'error',
      };
    case 'error':
      return {
        icon: '💧',
        text: `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message}`,
        tone: 'error',
      };
    case 'rate_limit':
      return {
        icon: '⏳',
        text: `plan window ${e.windowType ?? ''} ${e.status}${e.utilization !== undefined ? ` (${Math.round(e.utilization * 100)}%)` : ''}`,
        tone: e.status === 'rejected' ? 'error' : 'warn',
      };
    case 'interrupted':
      return { icon: '⏹', text: 'interrupted', tone: 'warn' };
    case 'compaction':
      return { icon: '🗜', text: `context compacted (${e.trigger})`, tone: 'muted' };
    case 'task_assigned':
      return { icon: '📋', text: `takes task “${e.title}”`, tone: 'normal' };
    case 'task_done':
      return {
        icon: e.ok ? '🎉' : '😓',
        text: e.ok ? 'finished the task' : 'could not finish the task',
        tone: e.ok ? 'ok' : 'error',
      };
    case 'message_sent':
      return { icon: '✉️', text: `← ${e.text}`, tone: 'normal' };
    case 'text_delta':
    case 'thinking_delta':
      return { icon: '…', text: '', tone: 'muted' };
    case 'unknown':
      return { icon: '?', text: e.raw, tone: 'muted' };
  }
}

export function toolIcon(category: AgentEvent extends { category: infer C } ? C : string): string {
  switch (category) {
    case 'read':
      return '📖';
    case 'edit':
      return '⌨️';
    case 'bash':
      return '🖥';
    case 'web':
      return '🌐';
    case 'subagent':
      return '🧑‍🎓';
    case 'ask':
    case 'plan':
      return '✋';
    case 'todo':
      return '📝';
    default:
      return '🔧';
  }
}
