/**
 * Classification of Claude Code tool names into the categories the game cares about.
 * Keep this the single place that knows tool names; everything else works with categories.
 */
export type ToolCategory =
  | 'read'
  | 'edit'
  | 'bash'
  | 'web'
  | 'subagent'
  | 'ask'
  | 'plan'
  | 'todo'
  | 'mcp'
  | 'other';

const READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'ReadFile',
  'ToolSearch',
]);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const BASH_TOOLS = new Set(['Bash', 'BashOutput', 'KillShell', 'KillBash', 'Monitor']);
const WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);
const SUBAGENT_TOOLS = new Set(['Task', 'Agent', 'Workflow']);
const ASK_TOOLS = new Set(['AskUserQuestion']);
const PLAN_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode']);
const TODO_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskCreate', 'TaskUpdate']);

export function classifyTool(toolName: string): ToolCategory {
  if (READ_TOOLS.has(toolName)) return 'read';
  if (EDIT_TOOLS.has(toolName)) return 'edit';
  if (BASH_TOOLS.has(toolName)) return 'bash';
  if (WEB_TOOLS.has(toolName)) return 'web';
  if (SUBAGENT_TOOLS.has(toolName)) return 'subagent';
  if (ASK_TOOLS.has(toolName)) return 'ask';
  if (PLAN_TOOLS.has(toolName)) return 'plan';
  if (TODO_TOOLS.has(toolName)) return 'todo';
  if (toolName.startsWith('mcp__')) return 'mcp';
  return 'other';
}

/** Tools that may change the filesystem or run processes; they need approval unless a preset allows them. */
export function isDangerousTool(toolName: string): boolean {
  const c = classifyTool(toolName);
  return c === 'edit' || c === 'bash';
}

/** Short human summary of a tool call input, for bubbles and the feed. Never throws. */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const rec = (input ?? {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof rec[k] === 'string' ? (rec[k] as string) : undefined;
  switch (classifyTool(toolName)) {
    case 'read':
      return str('file_path') ?? str('pattern') ?? str('path') ?? str('query') ?? toolName;
    case 'edit':
      return str('file_path') ?? str('notebook_path') ?? toolName;
    case 'bash':
      return str('command') ?? str('description') ?? toolName;
    case 'web':
      return str('query') ?? str('url') ?? toolName;
    case 'subagent':
      return str('description') ?? str('prompt')?.slice(0, 80) ?? toolName;
    case 'ask':
      return 'asking a question';
    case 'plan':
      return 'plan ready for review';
    case 'todo':
      return 'updating the plan';
    default:
      return toolName;
  }
}

export function truncate(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Tool names the bundled Claude Code no longer has (not in the SDK's `sdk-tools.d.ts`, 0.3.287).
 * Re-check on SDK upgrades.
 */
export const RETIRED_TOOLS: ReadonlySet<string> = new Set(['LS', 'MultiEdit']);

/** The tool an `allowedTools` rule names: `Bash(npm test:*)` → `Bash`. */
export function toolRuleName(rule: string): string {
  const i = rule.indexOf('(');
  return (i < 0 ? rule : rule.slice(0, i)).trim();
}

/**
 * An agent's tool lists without dead entries: retired tool names are dropped from both, and
 * `allowedTools` (the auto-approve list) keeps only rules for tools the session actually has, which
 * are the agent's own `tools` or, when that is null, its preset's. With neither, every tool exists
 * and only retired names go.
 */
export function normalizeToolLists(
  tools: string[] | null,
  allowedTools: string[],
  presetTools: string[] | null | undefined,
): { tools: string[] | null; allowedTools: string[] } {
  const live = (name: string) => !RETIRED_TOOLS.has(name);
  const ownTools = tools ? tools.filter(live) : null;
  const effective = ownTools ?? presetTools?.filter(live) ?? null;
  const available = effective ? new Set(effective) : null;
  const allowed = allowedTools.filter((rule) => {
    const name = toolRuleName(rule);
    return live(name) && (!available || available.has(name));
  });
  return { tools: ownTools, allowedTools: [...new Set(allowed)] };
}
