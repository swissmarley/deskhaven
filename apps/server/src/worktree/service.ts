import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isInside } from '../agent/diff-tracker.js';
import {
  type HookMergeCheck,
  hookFileSetsEqual,
  hookFilesFromDiffNames,
  hookRunnerFilesInDiff,
  splitNameOnlyZ,
} from './hook-detect.js';

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
  /**
   * Repository root recorded at hire. Optional so older rows still load. Merge uses this instead of
   * walking `workdir`, which a later edit of that path would otherwise redirect.
   */
  sourceRoot?: string;
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
      code:
        | 'source_dirty'
        | 'wrong_branch'
        | 'conflict'
        | 'failed'
        | 'invalid_branch'
        | 'nothing_to_merge'
        | 'hooks_changed'
        | 'hooks_verify_failed';
      message: string;
      conflictFiles?: string[];
      hookFiles?: string[];
    };

export interface MergeIntoOptions {
  allowHookChanges?: boolean;
  /** When true, the source merge commit skips hooks (`core.hooksPath=/dev/null`, `--no-verify`). */
  skipHooks?: boolean;
  /** Hook paths the user consented to; must match the branch hook set at merge time. */
  consentedHookFiles?: string[];
}

export type { HookMergeCheck };

/**
 * Branch names that may be passed to git. Stricter than `check-ref-format` (which accepts `foo;rm`):
 * one path segment sequence, no shell metacharacters, no leading dash.
 */
