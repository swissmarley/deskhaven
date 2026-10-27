import { describe, expect, it } from 'vitest';
import { manualMergeCommands, reviewerCanWrite, showMergeControls } from '../src/ui/merge.js';

describe('merge controls', () => {
  it('shows them only for a ready worktree task', () => {
    const agent = { worktree: { path: '/wt', branch: 'deskhaven/ada' } };
    expect(showMergeControls({ status: 'review' }, agent)).toBe(true);
    expect(showMergeControls({ status: 'done' }, agent)).toBe(true);
    expect(showMergeControls({ status: 'in_progress' }, agent)).toBe(false);
    expect(showMergeControls({ status: 'review' }, { worktree: null })).toBe(false);
    expect(showMergeControls({ status: 'review' }, undefined)).toBe(false);
  });

  it('hides them once the task is merged, but keeps them after a conflict', () => {
    const agent = { worktree: { path: '/wt', branch: 'deskhaven/ada' } };
    expect(showMergeControls({ status: 'done', merge: { status: 'merged' } }, agent)).toBe(false);
    expect(showMergeControls({ status: 'done', merge: { status: 'conflict' } }, agent)).toBe(true);
    expect(showMergeControls({ status: 'done', merge: { status: 'failed' } }, agent)).toBe(true);
  });

  it('prints squash and merge commands without a shell', () => {
    const preview = {
      worktreePath: '/wt/ada',
      sourceRoot: "/src/o'hara",
      branch: 'deskhaven/ada',
    };
    const squash = manualMergeCommands(preview, 'ship it', 'squash');
    expect(squash).toContain('merge --squash');
    expect(squash).toContain("git -C '/src/o'\\''hara' commit -m 'ship it'");
    expect(squash).toContain("'/src/o'\\''hara'");
    const merge = manualMergeCommands(preview, 'ship it', 'merge');
    expect(merge).toContain('merge --no-ff');
  });

  it('warns when a reviewer can do more than read', () => {
    expect(
      reviewerCanWrite({ tools: ['Read', 'Grep', 'Glob', 'LS'], allowedTools: ['Read'] }),
    ).toBe(false);
    expect(reviewerCanWrite({ tools: null, allowedTools: ['Read', 'Edit'] })).toBe(true);
    expect(reviewerCanWrite({ tools: ['Read', 'Bash'], allowedTools: ['Read'] })).toBe(true);
    expect(reviewerCanWrite(undefined)).toBe(false);
  });
});
