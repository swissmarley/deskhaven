import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { isInside } from '../agent/diff-tracker.js';

const run = promisify(execFile);

export interface WorktreeInfo {
  /** The worktree root. */
  path: string;
  branch: string;
  /** The hired folder relative to the repository root, `/`-separated; absent for the root. */
  subdir?: string;
  /** Source branch at hire time (`git symbolic-ref --short HEAD`). */
  baseBranch?: string;
  /** Source commit at hire time. */
  baseCommit?: string;
}

export interface MergeFile {
  path: string;
  status: string;
}

export interface WorktreeBranchStatus {
  ahead: number;
  behind: number;
  dirty: boolean;
  files: MergeFile[];
  canMerge: boolean;
  reason?: string;
}

export type MergeStrategy = 'squash' | 'merge';

export type MergeOutcome =
  | { ok: true; commit: string }
  | {
      ok: false;
      code: 'source_dirty' | 'wrong_branch' | 'conflict' | 'failed' | 'invalid_branch';
      message: string;
      conflictFiles?: string[];
    };

/**
 * Branch names that may be passed to git. Stricter than `check-ref-format` (which accepts `foo;rm`):
 * one path segment sequence, no shell metacharacters, no leading dash.
 */
const BRANCH_NAME =
  /^(?![-.])(?!.*\.\.)(?!.*@{)(?!.*\/\/)(?!.*[~^:?*[\\\s;|&$`'"<>])(?!.*\.lock$)(?!.*\/$)(?!.*\.$)[A-Za-z0-9._/-]+$/;

export function assertBranchName(name: string): string {
  if (name.length === 0 || name.length > 200 || !BRANCH_NAME.test(name))
    throw new Error(`Invalid branch name: ${name}`);
  return name;
}

/**
 * Whether firing an agent would lose work. `unknown` (git could not answer, e.g. because the source
 * repository was moved or deleted and the worktree's link into it is broken) must be treated like
 * `dirty` unless the user forces removal.
 */
export type WorktreeState =
  | { kind: 'clean' }
  | { kind: 'dirty' }
  | { kind: 'missing' }
  | { kind: 'unknown'; reason: string };

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Git worktrees give parallel engineers on one repo their own checkout. Worktrees live under the data
 * dir, never inside the repo, and are removed only through an explicit call that first checks for
 * uncommitted changes.
 */
export class WorktreeService {
  /** Serializes merge/commit against one source repository. */
  private readonly lockTails = new Map<string, Promise<void>>();

  constructor(private readonly dataDir: string) {}

  /**
   * One merge at a time per source checkout. Re-entering the same lock from the queued turn is not
   * supported; callers must not take it twice on one call stack.
   */
  async withSourceLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    let key = dir;
    try {
      key = fs.realpathSync(dir);
    } catch {
      // The directory may be missing; still serialize on the path we were given.
    }
    const prev = this.lockTails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.lockTails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.lockTails.get(key) === tail) this.lockTails.delete(key);
    }
  }

  root(): string {
    return path.join(this.dataDir, 'worktrees');
  }

  async isGitRepo(dir: string): Promise<boolean> {
    try {
      const { stdout } = await run('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: dir,
        timeout: 10_000,
      });
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  /** The repository root containing `dir` (git's own answer, symlinks resolved). */
  async toplevel(dir: string): Promise<string> {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      timeout: 10_000,
    });
    return fs.realpathSync(stdout.trim());
  }

  /**
   * A worktree of the repository that contains `workdir`, on a new branch. When `workdir` is a
   * subfolder of the repository, the same subfolder is recorded as `subdir` so the agent works there
   * (and its edit guard is scoped to it) instead of in the whole checkout.
   */
  async create(workdir: string, agentId: string, agentName: string): Promise<WorktreeInfo> {
    if (!(await this.isGitRepo(workdir)))
      throw new Error(`${workdir} is not a git repository; worktrees need git`);
    const repoDir = await this.toplevel(workdir);
    const rel = path.relative(repoDir, fs.realpathSync(workdir));
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    const subdir = rel && !outside ? rel.split(path.sep).join('/') : undefined;
    const slug = `${slugify(agentName)}-${agentId.slice(0, 6)}`;
    const branch = `deskhaven/${slug}`;
    const target = path.join(this.root(), slug);
    fs.mkdirSync(this.root(), { recursive: true });
    if (fs.existsSync(target)) throw new Error(`worktree path already exists: ${target}`);
    try {
      await run('git', ['worktree', 'add', '-b', branch, target], {
        cwd: repoDir,
        timeout: 60_000,
      });
    } catch (err) {
      // Branch may exist from an earlier run: attach to it instead of failing.
      if (String(err).includes('already exists')) {
        await run('git', ['worktree', 'add', target, branch], { cwd: repoDir, timeout: 60_000 });
      } else throw err;
    }
    if (subdir && !fs.existsSync(path.join(target, subdir))) {
      // An untracked or ignored folder is not in a fresh checkout; create it so the agent has a cwd.
      fs.mkdirSync(path.join(target, subdir), { recursive: true });
    }
    const base = await this.currentBranch(repoDir);
    return {
      path: target,
      branch,
      ...(subdir ? { subdir } : {}),
      ...(base ? { baseBranch: base.branch, baseCommit: base.commit } : {}),
    };
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    const { stdout } = await run('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      timeout: 20_000,
    });
    return stdout.trim().length > 0;
  }

  /**
   * The source repository's root. `repoDir` is the agent's workdir, which is a subfolder of the
   * repository when the worktree records a `subdir`; git commands and prune must run at the root,
   * which still exists when only that subfolder was removed.
   */
  sourceRoot(repoDir: string, wt: WorktreeInfo): string {
    if (!wt.subdir) return repoDir;
    const depth = wt.subdir.split('/').filter(Boolean).length;
    return path.resolve(repoDir, ...Array<string>(depth).fill('..'));
  }

  /** Clean, dirty, already gone, or unknown (with the reason) — never throws. */
  async state(repoDir: string, wt: WorktreeInfo): Promise<WorktreeState> {
    repoDir = this.sourceRoot(repoDir, wt);
    if (!fs.existsSync(wt.path)) return { kind: 'missing' };
    try {
      return (await this.isDirty(wt.path)) ? { kind: 'dirty' } : { kind: 'clean' };
    } catch (err) {
      const reason = isDir(repoDir)
        ? `git status failed: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`
        : `its source repository ${repoDir} was moved or deleted`;
      return { kind: 'unknown', reason };
    }
  }

  /** `git worktree prune` in the source repository, when it still exists. Never throws. */
  async prune(repoDir: string): Promise<void> {
    if (!isDir(repoDir)) return;
    await run('git', ['worktree', 'prune'], { cwd: repoDir, timeout: 20_000 }).catch(
      () => undefined,
    );
  }

  /**
   * Removes the worktree (keeps the branch). Refuses when it is dirty, or when its state cannot be
   * determined, unless `force`. A forced removal works without git when the source repository is
   * gone: the folder is deleted directly and the repository's stale entry is pruned if it exists.
   */
  async remove(workdir: string, wt: WorktreeInfo, force = false): Promise<void> {
    const repoDir = this.sourceRoot(workdir, wt);
    const state = await this.state(workdir, wt);
    if (state.kind === 'missing') return this.prune(repoDir);
    if (!force) {
      if (state.kind === 'dirty')
        throw new Error(
          `worktree ${wt.path} has uncommitted changes; commit them or force removal`,
        );
      if (state.kind === 'unknown')
        throw new Error(
          `cannot check worktree ${wt.path} for uncommitted changes (${state.reason}); force removal to delete the folder anyway`,
        );
    }
    if (isDir(repoDir)) {
      try {
        await run('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], {
          cwd: repoDir,
          timeout: 60_000,
        });
        return;
      } catch (err) {
        if (!force) throw err;
        // e.g. the worktree is not registered in this repository any more: fall through.
      }
    }
    // Deleting without git: only ever a folder inside our worktrees root, never the root itself
    // (a corrupted or hand-edited database row must not point this at anything else).
    const root = this.root();
    if (!isInside(root, wt.path) || isInside(wt.path, root))
      throw new Error(`refusing to delete ${wt.path}: it is not inside ${root}`);
    fs.rmSync(wt.path, { recursive: true, force: true });
    await this.prune(repoDir);
  }

  /** `git diff --stat`-style summary of what changed in a workdir since HEAD (tracked + untracked). */
  async changedFiles(
    dir: string,
  ): Promise<{ path: string; additions?: number; deletions?: number }[]> {
    if (!(await this.isGitRepo(dir))) return [];
    const out: { path: string; additions?: number; deletions?: number }[] = [];
    try {
      const { stdout } = await run('git', ['diff', '--numstat', 'HEAD'], {
        cwd: dir,
        timeout: 20_000,
      });
      for (const line of stdout.split('\n')) {
        const [a, d, p] = line.split('\t');
        if (p)
          out.push({
            path: p,
            additions: a === '-' ? undefined : Number(a),
            deletions: d === '-' ? undefined : Number(d),
          });
      }
      const untracked = await run('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: dir,
        timeout: 20_000,
      });
      for (const p of untracked.stdout.split('\n').filter(Boolean)) out.push({ path: p });
    } catch {
      // not fatal
    }
    return out;
  }

  /** The branch checked out in `dir`, or null when git cannot name one (detached HEAD). */
  async currentBranch(dir: string): Promise<{ branch: string; commit: string } | null> {
    try {
      const branch = (await this.git(dir, ['symbolic-ref', '--short', 'HEAD'])).trim();
      const commit = (await this.git(dir, ['rev-parse', 'HEAD'])).trim();
      if (!branch || !commit) return null;
      assertBranchName(branch);
      return { branch, commit };
    } catch {
      return null;
    }
  }

  /**
   * Ahead/behind versus `target`, plus committed and uncommitted files. `canMerge` is false only when
   * there is nothing on the branch to integrate.
   */
  async status(wt: WorktreeInfo, target: string): Promise<WorktreeBranchStatus> {
    assertBranchName(target);
    assertBranchName(wt.branch);
    const dirty = await this.isDirty(wt.path);
    let ahead = 0;
    let behind = 0;
    try {
      const counts = (
        await this.git(wt.path, ['rev-list', '--left-right', '--count', `${target}...${wt.branch}`])
      ).trim();
      const parts = counts.split(/\s+/);
      const left = Number(parts[0]);
      const right = Number(parts[1]);
      behind = Number.isFinite(left) ? left : 0;
      ahead = Number.isFinite(right) ? right : 0;
    } catch {
      return {
        ahead: 0,
        behind: 0,
        dirty,
        files: [],
        canMerge: false,
        reason: `Cannot compare ${wt.branch} with ${target}`,
      };
    }
    const files = await this.mergeFiles(wt, target);
    const canMerge = dirty || ahead > 0 || files.length > 0;
    return {
      ahead,
      behind,
      dirty,
      files,
      canMerge,
      ...(canMerge ? {} : { reason: 'Nothing to merge' }),
    };
  }

  /** Stage and commit everything in the worktree. No-op when the tree is clean. Never touches the source checkout. */
  async commitAll(
    wt: WorktreeInfo,
    message: string,
  ): Promise<{ committed: boolean; commit?: string }> {
    assertBranchName(wt.branch);
    if (!(await this.isDirty(wt.path))) return { committed: false };
    await this.git(wt.path, ['add', '-A'], 60_000);
    if (!(await this.isDirty(wt.path))) return { committed: false };
    const identity = await this.identityArgs(wt.path);
    await this.git(wt.path, [...identity, 'commit', '-m', message], 60_000);
    return { committed: true, commit: (await this.git(wt.path, ['rev-parse', 'HEAD'])).trim() };
  }

  /**
   * Merge `branch` into the source checkout, which must already be on `target` and clean of tracked
   * changes. Never checks out, stashes, or hard-resets that checkout. On conflict the source tree is
   * restored (`merge --abort`, or `reset --merge` for a squash, which does not create MERGE_HEAD).
   */
  async mergeInto(
    sourceRoot: string,
    branch: string,
    target: string,
    strategy: MergeStrategy,
    message: string,
  ): Promise<MergeOutcome> {
    try {
      assertBranchName(branch);
      assertBranchName(target);
    } catch (err) {
      return {
        ok: false,
        code: 'invalid_branch',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const headBefore = (await this.git(sourceRoot, ['rev-parse', 'HEAD'])).trim();
    const tracked = (
      await this.git(sourceRoot, ['status', '--porcelain', '--untracked-files=no'])
    ).trim();
    if (tracked) {
      return {
        ok: false,
        code: 'source_dirty',
        message:
          'The source checkout has uncommitted changes. Commit or stash them yourself, then merge again. Deskhaven will not touch a dirty checkout.',
      };
    }
    let current: string;
    try {
      current = (await this.git(sourceRoot, ['symbolic-ref', '--short', 'HEAD'])).trim();
      assertBranchName(current);
    } catch {
      return {
        ok: false,
        code: 'wrong_branch',
        message:
          'The source checkout is in detached HEAD. Deskhaven will not switch branches. Check out the target branch yourself, then merge again.',
      };
    }
    if (current !== target) {
      return {
        ok: false,
        code: 'wrong_branch',
        message: `The source checkout is on ${current}, not ${target}. Deskhaven will not switch branches.`,
      };
    }
    const identity = await this.identityArgs(sourceRoot);
    try {
      if (strategy === 'squash') {
        await this.git(sourceRoot, ['merge', '--squash', branch], 60_000);
        const staged = (await this.git(sourceRoot, ['diff', '--cached', '--name-only'])).trim();
        const headNow = (await this.git(sourceRoot, ['rev-parse', 'HEAD'])).trim();
        if (!staged && headNow === headBefore) return { ok: true, commit: headBefore };
        try {
          await this.git(sourceRoot, [...identity, 'commit', '-m', message], 60_000);
        } catch (err) {
          await this.restoreSource(sourceRoot, 'squash');
          return {
            ok: false,
            code: 'failed',
            message: gitText(err) || 'The squash commit failed. The source checkout was restored.',
          };
        }
      } else {
        await this.git(
          sourceRoot,
          [...identity, 'merge', '--no-ff', '-m', message, branch],
          60_000,
        );
      }
      return { ok: true, commit: (await this.git(sourceRoot, ['rev-parse', 'HEAD'])).trim() };
    } catch (err) {
      const conflictFiles = await this.unmerged(sourceRoot);
      const conflict = conflictFiles.length > 0 || isConflictText(gitText(err));
      if (conflict) {
        await this.restoreSource(sourceRoot, strategy);
        const files = conflictFiles.length ? conflictFiles : await this.unmerged(sourceRoot);
        return {
          ok: false,
          code: 'conflict',
          message:
            'Merge conflict. The source checkout was restored to the state it had before the merge.',
          conflictFiles: files.length ? files : conflictFiles,
        };
      }
      await this.restoreSource(sourceRoot, strategy);
      return {
        ok: false,
        code: 'failed',
        message:
          firstLine(gitText(err)) || 'git merge failed. The source checkout was left unchanged.',
      };
    }
  }

  /**
   * Point the agent branch at `commit` after a successful merge. Refuses a dirty worktree: this is
   * the only `reset --hard` Deskhaven runs, and only inside the agent worktree.
   */
  async syncToTarget(wt: WorktreeInfo, commit: string): Promise<void> {
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`Refusing to reset to ${commit}`);
    const porcelain = (await this.git(wt.path, ['status', '--porcelain'])).trim();
    if (porcelain)
      throw new Error('Refusing to reset a dirty worktree. Commit or discard its changes first.');
    await this.git(wt.path, ['reset', '--hard', commit], 60_000);
  }

  /** `git branch -d` (never `-D`). A branch that is not merged is left in place. */
  async deleteBranch(
    sourceRoot: string,
    branch: string,
  ): Promise<{ deleted: boolean; warning?: string }> {
    assertBranchName(branch);
    try {
      await this.git(sourceRoot, ['branch', '-d', branch], 20_000);
      return { deleted: true };
    } catch (err) {
      const warning =
        firstLine(gitText(err)) ||
        `Branch ${branch} is not fully merged, so it was kept. Deskhaven will not force-delete it.`;
      return { deleted: false, warning };
    }
  }

  /** Diff of `dir` against `base...HEAD`, or against HEAD when there is no base branch. */
  async reviewDiff(
    dir: string,
    baseBranch: string | null,
  ): Promise<{ diff: string; files: string[] }> {
    const range = baseBranch ? `${assertBranchName(baseBranch)}...HEAD` : null;
    const diffArgs = range ? ['diff', range] : ['diff', 'HEAD'];
    const nameArgs = range ? ['diff', '--name-only', range] : ['diff', '--name-only', 'HEAD'];
    let diff = '';
    let files: string[] = [];
    try {
      diff = await this.git(dir, diffArgs, 20_000, 10 * 1024 * 1024);
      files = (await this.git(dir, nameArgs, 20_000))
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (err) {
      diff = `Could not compute the diff (${firstLine(gitText(err))}). Read the files from the path.`;
    }
    return { diff, files };
  }

  private async mergeFiles(wt: WorktreeInfo, target: string): Promise<MergeFile[]> {
    const byPath = new Map<string, MergeFile>();
    try {
      const named = await this.git(wt.path, ['diff', '--name-status', `${target}...${wt.branch}`]);
      for (const line of named.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        const status = parts[0] ?? 'M';
        const path = parts[parts.length - 1];
        if (path) byPath.set(path, { path, status });
      }
    } catch {
      // The comparison itself is reported by status().
    }
    try {
      const porcelain = await this.git(wt.path, ['status', '--porcelain']);
      for (const line of porcelain.split('\n')) {
        if (!line.trim()) continue;
        const status = line.slice(0, 2).trim() || 'M';
        const path = line.slice(3).trim();
        if (path) byPath.set(path, { path, status: status === '??' ? 'untracked' : status });
      }
    } catch {
      // ignore
    }
    return [...byPath.values()];
  }

  private async unmerged(dir: string): Promise<string[]> {
    try {
      const out = await this.git(dir, ['diff', '--name-only', '--diff-filter=U']);
      return out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Put a conflicted or half-applied merge back. Never `reset --hard` and never checkout. */
  private async restoreSource(dir: string, strategy: MergeStrategy): Promise<void> {
    if (strategy === 'merge') {
      const mergeHead = await this.optionalGit(dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
      const unmerged = await this.unmerged(dir);
      if (mergeHead.trim() || unmerged.length) {
        try {
          await this.git(dir, ['merge', '--abort'], 30_000);
          return;
        } catch {
          await this.optionalGit(dir, ['reset', '--merge']);
          return;
        }
      }
    }
    const unmerged = await this.unmerged(dir);
    const staged = (await this.optionalGit(dir, ['diff', '--cached', '--name-only'])).trim();
    if (unmerged.length || staged) await this.optionalGit(dir, ['reset', '--merge']);
  }

  /** Identity overrides only when the repo (and the environment) have none, so commits do not hang. */
  private async identityArgs(cwd: string): Promise<string[]> {
    const name = (await this.optionalGit(cwd, ['config', '--get', 'user.name'])).trim();
    const email = (await this.optionalGit(cwd, ['config', '--get', 'user.email'])).trim();
    if (name && email) return [];
    return [
      '-c',
      'user.name=Deskhaven',
      '-c',
      'user.email=deskhaven@localhost',
      '-c',
      'commit.gpgsign=false',
    ];
  }

  private async git(
    cwd: string,
    args: string[],
    timeout = 20_000,
    maxBuffer = 1024 * 1024,
  ): Promise<string> {
    const { stdout } = await run('git', args, { cwd, timeout, maxBuffer });
    return stdout;
  }

  private async optionalGit(cwd: string, args: string[]): Promise<string> {
    try {
      return await this.git(cwd, args);
    } catch {
      return '';
    }
  }
}

function gitText(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
  }
  if (err && typeof err === 'object' && 'stdout' in err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim()) return stdout.trim();
  }
  return err instanceof Error ? err.message : String(err);
}

function isConflictText(text: string): boolean {
  return /CONFLICT|Automatic merge failed|fix conflicts/i.test(text);
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? ''
  );
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'agent'
  );
}
