import { describe, expect, it } from 'vitest';
import {
  changesOwnedElsewhere,
  manualMergeCommands,
  mergeButtonState,
  nothingToMerge,
  reviewerCanWrite,
  showMergeControls,
} from '../src/ui/merge.js';

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

  it('treats a branch with no commits ahead and no changes as nothing to merge', () => {
    const empty = { ahead: 0, dirty: false, files: [] };
    expect(nothingToMerge(empty)).toBe(true);
    expect(nothingToMerge({ ...empty, ahead: 8 })).toBe(false);
    expect(nothingToMerge({ ...empty, dirty: true })).toBe(false);
    expect(nothingToMerge({ ...empty, files: [{ status: 'untracked', path: 'x' }] })).toBe(false);
    expect(nothingToMerge(null)).toBe(false);
  });

  it('disables "Accept & merge" until the preview is loaded and there is something to merge', () => {
    const ready = { ahead: 2, dirty: false, files: [], canMerge: true };
    const ok = { merging: false, hookConsentOk: true };
    expect(mergeButtonState(null, ok)).toEqual({ disabled: true, reason: 'Checking the branch…' });
    expect(mergeButtonState(null, { ...ok, previewError: 'boom' })).toEqual({
      disabled: true,
      reason: null,
    });
    expect(mergeButtonState(ready, ok)).toEqual({ disabled: false, reason: null });
    expect(
      mergeButtonState(
        { ahead: 0, dirty: false, files: [], canMerge: false, reason: 'Nothing to merge' },
        ok,
      ),
    ).toEqual({ disabled: true, reason: 'Nothing to merge' });
    expect(mergeButtonState(ready, { ...ok, hookConsentOk: false }).disabled).toBe(true);
    expect(mergeButtonState(ready, { ...ok, merging: true }).disabled).toBe(true);
    expect(mergeButtonState({ ...ready, canMerge: false, reason: 'Cannot compare' }, ok)).toEqual({
      disabled: true,
      reason: 'Cannot compare',
    });
  });

  it("names the agent's later task when it owns the changes on the branch", () => {
    const owner = { id: 'b', title: 'notepad.py header comment', status: 'review' };
    expect(changesOwnedElsewhere({ id: 'a', status: 'done' }, { ownerTask: owner })).toEqual(owner);
    expect(changesOwnedElsewhere({ id: 'b', status: 'review' }, { ownerTask: owner })).toBeNull();
    expect(changesOwnedElsewhere({ id: 'a', status: 'done' }, {})).toBeNull();
    expect(changesOwnedElsewhere({ id: 'a', status: 'done' }, null)).toBeNull();
  });
});
