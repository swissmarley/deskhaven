import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentCwd } from '@deskhaven/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Built, client, testApp } from './helpers.js';

function tmpRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-repo-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  fs.mkdirSync(path.join(dir, 'src', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'lib', 'index.ts'), 'export {};\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  return dir;
}

let built: Built;
let req: ReturnType<typeof client>;

beforeAll(async () => {
  built = await testApp();
  req = client(built);
});
afterAll(async () => {
  await built.app.close();
});

const hire = (workdir: string, name = 'Grace') =>
  req({
    method: 'POST',
    url: '/api/agents',
    payload: { name, rolePresetId: 'engineer', workdir, useWorktree: true },
  });

describe('hiring with a git worktree', () => {
  it('creates a worktree under the data dir and records it on the agent', async () => {
    const repo = tmpRepo();
    const res = await hire(repo);
    expect(res.statusCode).toBe(201);
    const agent = res.json();
    expect(agent.workdir).toBe(repo);
    expect(agent.worktree.branch).toMatch(/^deskhaven\/grace-/);
    expect(agent.worktree.path.startsWith(built.ctx.worktrees.root())).toBe(true);
    expect(fs.existsSync(path.join(agent.worktree.path, 'a.txt'))).toBe(true);
    // The user's checkout is untouched and still on main.
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString();
    expect(branch.trim()).toBe('main');

    const del = await req({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(agent.worktree.path)).toBe(false);
  });

  it('refuses to fire an agent whose worktree has uncommitted work unless forced', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Linus')).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'wip.txt'), 'unsaved\n');
    const refused = await req({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/uncommitted/);
    expect(fs.existsSync(path.join(agent.worktree.path, 'wip.txt'))).toBe(true);
    expect((await req({ method: 'GET', url: `/api/agents/${agent.id}` })).statusCode).toBe(200);

    const forced = await req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=true` });
    expect(forced.statusCode).toBe(200);
    expect(fs.existsSync(agent.worktree.path)).toBe(false);
    expect((await req({ method: 'GET', url: `/api/agents/${agent.id}` })).statusCode).toBe(404);
  });

  it('warns when the source checkout has uncommitted changes', async () => {
    const repo = tmpRepo();
    fs.appendFileSync(path.join(repo, 'a.txt'), 'local edit\n');
    const agent = (await hire(repo, 'Barbara')).json();
    const notes = built.ctx.events.list({ agentId: agent.id, types: ['notification'] });
    expect(notes[0]).toMatchObject({ kind: 'worktree' });
    await req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=true` });
  });

  it('returns 400 and creates nothing when the workdir is not a git repository', async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-plain-'));
    const before = (await req({ method: 'GET', url: '/api/agents' })).json().length;
    const res = await hire(plain);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a git repository/);
    expect((await req({ method: 'GET', url: '/api/agents' })).json()).toHaveLength(before);
  });

  it('does not let a worktree agent switch repositories', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Ken')).json();
    const res = await req({
      method: 'PATCH',
      url: `/api/agents/${agent.id}`,
      payload: { workdir: tmpRepo() },
    });
    expect(res.statusCode).toBe(400);
    await req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=true` });
  });
});

describe('hiring a worktree agent for a subfolder', () => {
  it('keeps the subfolder: the agent works in <worktree>/<subpath>, not the whole checkout', async () => {
    const repo = tmpRepo();
    const res = await hire(path.join(repo, 'src', 'lib'), 'Sub');
    expect(res.statusCode).toBe(201);
    const agent = res.json();
    expect(agent.workdir).toBe(path.join(repo, 'src', 'lib'));
    expect(agent.worktree.subdir).toBe('src/lib');
    // The worktree is still of the whole repository (git operates on its root)...
    expect(fs.existsSync(path.join(agent.worktree.path, 'a.txt'))).toBe(true);
    // ...but the agent's directory is the same subfolder inside it.
    const cwd = agentCwd(agent);
    expect(cwd).toBe(`${agent.worktree.path}/src/lib`);
    expect(fs.existsSync(path.join(cwd, 'index.ts'))).toBe(true);
    const del = await req({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(agent.worktree.path)).toBe(false);
  });

  it('records no subdir when hired at the repository root', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Root')).json();
    expect(agent.worktree.subdir).toBeUndefined();
    expect(agentCwd(agent)).toBe(agent.worktree.path);
    await req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=true` });
  });
});

describe('firing a worktree agent whose source repository is gone', () => {
  afterEach(() => vi.restoreAllMocks());

  const scenario = async (name: string, lose: (repo: string) => string | null) => {
    const repo = tmpRepo();
    const agent = (await hire(repo, name)).json();
    expect(agent.worktree).toBeTruthy();
    const movedTo = lose(repo);
    const remove = vi.spyOn(built.ctx.manager, 'remove');
    return { agent, movedTo, remove };
  };

  for (const [label, lose] of [
    [
      'deleted',
      (repo: string) => {
        fs.rmSync(repo, { recursive: true, force: true });
        return null;
      },
    ],
    [
      'moved',
      (repo: string) => {
        const to = `${repo}-moved`;
        fs.renameSync(repo, to);
        return to;
      },
    ],
  ] as const) {
    it(`${label}: refuses without force (state unknown) and does not stop the agent`, async () => {
      const { agent, remove } = await scenario(`Gone ${label}`, lose);
      const res = await req({ method: 'DELETE', url: `/api/agents/${agent.id}` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/cannot check worktree .* moved or deleted.*force/);
      expect(res.json().error).not.toMatch(/ENOENT/);
      expect(remove).not.toHaveBeenCalled();
      expect((await req({ method: 'GET', url: `/api/agents/${agent.id}` })).statusCode).toBe(200);
      expect(fs.existsSync(agent.worktree.path)).toBe(true);
      await req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=true` });
    });

    it(`${label}: force deletes the worktree folder and the agent`, async () => {
      const { agent, movedTo } = await scenario(`Force ${label}`, lose);
      const res = await req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=true` });
      expect(res.statusCode, res.body).toBe(200);
      expect(fs.existsSync(agent.worktree.path)).toBe(false);
      expect((await req({ method: 'GET', url: `/api/agents/${agent.id}` })).statusCode).toBe(404);
      if (movedTo) {
        // The moved repository's stale entry goes away with a prune.
        execFileSync('git', ['worktree', 'prune'], { cwd: movedTo });
        const list = execFileSync('git', ['worktree', 'list'], { cwd: movedTo }).toString();
        expect(list).not.toContain(agent.worktree.path);
      }
    });
  }

  it('fires without force when the worktree folder itself is already gone', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Vanished')).json();
    fs.rmSync(agent.worktree.path, { recursive: true, force: true });
    const res = await req({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(res.statusCode).toBe(200);
    const list = execFileSync('git', ['worktree', 'list'], { cwd: repo }).toString();
    expect(list).not.toContain(agent.worktree.path);
  });

  it('WorktreeService.state reports unknown instead of clean when git cannot run', async () => {
    const repo = tmpRepo();
    const wt = await built.ctx.worktrees.create(repo, 'abcdef999999', 'State');
    expect(await built.ctx.worktrees.state(repo, wt)).toEqual({ kind: 'clean' });
    fs.rmSync(repo, { recursive: true, force: true });
    const state = await built.ctx.worktrees.state(repo, wt);
    expect(state.kind).toBe('unknown');
    await expect(built.ctx.worktrees.remove(repo, wt)).rejects.toThrow(/cannot check/);
    await built.ctx.worktrees.remove(repo, wt, true);
    expect(fs.existsSync(wt.path)).toBe(false);
  });
});
