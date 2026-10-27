import { describe, expect, it } from 'vitest';
import {
  collectHookFilesInMerge,
  hookFilesFromDiffNames,
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
});
