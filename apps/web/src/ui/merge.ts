import type { Agent, MergePreview, MergeStrategy, Task } from '@deskhaven/shared';

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
  const merge =
    strategy === 'squash'
      ? `git -C ${shellQuote(preview.sourceRoot)} merge --squash ${shellQuote(preview.branch)}`
      : `git -C ${shellQuote(preview.sourceRoot)} merge --no-ff -m ${shellQuote(message)} ${shellQuote(preview.branch)}`;
  return `${commit}\n${merge}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
