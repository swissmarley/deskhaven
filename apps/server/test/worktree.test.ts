import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { slugify, WorktreeService } from '../src/worktree/service.js';

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-wt-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

describe('WorktreeService', () => {
  it('creates, detects dirt, refuses dirty removal, then force-removes', async () => {
    const repo = tmpRepo();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    expect(await svc.isGitRepo(repo)).toBe(true);
    expect(await svc.isGitRepo(os.tmpdir())).toBe(false);
    const wt = await svc.create(repo, 'abcdef123456', 'Ada Lovelace');
    expect(wt.branch).toBe('deskhaven/ada-lovelace-abcdef');
    expect(fs.existsSync(path.join(wt.path, 'a.txt'))).toBe(true);
    expect(await svc.isDirty(wt.path)).toBe(false);
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'new\n');
    fs.appendFileSync(path.join(wt.path, 'a.txt'), 'more\n');
    expect(await svc.isDirty(wt.path)).toBe(true);
    const changed = await svc.changedFiles(wt.path);
    expect(changed.map((c) => c.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(changed.find((c) => c.path === 'a.txt')).toMatchObject({ additions: 1, deletions: 0 });
    await expect(svc.remove(repo, wt)).rejects.toThrow(/uncommitted/);
    await svc.remove(repo, wt, true);
    expect(fs.existsSync(wt.path)).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
  it('slugifies names', () => {
    expect(slugify('Ada Lovelace!')).toBe('ada-lovelace');
    expect(slugify('***')).toBe('agent');
  });
});

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function identity(dir: string): void {
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'user.email', 't@t');
}

/** HEAD, index and tracked worktree of `dir`, so a failed merge can be compared byte for byte. */
function snapshot(dir: string): string {
  const head = git(dir, 'rev-parse', 'HEAD').trim();
  const status = git(dir, 'status', '--porcelain');
  const tracked = git(dir, 'diff', 'HEAD');
  const staged = git(dir, 'diff', '--cached');
  return `${head}\n${status}\n${tracked}\n${staged}`;
}

describe('merging a worktree branch', { timeout: 20_000 }, () => {
  it('commits, squash-merges, realigns, and merges again without a conflict', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'abcdef123456', 'Ada');
    expect(wt.baseBranch).toBe('main');
    expect(wt.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'from the agent\n');
    const st = await svc.status(wt, 'main');
    expect(st).toMatchObject({ dirty: true, canMerge: true, ahead: 0 });
    expect(st.files.map((f) => f.path)).toContain('b.txt');
    const committed = await svc.commitAll(wt, 'add b');
    expect(committed.committed).toBe(true);
    const first = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'deskhaven: add b');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(git(repo, 'log', '-1', '--format=%s').trim()).toBe('deskhaven: add b');
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('from the agent\n');
    await svc.syncToTarget(wt, first.commit);
    expect(git(wt.path, 'rev-parse', 'HEAD').trim()).toBe(first.commit);
    expect(await svc.isDirty(wt.path)).toBe(false);
    fs.writeFileSync(path.join(wt.path, 'c.txt'), 'second\n');
    await svc.commitAll(wt, 'add c');
    const second = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'deskhaven: add c');
    expect(second.ok).toBe(true);
    if (second.ok) await svc.syncToTarget(wt, second.commit);
    expect(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8')).toBe('second\n');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('can make a --no-ff merge commit, which then allows git branch -d', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'bbbbbb222222', 'Bea');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'bea\n');
    await svc.commitAll(wt, 'bea');
    const merged = await svc.mergeInto(repo, wt.branch, 'main', 'merge', 'deskhaven: bea');
    expect(merged.ok).toBe(true);
    expect(git(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
    await svc.remove(repo, wt);
    const dropped = await svc.deleteBranch(repo, wt.branch);
    expect(dropped).toEqual({ deleted: true });
    expect(git(repo, 'branch', '--list', wt.branch).trim()).toBe('');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('refuses a dirty or wrong-branch source and does not change it', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'cccccc333333', 'Cara');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'cara\n');
    await svc.commitAll(wt, 'cara');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'local\n');
    const before = snapshot(repo);
    const dirty = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'nope');
    expect(dirty).toMatchObject({ ok: false, code: 'source_dirty' });
    expect(snapshot(repo)).toBe(before);
    git(repo, 'checkout', '--', 'a.txt');
    git(repo, 'checkout', '--detach');
    const detached = snapshot(repo);
    const wrong = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'nope');
    expect(wrong).toMatchObject({ ok: false, code: 'wrong_branch' });
    expect(snapshot(repo)).toBe(detached);
    const bogus = await svc.mergeInto(repo, 'foo;rm -rf /', 'main', 'squash', 'nope');
    expect(bogus).toMatchObject({ ok: false, code: 'invalid_branch' });
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('aborts a conflict and leaves the source checkout identical', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'dddddd444444', 'Dee');
    fs.writeFileSync(path.join(wt.path, 'a.txt'), 'from the agent\n');
    await svc.commitAll(wt, 'agent edit');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from the user\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'user edit');
    const before = snapshot(repo);
    const squash = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'conflict');
    expect(squash).toMatchObject({ ok: false, code: 'conflict' });
    if (!squash.ok) expect(squash.conflictFiles).toContain('a.txt');
    expect(snapshot(repo)).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('from the user\n');
    const merge = await svc.mergeInto(repo, wt.branch, 'main', 'merge', 'conflict');
    expect(merge).toMatchObject({ ok: false, code: 'conflict' });
    expect(snapshot(repo)).toBe(before);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const gitDir = path.resolve(repo, git(repo, 'rev-parse', '--git-dir').trim());
    expect(fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'SQUASH_MSG'))).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('resets only a clean worktree and will not force-delete an unmerged branch', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'eeeeee555555', 'Eve');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'eve\n');
    const tip = (await svc.commitAll(wt, 'eve')).commit ?? '';
    fs.writeFileSync(path.join(wt.path, 'dirty.txt'), 'wip\n');
    await expect(svc.syncToTarget(wt, tip)).rejects.toThrow(/dirty worktree/);
    expect(fs.existsSync(path.join(wt.path, 'dirty.txt'))).toBe(true);
    git(wt.path, 'checkout', '--', '.');
    fs.rmSync(path.join(wt.path, 'dirty.txt'), { force: true });
    await svc.remove(repo, wt);
    const kept = await svc.deleteBranch(repo, wt.branch, 'main');
    expect(kept.deleted).toBe(false);
    expect(kept.warning).toMatch(/not fully merged/);
    expect(kept.warning).toContain('main');
    expect(git(repo, 'branch', '--list', wt.branch)).toContain(wt.branch);
    await expect(svc.syncToTarget(wt, 'not-a-sha')).rejects.toThrow(/Refusing to reset/);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('reports the review diff against the base branch', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'ffffff666666', 'Fay');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'fay\n');
    await svc.commitAll(wt, 'fay');
    const material = await svc.reviewDiff(wt.path, 'main');
    expect(material.files).toContain('b.txt');
    expect(material.diff).toContain('+fay');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('refuses to commit or realign when the worktree left its branch', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'moved11111111', 'Moved');
    const sourceBefore = git(repo, 'rev-parse', 'HEAD').trim();
    git(wt.path, 'checkout', '--detach', '-q');
    fs.writeFileSync(path.join(wt.path, 'lost.txt'), 'keep me\n');
    await expect(svc.commitAll(wt, 'should not land')).rejects.toThrow(/worktree_moved/);
    expect(fs.readFileSync(path.join(wt.path, 'lost.txt'), 'utf8')).toBe('keep me\n');
    expect(git(wt.path, 'status', '--porcelain')).toContain('lost.txt');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(sourceBefore);

    git(wt.path, 'checkout', '-q', '-b', 'fix');
    git(wt.path, 'add', '-A');
    git(wt.path, 'commit', '-q', '-m', 'on fix');
    const fixTip = git(wt.path, 'rev-parse', 'HEAD').trim();
    await expect(svc.syncToTarget(wt, sourceBefore)).rejects.toThrow(/worktree_moved/);
    expect(git(wt.path, 'rev-parse', 'HEAD').trim()).toBe(fixTip);
    expect(fs.readFileSync(path.join(wt.path, 'lost.txt'), 'utf8')).toBe('keep me\n');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('returns nothing_to_merge when the branch is already integrated', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'empty22222222', 'Empty');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'once\n');
    await svc.commitAll(wt, 'once');
    const first = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'deskhaven: once');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await svc.syncToTarget(wt, first.commit);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const again = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'deskhaven: again');
    expect(again).toMatchObject({ ok: false, code: 'nothing_to_merge' });
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    const noff = await svc.mergeInto(repo, wt.branch, 'main', 'merge', 'deskhaven: again');
    expect(noff).toMatchObject({ ok: false, code: 'nothing_to_merge' });
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('does not run a post-commit hook installed in the worktree', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'hooks33333333', 'Hooks');
    const hooks = path.join(wt.path, '.husky');
    fs.mkdirSync(hooks);
    const marker = path.join(wt.path, 'hook-ran');
    fs.writeFileSync(
      path.join(hooks, 'post-commit'),
      `#!/bin/sh\necho ran >> ${JSON.stringify(marker).slice(1, -1)}\n`,
    );
    fs.chmodSync(path.join(hooks, 'post-commit'), 0o755);
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755);
    git(wt.path, 'config', 'core.hooksPath', '.husky');
    fs.writeFileSync(path.join(wt.path, 'b.txt'), 'hooked\n');
    const committed = await svc.commitAll(wt, 'hooked');
    expect(committed.committed).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(wt.branch);
    expect(git(wt.path, 'log', '-1', '--format=%s').trim()).toBe('hooked');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('reports a failed merge with the untracked filename and leaves the source file', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'collide444444', 'Col');
    fs.writeFileSync(path.join(wt.path, 'collision.txt'), 'from the agent\n');
    await svc.commitAll(wt, 'add collision');
    fs.writeFileSync(path.join(repo, 'collision.txt'), 'local untracked\n');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const failed = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'nope');
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.code).toBe('failed');
    expect(failed.message).toContain('collision.txt');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'collision.txt'), 'utf8')).toBe('local untracked\n');
    expect(git(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('lists renames and paths that need quoting', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'rename5555555', 'Ren');
    git(wt.path, 'mv', 'a.txt', 'a file.txt');
    fs.writeFileSync(path.join(wt.path, 'quote".txt'), 'q\n');
    const st = await svc.status(wt, 'main');
    expect(st.files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['a file.txt', 'quote".txt']),
    );
    expect(st.files.find((f) => f.path === 'a file.txt')?.status.startsWith('R')).toBe(true);
    expect(st.files.some((f) => f.path.includes('"a file.txt"'))).toBe(false);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('merges a subdirectory worktree at the repository root', async () => {
    const repo = tmpRepo();
    identity(repo);
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'lib.txt'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'lib');
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(sub, 'subdir6666666', 'Sub');
    expect(wt.subdir).toBe('pkg');
    expect(wt.sourceRoot).toBe(fs.realpathSync(repo));
    fs.writeFileSync(path.join(wt.path, 'pkg', 'lib.txt'), 'v2\n');
    await svc.commitAll(wt, 'lib v2');
    const merged = await svc.mergeInto(
      wt.sourceRoot ?? repo,
      wt.branch,
      'main',
      'squash',
      'deskhaven: lib',
    );
    expect(merged.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'pkg', 'lib.txt'), 'utf8')).toBe('v2\n');
    expect(git(repo, 'rev-parse', '--show-toplevel').trim()).toBe(fs.realpathSync(repo));
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('names a unicode branch and rejects one this service will not pass to git', async () => {
    const repo = tmpRepo();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    git(repo, 'checkout', '-q', '-b', 'topic/café');
    expect(await svc.currentBranch(repo)).toMatchObject({ branch: 'topic/café' });
    git(repo, 'checkout', '-q', '-b', 'foo;bar');
    await expect(svc.currentBranch(repo)).rejects.toThrow(/invalid_branch/);
    const named = await svc.mergeInto(repo, 'main', 'main', 'squash', 'nope');
    expect(named).toMatchObject({ ok: false, code: 'invalid_branch' });
    if (!named.ok) expect(named.message).toMatch(/Invalid branch name/);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('does not invoke gpg for a worktree commit', async () => {
    const repo = tmpRepo();
    identity(repo);
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'gpg777777777', 'Gpg');
    const marker = path.join(data, 'gpg-ran');
    const program = path.join(data, 'gpg-fake.sh');
    fs.writeFileSync(program, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
    fs.chmodSync(program, 0o755);
    const n = Number(process.env.GIT_CONFIG_COUNT ?? '0');
    const prevCount = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = String(n + 2);
    process.env[`GIT_CONFIG_KEY_${n}`] = 'commit.gpgsign';
    process.env[`GIT_CONFIG_VALUE_${n}`] = 'true';
    process.env[`GIT_CONFIG_KEY_${n + 1}`] = 'gpg.program';
    process.env[`GIT_CONFIG_VALUE_${n + 1}`] = program;
    try {
      fs.writeFileSync(path.join(wt.path, 'b.txt'), 'x\n');
      const committed = await svc.commitAll(wt, 'unsigned');
      expect(committed.committed).toBe(true);
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (prevCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prevCount;
      delete process.env[`GIT_CONFIG_KEY_${n}`];
      delete process.env[`GIT_CONFIG_VALUE_${n}`];
      delete process.env[`GIT_CONFIG_KEY_${n + 1}`];
      delete process.env[`GIT_CONFIG_VALUE_${n + 1}`];
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(data, { recursive: true, force: true });
    }
  });

  it('refuses a merge that changes files under the hooks directory', async () => {
    const repo = tmpRepo();
    identity(repo);
    git(repo, 'config', 'core.hooksPath', '.husky');
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const wt = await svc.create(repo, 'hookchg888888', 'Hook');
    const hooks = path.join(wt.path, '.husky');
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, 'post-merge'), '#!/bin/sh\necho merge-hook\n');
    fs.chmodSync(path.join(hooks, 'post-merge'), 0o755);
    await svc.commitAll(wt, 'add hook');
    const blocked = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'nope');
    expect(blocked).toMatchObject({ ok: false, code: 'hooks_changed' });
    if (!blocked.ok) expect(blocked.hookFiles?.length).toBeGreaterThan(0);
    const allowed = await svc.mergeInto(repo, wt.branch, 'main', 'squash', 'ok', {
      allowHookChanges: true,
    });
    expect(allowed.ok).toBe(true);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });

  it('runs one merge at a time per source repository', async () => {
    const repo = tmpRepo();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-data-'));
    const svc = new WorktreeService(data);
    const order: string[] = [];
    const first = svc.withSourceLock(repo, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 30));
      order.push('first-end');
    });
    const second = svc.withSourceLock(repo, async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(data, { recursive: true, force: true });
  });
});