const BRANCH_NAME =
  /^(?![-.])(?!.*\.\.)(?!.*@\{)(?!.*\/\/)(?!.*[~^:?*[\\\s;|&$`'"<>])(?!.*\.lock$)(?!.*\/$)(?!.*\.$)[\p{L}\p{N}._/-]+$/u;

/** The worktree HEAD is not `wt.branch`, so a commit or hard reset would land on the wrong line. */
export class WorktreeMovedError extends Error {
  readonly code = 'worktree_moved' as const;
  constructor(head: string, branch: string) {
    super(
      head
        ? `worktree_moved: the worktree is on ${head}, not ${branch}. Deskhaven will not commit or reset it.`
        : `worktree_moved: the worktree is in detached HEAD, not on ${branch}. Deskhaven will not commit or reset it.`,
    );
    this.name = 'WorktreeMovedError';
  }
}

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
      sourceRoot: repoDir,
      ...(subdir ? { subdir } : {}),
      ...(base ? { baseBranch: base.branch, baseCommit: base.commit } : {}),
    };
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    return (await this.git(worktreePath, ['status', '--porcelain'])).trim().length > 0;
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

  /**
   * Where merges and branch deletion run. Prefer the root stored at hire; fall back to walking up
   * from the agent's workdir when an older row has no `sourceRoot`.
   */
  resolvedSource(workdir: string, wt: WorktreeInfo): string {
    if (wt.sourceRoot && isDir(wt.sourceRoot)) return wt.sourceRoot;
    return this.sourceRoot(workdir, wt);
  }

  /** Clean, dirty, already gone, or unknown (with the reason) — never throws. */
  async state(repoDir: string, wt: WorktreeInfo): Promise<WorktreeState> {
    repoDir = this.resolvedSource(repoDir, wt);
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
    const repoDir = this.resolvedSource(workdir, wt);
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

  /**
   * The branch checked out in `dir`, or null for a detached HEAD.
   * A name git accepts but this service rejects (for example `feature.lock`) throws `invalid_branch`
   * instead of being reported as detached.
   */
  async currentBranch(dir: string): Promise<{ branch: string; commit: string } | null> {
    let branch = '';
    try {
      branch = (await this.git(dir, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim();
    } catch {
      return null;
    }
    if (!branch) return null;
    try {
      assertBranchName(branch);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`invalid_branch: ${detail}`);
    }
    const commit = (await this.git(dir, ['rev-parse', 'HEAD'])).trim();
    if (!commit) return null;
    return { branch, commit };
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
        await this.git(wt.path, [
          'rev-list',
          '--left-right',
          '--count',
          `${target}...${wt.branch}`,
          '--',
        ])
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

  /**
   * Stage and commit everything in the worktree. No-op when the tree is clean. Never touches the
   * source checkout. Refuses when HEAD is not `wt.branch`. Skips hooks and signing: a relative
   * `core.hooksPath` would otherwise run scripts the agent can edit, outside the Bash approval path.
   * `--no-verify` alone does not skip `post-commit`, so `core.hooksPath` is cleared as well.
   */
  async commitAll(
    wt: WorktreeInfo,
    message: string,
  ): Promise<{ committed: boolean; commit?: string }> {
    assertBranchName(wt.branch);
    await this.assertOnBranch(wt);
    if (!(await this.isDirty(wt.path))) return { committed: false };
    await this.git(wt.path, ['add', '-A'], 60_000);
    if (!(await this.isDirty(wt.path))) return { committed: false };
    const identity = await this.identityArgs(wt.path, { sign: false });
    await this.git(wt.path, [...identity, 'commit', '--no-verify', '-m', message], 60_000);
    return { committed: true, commit: (await this.git(wt.path, ['rev-parse', 'HEAD'])).trim() };
  }

  async headSha(dir: string): Promise<string> {
    return (await this.git(dir, ['rev-parse', 'HEAD'])).trim();
  }

  async headTree(dir: string): Promise<string> {
    return (await this.git(dir, ['rev-parse', 'HEAD^{tree}'])).trim();
  }

  /**
   * Tree that `commitAll` would write: `read-tree HEAD`, `add -A`, `write-tree`, with hooks disabled.
   * Binds merge consent to exact worktree content, not only paths.
   */
  async previewTree(worktreePath: string): Promise<string> {
    const indexPath = path.join(os.tmpdir(), `deskhaven-idx-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    const runIndex = async (args: string[]) => {
      const { stdout } = await run('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: worktreePath,
        timeout: 60_000,
        env,
      });
      return stdout;
    };
    try {
      await runIndex(['read-tree', 'HEAD']);
      await runIndex(['add', '-A']);
      return (await runIndex(['write-tree'])).trim();
    } finally {
      for (const p of [indexPath, `${indexPath}.lock`]) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Paths under the source hooks directory that differ on `branch` from `target`, plus hook-runner
   * config files in the same merge range. Fails closed when the diff cannot be computed.
   */
  async hookFilesInMerge(
    sourceRoot: string,
    branch: string,
    target: string,
  ): Promise<HookMergeCheck & { runnerFiles?: string[] }> {
    assertBranchName(branch);
    assertBranchName(target);
    const branchSha = await this.resolveBranchCommit(sourceRoot, branch);
    return this.hookFilesInMergeAt(sourceRoot, target, branchSha);
  }

  /**
   * Hook paths that would be touched by a merge at `branchSha`, including uncommitted hook paths in
   * the agent worktree. Used for merge preview consent binding.
   */
  async hookConsentSnapshot(
    sourceRoot: string,
    worktreePath: string,
    target: string,
    branchSha: string,
  ): Promise<HookMergeCheck & { runnerFiles?: string[] }> {
    const { prefixes, ignoreCase } = await this.hookDirMeta(sourceRoot);
    try {
      const names = await this.mergeRangeNames(sourceRoot, target, branchSha);
      const fromRange = hookFilesFromDiffNames(names, prefixes, ignoreCase);
      const porcelainPaths = await this.uncommittedPaths(worktreePath);
      const fromWorktree = hookFilesFromDiffNames(porcelainPaths, prefixes, ignoreCase);
      const files = [...new Set([...fromRange, ...fromWorktree])].sort();
      const runnersFromRange = hookRunnerFilesInDiff(names, ignoreCase);
      const runnersFromWt = hookRunnerFilesInDiff(porcelainPaths, ignoreCase);
      return {
        ok: true,
        files,
        runnerFiles: [...new Set([...runnersFromRange, ...runnersFromWt])].sort(),
      };
    } catch {
      return {
        ok: false,
        code: 'verify_failed',
        message: 'Could not verify whether this merge changes git hook scripts.',
      };
    }
  }

  private async hookFilesInMergeAt(
    sourceRoot: string,
    target: string,
    branchSha: string,
  ): Promise<HookMergeCheck & { runnerFiles?: string[] }> {
    const { prefixes, ignoreCase } = await this.hookDirMeta(sourceRoot);
    try {
      const names = await this.mergeRangeNames(sourceRoot, target, branchSha);
      return {
        ok: true,
        files: hookFilesFromDiffNames(names, prefixes, ignoreCase),
        runnerFiles: hookRunnerFilesInDiff(names, ignoreCase),
      };
    } catch {
      return {
        ok: false,
        code: 'verify_failed',
        message: 'Could not verify whether this merge changes git hook scripts.',
      };
    }
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
    options: MergeIntoOptions = {},
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
    let current = '';
    try {
      current = (await this.git(sourceRoot, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim();
    } catch {
      return {
        ok: false,
        code: 'wrong_branch',
        message:
          'The source checkout is in detached HEAD. Deskhaven will not switch branches. Check out the target branch yourself, then merge again.',
      };
    }
    if (!current) {
      return {
        ok: false,
        code: 'wrong_branch',
        message:
          'The source checkout is in detached HEAD. Deskhaven will not switch branches. Check out the target branch yourself, then merge again.',
      };
    }
    try {
      assertBranchName(current);
    } catch (err) {
      return {
        ok: false,
        code: 'invalid_branch',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (current !== target) {
      return {
        ok: false,
        code: 'wrong_branch',
        message: `The source checkout is on ${current}, not ${target}. Deskhaven will not switch branches.`,
      };
    }
    const branchSha = await this.resolveBranchCommit(sourceRoot, branch);
    const hookCheck = await this.hookFilesInMergeAt(sourceRoot, target, branchSha);
    if (!hookCheck.ok) {
      return {
        ok: false,
        code: 'hooks_verify_failed',
        message: hookCheck.message,
      };
    }
    const hookFiles = hookCheck.files;
    const consented = options.consentedHookFiles ?? [];
    if (!hookFileSetsEqual(hookFiles, consented)) {
      return {
        ok: false,
        code: 'hooks_changed',
        message:
          'The hook scripts in this merge do not match what you consented to in the preview. Refresh the preview and merge again.',
        hookFiles,
      };
    }
    if (hookFiles.length && !options.allowHookChanges && !options.skipHooks) {
      return {
        ok: false,
        code: 'hooks_changed',
        message:
          'This merge changes git hook scripts in the source checkout. Deskhaven refused to run them. Merge again with allowHookChanges if you trust the branch.',
        hookFiles,
      };
    }
    const identity = await this.identityArgs(sourceRoot);
    const verifyOff = options.skipHooks ? ['--no-verify'] : ([] as string[]);
    const hooksOn = !options.skipHooks;
    try {
      if (strategy === 'squash') {
        await this.git(sourceRoot, ['merge', '--squash', '--', branchSha], 60_000);
        const staged = (await this.git(sourceRoot, ['diff', '--cached', '--name-only'])).trim();
        const headNow = (await this.git(sourceRoot, ['rev-parse', 'HEAD'])).trim();
        if (!staged && headNow === headBefore) {
          await this.restoreSource(sourceRoot, 'squash');
          return {
            ok: false,
            code: 'nothing_to_merge',
            message: 'Nothing to merge. The branch is already contained in the target.',
          };
        }
        try {
          await this.git(
            sourceRoot,
            [...identity, 'commit', ...verifyOff, '-m', message],
            60_000,
            1024 * 1024,
            { allowRepoHooks: hooksOn },
          );
        } catch (err) {
          await this.restoreSource(sourceRoot, 'squash');
          return {
            ok: false,
            code: 'failed',
            message:
              clip(gitText(err)) || 'The squash commit failed. The source checkout was restored.',
          };
        }
      } else {
        await this.git(
          sourceRoot,
          [...identity, 'merge', '--no-ff', ...verifyOff, '-m', message, '--', branchSha],
          60_000,
          1024 * 1024,
          { allowRepoHooks: hooksOn },
        );
        const headNow = (await this.git(sourceRoot, ['rev-parse', 'HEAD'])).trim();
        if (headNow === headBefore) {
          return {
            ok: false,
            code: 'nothing_to_merge',
            message: 'Nothing to merge. The branch is already up to date.',
          };
        }
      }
      return { ok: true, commit: (await this.git(sourceRoot, ['rev-parse', 'HEAD'])).trim() };
    } catch (err) {
      const text = gitText(err);
      const conflictFiles = await this.unmerged(sourceRoot);
      const conflict = conflictFiles.length > 0 || isConflictText(text);
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
        message: clip(text) || 'git merge failed. The source checkout was left unchanged.',
      };
    }
  }

  /**
   * Point the agent branch at `commit` after a successful merge. Refuses a dirty worktree: this is
   * the only `reset --hard` Deskhaven runs, and only inside the agent worktree.
   */
  async syncToTarget(wt: WorktreeInfo, commit: string): Promise<void> {
    if (!/^[0-9a-f]{7,64}$/i.test(commit)) throw new Error(`Refusing to reset to ${commit}`);
    assertBranchName(wt.branch);
    await this.assertOnBranch(wt);
    const porcelain = (await this.git(wt.path, ['status', '--porcelain'])).trim();
    if (porcelain)
      throw new Error('Refusing to reset a dirty worktree. Commit or discard its changes first.');
    await this.git(wt.path, ['reset', '--hard', commit], 60_000);
  }

  /**
   * `git branch -d` (never `-D`). When `target` is given, a branch that is not an ancestor of it is
   * kept without attempting deletion. After a squash and realign, the branch tip is that commit, so
   * the ancestor check still passes.
   */
  async deleteBranch(
    sourceRoot: string,
    branch: string,
    target?: string,
  ): Promise<{ deleted: boolean; warning?: string }> {
    assertBranchName(branch);
    if (target) {
      assertBranchName(target);
      try {
        await this.git(sourceRoot, ['merge-base', '--is-ancestor', '--', branch, target], 20_000);
      } catch {
        return {
          deleted: false,
          warning: `Branch ${branch} is not fully merged into ${target}, so it was kept. Deskhaven will not force-delete it.`,
        };
      }
    }
    try {
      await this.git(sourceRoot, ['branch', '-d', '--', branch], 20_000);
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
    const diffArgs = range ? ['diff', range, '--'] : ['diff', 'HEAD', '--'];
    const nameArgs = range
      ? ['diff', '--name-only', range, '--']
      : ['diff', '--name-only', 'HEAD', '--'];
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
      const named = await this.git(wt.path, [
        'diff',
        '-z',
        '--name-status',
        `${target}...${wt.branch}`,
        '--',
      ]);
      for (const file of parseNameStatusZ(named)) byPath.set(file.path, file);
    } catch {
      // The comparison itself is reported by status().
    }
    try {
      const porcelain = await this.git(wt.path, ['status', '--porcelain=v1', '-z']);
      for (const file of parsePorcelainZ(porcelain)) byPath.set(file.path, file);
    } catch {
      // ignore
    }
    return [...byPath.values()];
  }

  private async resolveBranchCommit(sourceRoot: string, branch: string): Promise<string> {
    return (await this.git(sourceRoot, ['rev-parse', '--verify', `${branch}^{commit}`])).trim();
  }

  private async mergeRangeNames(
    sourceRoot: string,
    target: string,
    branchSha: string,
  ): Promise<string[]> {
    const raw = await this.git(sourceRoot, [
      '-c',
      'core.quotePath=false',
      'diff',
      '--name-only',
      '-z',
      '--no-renames',
      `${target}...${branchSha}`,
    ]);
    const parts = raw.split('\0');
    if (parts.at(-1) === '') parts.pop();
    return parts.filter(Boolean);
  }

  private async hookDirMeta(
    sourceRoot: string,
  ): Promise<{ prefixes: string[]; ignoreCase: boolean }> {
    const ignoreCase = (await this.readConfig(sourceRoot, 'core.ignorecase')) === 'true';
    const out = new Set<string>();
    const configured = await this.readConfig(sourceRoot, 'core.hooksPath');
    const addPrefix = (hooksPath: string) => {
      if (!hooksPath) return;
      const abs = path.isAbsolute(hooksPath) ? hooksPath : path.resolve(sourceRoot, hooksPath);
      const rel = path.relative(sourceRoot, abs).split(path.sep).join('/');
      if (rel && !rel.startsWith('..')) {
        out.add(rel);
        try {
          const real = fs.realpathSync(abs);
          const realRel = path.relative(sourceRoot, real).split(path.sep).join('/');
          if (realRel && !realRel.startsWith('..')) out.add(realRel);
        } catch {
          // hooks dir may not exist yet
        }
      }
    };
    if (configured) addPrefix(configured);
    else {
      const hooksPath = (
        await this.optionalGit(sourceRoot, ['rev-parse', '--git-path', 'hooks'])
      ).trim();
      addPrefix(hooksPath);
    }
    out.add('.husky');
    const symlinkPrefixes = await this.hookSymlinkPrefixes(sourceRoot, [...out]);
    for (const p of symlinkPrefixes) out.add(p);
    return { prefixes: [...out], ignoreCase };
  }

  /** Resolve git symlink hook entries (mode 120000) to in-repo path prefixes. */
  private async hookSymlinkPrefixes(sourceRoot: string, hookPrefixes: string[]): Promise<string[]> {
    const out = new Set<string>();
    for (const prefix of hookPrefixes) {
      let listed = '';
      try {
        listed = await this.git(sourceRoot, ['ls-tree', '-z', '-r', 'HEAD', '--', prefix]);
      } catch {
        continue;
      }
      for (const entry of splitNameOnlyZ(listed)) {
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const meta = entry.slice(0, tab);
        const filePath = entry.slice(tab + 1);
        if (!meta.startsWith('120000 ')) continue;
        const resolved = await this.resolveSymlinkChain(sourceRoot, filePath);
        if (!resolved || resolved.startsWith('../')) continue;
        out.add(resolved);
        if (await this.isTreeAtHead(sourceRoot, resolved)) {
          const parent = path.posix.dirname(resolved);
          if (parent && parent !== '.') out.add(parent);
        }
      }
    }
    return [...out];
  }

  private async resolveSymlinkChain(sourceRoot: string, startPath: string): Promise<string | null> {
    let current = startPath.replace(/\\/g, '/');
    for (let depth = 0; depth < 8; depth++) {
      const entry = await this.lsTreeEntry(sourceRoot, current);
      if (!entry) return null;
      if (!entry.mode.startsWith('120000')) {
        return path.posix.normalize(current);
      }
      let target = '';
      try {
        target = (await this.git(sourceRoot, ['show', `HEAD:${current}`])).trim();
      } catch {
        return null;
      }
      const dir = path.posix.dirname(current);
      current = path.posix.normalize(dir === '.' ? target : path.posix.join(dir, target));
      if (current.startsWith('../')) return null;
    }
    return null;
  }

  private async lsTreeEntry(
    sourceRoot: string,
    filePath: string,
  ): Promise<{ mode: string } | null> {
    try {
      const out = await this.git(sourceRoot, ['ls-tree', 'HEAD', '--', filePath]);
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find(Boolean);
      if (!line) return null;
      const mode = line.split(/\s+/)[0] ?? '';
      return { mode };
    } catch {
      return null;
    }
  }

  private async isTreeAtHead(sourceRoot: string, filePath: string): Promise<boolean> {
    try {
      const kind = (await this.git(sourceRoot, ['cat-file', '-t', `HEAD:${filePath}`])).trim();
      return kind === 'tree';
    } catch {
      return false;
    }
  }

  private async uncommittedPaths(worktreePath: string): Promise<string[]> {
    try {
      const porcelain = await this.git(worktreePath, [
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]);
      return parsePorcelainZ(porcelain).map((f) => f.path);
    } catch {
      return [];
    }
  }

  private async assertOnBranch(wt: WorktreeInfo): Promise<void> {
    let head = '';
    try {
      head = (await this.git(wt.path, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim();
    } catch {
      throw new WorktreeMovedError('', wt.branch);
    }
    if (head !== wt.branch) throw new WorktreeMovedError(head, wt.branch);
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

  /**
   * Identity overrides only when the repo (and the environment) have none, so commits do not hang.
   * `sign: false` always disables gpgsign (worktree commits). Source merges keep the user's signing
   * setup when an identity is already configured.
   */
  private async identityArgs(cwd: string, opts?: { sign?: boolean }): Promise<string[]> {
    const name = (await this.optionalGit(cwd, ['config', '--get', 'user.name'])).trim();
    const email = (await this.optionalGit(cwd, ['config', '--get', 'user.email'])).trim();
    const args: string[] = [];
    if (!name || !email) {
      args.push('-c', 'user.name=Deskhaven', '-c', 'user.email=deskhaven@localhost');
    }
    if (opts?.sign === false || !name || !email) args.push('-c', 'commit.gpgsign=false');
    return args;
  }

  /** Read repository config without `core.hooksPath=/dev/null`, which would mask the real hooksPath. */
  private async readConfig(cwd: string, key: string): Promise<string> {
    try {
      const { stdout } = await run('git', ['config', '--get', key], { cwd, timeout: 20_000 });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async git(
    cwd: string,
    args: string[],
    timeout = 20_000,
    maxBuffer = 1024 * 1024,
    opts?: { allowRepoHooks?: boolean },
  ): Promise<string> {
    const prefix = opts?.allowRepoHooks ? [] : ['-c', 'core.hooksPath=/dev/null'];
    const { stdout } = await run('git', [...prefix, ...args], { cwd, timeout, maxBuffer });
    return stdout;
  }

  private async optionalGit(
    cwd: string,
    args: string[],
    opts?: { allowRepoHooks?: boolean },
  ): Promise<string> {
    try {
      return await this.git(cwd, args, 20_000, 1024 * 1024, opts);
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

function clip(text: string, max = 2000): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max);
}

/** `git diff -z --name-status`: `R100\\0old\\0new\\0`, otherwise `M\\0path\\0`. */
function parseNameStatusZ(raw: string): MergeFile[] {
  const fields = raw.split('\0');
  if (fields.at(-1) === '') fields.pop();
  const out: MergeFile[] = [];
  let i = 0;
  while (i < fields.length) {
    const status = fields[i++] ?? '';
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = fields[i + 1];
      i += 1;
      if (next === undefined) break;
      const path = next;
      i += 1;
      if (path) out.push({ path, status });
      continue;
    }
    const path = fields[i++] ?? '';
    if (path) out.push({ path, status });
  }
  return out;
}

/** `git status --porcelain=v1 -z`: `XY path\\0`, rename is `XY new\\0old\\0`. */
function parsePorcelainZ(raw: string): MergeFile[] {
  const out: MergeFile[] = [];
  let i = 0;
  while (i + 3 < raw.length) {
    const xy = raw.slice(i, i + 2);
    i += 3;
    const end = raw.indexOf('\0', i);
    if (end < 0) break;
    const path = raw.slice(i, end);
    i = end + 1;
    if (xy.includes('R') || xy.includes('C')) {
      const oldEnd = raw.indexOf('\0', i);
      if (oldEnd < 0) break;
      i = oldEnd + 1;
    }
    const status = xy.trim() || 'M';
    if (path) out.push({ path, status: status === '??' ? 'untracked' : status });
  }
  return out;
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
