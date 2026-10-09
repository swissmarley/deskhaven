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
  constructor(private readonly dataDir: string) {}

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
    return { path: target, branch, ...(subdir ? { subdir } : {}) };
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
