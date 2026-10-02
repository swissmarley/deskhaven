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
    const branch = `agenthotel/${slug}`;
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

  /** Removes the worktree (keeps the branch). Refuses when dirty unless `force`. */
  async remove(repoDir: string, wt: WorktreeInfo, force = false): Promise<void> {
    if (!fs.existsSync(wt.path)) {
      await run('git', ['worktree', 'prune'], { cwd: repoDir, timeout: 20_000 }).catch(
        () => undefined,
      );
      return;
    }
    if (!force && (await this.isDirty(wt.path))) {
      throw new Error(`worktree ${wt.path} has uncommitted changes; commit them or force removal`);
    }
    await run('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wt.path], {
      cwd: repoDir,
      timeout: 60_000,
    });
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
