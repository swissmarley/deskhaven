import { describe, expect, it } from 'vitest';
import { manualMergeCommands, showMergeControls } from '../src/ui/merge.js';

describe('merge controls', () => {
  it('shows them only for a ready worktree task', () => {
    const agent = { worktree: { path: '/wt', branch: 'deskhaven/ada' } };
    expect(showMergeControls({ status: 'review' }, agent)).toBe(true);
    expect(showMergeControls({ status: 'done' }, agent)).toBe(true);
    expect(showMergeControls({ status: 'in_progress' }, agent)).toBe(false);
    expect(showMergeControls({ status: 'review' }, { worktree: null })).toBe(false);
    expect(showMergeControls({ status: 'review' }, undefined)).toBe(false);
  });

  it('prints squash and merge commands without a shell', () => {
    const preview = {
      worktreePath: '/wt/ada',
      sourceRoot: "/src/o'hara",
      branch: 'deskhaven/ada',
    };
    const squash = manualMergeCommands(preview, 'ship it', 'squash');
    expect(squash).toContain('merge --squash');
    expect(squash).toContain("'/src/o'\\''hara'");
    const merge = manualMergeCommands(preview, 'ship it', 'merge');
    expect(merge).toContain('merge --no-ff');
  });
});
