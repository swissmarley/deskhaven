import { describe, expect, it } from 'vitest';
import {
  collectHookFilesInMerge,
  hookFileSetsEqual,
  hookFilesFromDiffNames,
  hookRunnerFilesInDiff,
  isHookRunnerPath,
  pathMatchesHookPrefix,
  splitNameOnlyZ,
} from '../src/worktree/hook-detect.js';

describe('hook-detect', () => {
  it('splits -z name-only output', () => {
    expect(splitNameOnlyZ('a.txt\0b.txt\0')).toEqual(['a.txt', 'b.txt']);
    expect(splitNameOnlyZ('')).toEqual([]);
  });

  it('matches hook prefixes case-insensitively when configured', () => {
    const prefixes = ['.husky'];
    expect(pathMatchesHookPrefix('.HUSKY/pre-commit', prefixes, true)).toBe(true);
    expect(pathMatchesHookPrefix('.HUSKY/pre-commit', prefixes, false)).toBe(false);
    expect(pathMatchesHookPrefix('scripts/hooks/post-commit', ['scripts/hooks'], false)).toBe(true);
  });

  it('matches non-ASCII hook paths', () => {
    expect(hookFilesFromDiffNames(['hööks/pre-commit'], ['hööks'], false)).toEqual([
      'hööks/pre-commit',
    ]);
  });

  it('compares hook file sets irrespective of order', () => {
    expect(hookFileSetsEqual(['b', 'a'], ['a', 'b'])).toBe(true);
    expect(hookFileSetsEqual(['a'], ['a', 'b'])).toBe(false);
  });

  it('fails closed when the diff cannot be loaded', async () => {
    const result = await collectHookFilesInMerge(
      async () => {
        throw new Error('diff failed');
      },
      ['.husky'],
      false,
    );
    expect(result).toEqual({
      ok: false,
      code: 'verify_failed',
      message: 'Could not verify whether this merge changes git hook scripts.',
    });
  });

  it('detects hook runner config paths by basename patterns', () => {
    expect(isHookRunnerPath('apps/web/package.json', false)).toBe(true);
    expect(isHookRunnerPath('lint-staged.config.js', false)).toBe(true);
    expect(isHookRunnerPath('.lefthook.yml', false)).toBe(true);
    expect(isHookRunnerPath('lefthook-local.yaml', false)).toBe(true);
    expect(isHookRunnerPath('.config/lefthook.yml', false)).toBe(true);
    expect(isHookRunnerPath('simple-git-hooks.json', false)).toBe(true);
    expect(isHookRunnerPath('.simple-git-hooks.js', false)).toBe(true);
    expect(isHookRunnerPath('lefthook.toml', false)).toBe(true);
    expect(isHookRunnerPath('.lefthook/pre-commit', false)).toBe(true);
    expect(isHookRunnerPath('package.yaml', false)).toBe(true);
    expect(hookRunnerFilesInDiff(['commitlint.config.cjs', 'README.md'], false)).toEqual([
      'commitlint.config.cjs',
    ]);
  });
});
