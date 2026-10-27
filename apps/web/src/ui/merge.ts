import type { Agent, MergePreview, MergeStrategy, Task } from '@deskhaven/shared';

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);

/**
 * True when the agent can edit or run tools beyond a read-only review. `tools: null` is the full
 * default set (an Engineer), which is not read-only. A warning is shown; the server still allows
 * the assignment, because a QA reviewer may need Bash. Self-review is rejected separately.
 */
export function reviewerCanWrite(
  agent: Pick<Agent, 'tools' | 'allowedTools'> | undefined,
): boolean {
  if (!agent) return false;
  if (agent.tools === null) return true;
  const names = new Set([...agent.tools, ...agent.allowedTools]);
  for (const name of names) {
    if (!READ_ONLY_TOOLS.has(name)) return true;
  }
  return false;
}

/** The merge controls exist only for a worktree agent whose task is ready to accept. */
export function showMergeControls(
  task: Pick<Task, 'status'>,
  agent: Pick<Agent, 'worktree'> | undefined,
): boolean {
  return Boolean(agent?.worktree) && (task.status === 'review' || task.status === 'done');
}

export function manualMergeCommands(
  preview: Pick<MergePreview, 'worktreePath' | 'sourceRoot' | 'branch'>,
  message: string,
  strategy: MergeStrategy,
): string {
  const commit = `git -C ${shellQuote(preview.worktreePath)} add -A && git -C ${shellQuote(preview.worktreePath)} commit -m ${shellQuote(message)}`;
  const source = shellQuote(preview.sourceRoot);
  const branch = shellQuote(preview.branch);
  const merge =
    strategy === 'squash'
      ? `git -C ${source} merge --squash -- ${branch}\ngit -C ${source} commit -m ${shellQuote(message)}`
      : `git -C ${source} merge --no-ff -m ${shellQuote(message)} -- ${branch}`;
  return `${commit}\n${merge}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
