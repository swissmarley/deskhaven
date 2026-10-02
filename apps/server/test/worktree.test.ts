import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { slugify, WorktreeService } from '../src/worktree/service.js';

function tmpRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthotel-wt-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

describe('WorktreeService', () => {
  it('creates, detects dirt, refuses dirty removal, then force-removes', async () => {
    const repo = tmpRepo();
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthotel-data-'));
    const svc = new WorktreeService(data);
    expect(await svc.isGitRepo(repo)).toBe(true);
    expect(await svc.isGitRepo(os.tmpdir())).toBe(false);
    const wt = await svc.create(repo, 'abcdef123456', 'Ada Lovelace');
    expect(wt.branch).toBe('agenthotel/ada-lovelace-abcdef');
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
