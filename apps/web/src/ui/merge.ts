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

/**
 * The merge controls exist only for a worktree agent whose task is ready to accept and has not
 * been merged yet: a second merge would silently carry whatever is left in the worktree into main.
 */
export function showMergeControls(
  task: Pick<Task, 'status'> & { merge?: Pick<NonNullable<Task['merge']>, 'status'> | null },
  agent: Pick<Agent, 'worktree'> | undefined,
): boolean {
  if (task.merge?.status === 'merged') return false;
  return Boolean(agent?.worktree) && (task.status === 'review' || task.status === 'done');
}

/**
 * True when the branch has nothing to integrate: no commits ahead of the target, no uncommitted
 * changes and no files. The worktree belongs to the agent, so this is also what a task sees after
 * another task of the same agent was merged (the branch is realigned onto the merge commit).
 */
export function nothingToMerge(
  preview: Pick<MergePreview, 'ahead' | 'dirty' | 'files'> | null | undefined,
): boolean {
  if (!preview) return false;
  return preview.ahead === 0 && !preview.dirty && preview.files.length === 0;
}

/**
 * Whether "Accept & merge" can be pressed, and why not. The button stays disabled until the preview
 * has loaded: confirming against a preview that is still on its way would be reset when it lands.
 */
export function mergeButtonState(
  preview: Pick<MergePreview, 'ahead' | 'dirty' | 'files' | 'canMerge' | 'reason'> | null,
  opts: { merging: boolean; hookConsentOk: boolean; previewError?: string | null },
): { disabled: boolean; reason: string | null } {
  if (opts.merging) return { disabled: true, reason: null };
  if (!preview) {
    return { disabled: true, reason: opts.previewError ? null : 'Checking the branch…' };
  }
  if (nothingToMerge(preview)) return { disabled: true, reason: 'Nothing to merge' };
  if (!preview.canMerge) return { disabled: true, reason: preview.reason ?? 'Cannot merge' };
  if (!opts.hookConsentOk) return { disabled: true, reason: 'Tick one of the hook options above' };
  return { disabled: false, reason: null };
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
