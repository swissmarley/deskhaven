import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface WorktreeInfo {
  path: string;
  branch: string;
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

  async create(repoDir: string, agentId: string, agentName: string): Promise<WorktreeInfo> {
    if (!(await this.isGitRepo(repoDir)))
      throw new Error(`${repoDir} is not a git repository; worktrees need git`);
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
    return { path: target, branch };
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    const { stdout } = await run('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      timeout: 20_000,
    });
    return stdout.trim().length > 0;
  }

  /** Clean, dirty, already gone, or unknown (with the reason) — never throws. */
  async state(repoDir: string, wt: WorktreeInfo): Promise<WorktreeState> {
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
  async remove(repoDir: string, wt: WorktreeInfo, force = false): Promise<void> {
    const state = await this.state(repoDir, wt);
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
