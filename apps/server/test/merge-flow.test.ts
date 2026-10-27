import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Built, client, testApp } from './helpers.js';

function tmpRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-merge-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 't');
  git('config', 'user.email', 't@t');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

function snapshot(dir: string): string {
  return [
    git(dir, 'rev-parse', 'HEAD'),
    git(dir, 'status', '--porcelain'),
    git(dir, 'diff', 'HEAD'),
    git(dir, 'diff', '--cached'),
  ].join('\n');
}

let built: Built;
let req: ReturnType<typeof client>;
const prompts: { agentId: string; text: string; taskId: string | null }[] = [];
const readDirs: { agentId: string; dirs: string[] }[] = [];

beforeAll(async () => {
  built = await testApp();
  req = client(built);
  const manager = built.ctx.manager;
  const orig = manager.setExtraReadDirs.bind(manager);
  manager.setExtraReadDirs = (agentId: string, dirs: string[]) => {
    readDirs.push({ agentId, dirs: [...dirs] });
    orig(agentId, dirs);
  };
  manager.sendPrompt = (agentId: string, text: string, taskId: string | null) => {
    prompts.push({ agentId, text, taskId });
  };
});

afterAll(async () => {
  await built.app.close();
});

const hire = (workdir: string, name: string, useWorktree: boolean) =>
  req({
    method: 'POST',
    url: '/api/agents',
    payload: { name, rolePresetId: 'engineer', workdir, useWorktree },
  });

async function reviewTask(agentId: string, title = 'Ship it'): Promise<string> {
  const created = await req({
    method: 'POST',
    url: '/api/tasks',
    payload: { title, prompt: 'make the change', assigneeAgentId: agentId },
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  const moved = await req({
    method: 'PATCH',
    url: `/api/tasks/${id}`,
    payload: { status: 'review' },
  });
  expect(moved.statusCode).toBe(200);
  return id;
}

describe('merge and review over HTTP', { timeout: 20_000 }, () => {
  it('squash-merges, then merges a second change without a conflict', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Ada', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'from ada\n');
    const id = await reviewTask(agent.id);
    const merged = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: {} });
    expect(merged.statusCode).toBe(200);
    const task = merged.json().task;
    expect(task.merge).toMatchObject({
      status: 'merged',
      strategy: 'squash',
      targetBranch: 'main',
    });
    expect(task.merge.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(task.status).toBe('done');
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('from ada\n');
    expect(git(agent.worktree.path, 'rev-parse', 'HEAD').trim()).toBe(task.merge.commit);
    expect(git(repo, 'branch', '--show-current').trim()).toBe('main');

    fs.writeFileSync(path.join(agent.worktree.path, 'c.txt'), 'second\n');
    const again = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: { strategy: 'squash' },
    });
    expect(again.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(repo, 'c.txt'), 'utf8')).toBe('second\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('returns 409 source_dirty and does not change the checkout', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Bea', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'bea\n');
    fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty\n');
    const before = snapshot(repo);
    const id = await reviewTask(agent.id, 'Bea task');
    const res = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('source_dirty');
    expect(snapshot(repo)).toBe(before);
  });

  it('aborts a conflict, leaves the source identical, and can ask the agent to resolve', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Cara', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'a.txt'), 'from the agent\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from the user\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'user'], { cwd: repo });
    const before = snapshot(repo);
    const id = await reviewTask(agent.id, 'Conflict');
    const res = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('conflict');
    expect(res.json().conflictFiles).toContain('a.txt');
    expect(snapshot(repo)).toBe(before);
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8')).toBe('from the user\n');
    prompts.length = 0;
    const ask = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge/resolve-with-agent`,
    });
    expect(ask.statusCode).toBe(200);
    expect(prompts.at(-1)?.text).toMatch(/a\.txt/);
    expect(prompts.at(-1)?.text).toMatch(/your worktree/);
    expect(prompts.at(-1)?.agentId).toBe(agent.id);
  });

  it('returns 409 agent_busy and 400 no_worktree', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Dee', true)).json();
    const busy = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Busy', prompt: 'still going', assigneeAgentId: agent.id },
    });
    const busyId = busy.json().id as string;
    expect(
      (
        await req({
          method: 'PATCH',
          url: `/api/tasks/${busyId}`,
          payload: { status: 'in_progress' },
        })
      ).statusCode,
    ).toBe(200);
    const id = await reviewTask(agent.id, 'Also Dee');
    const denied = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: {} });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe('agent_busy');

    const plainDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-plain-')));
    const plain = (await hire(plainDir, 'NoTree', false)).json();
    const plainTask = await reviewTask(plain.id, 'No branch');
    const missing = await req({
      method: 'POST',
      url: `/api/tasks/${plainTask}/merge`,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toBe('no_worktree');
  });

  it('deletes a merged branch on fire and keeps one that is not merged', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Eve', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'eve\n');
    const id = await reviewTask(agent.id, 'Eve');
    const merged = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: { strategy: 'merge' },
    });
    expect(merged.statusCode).toBe(200);
    expect(merged.json().task.merge.strategy).toBe('merge');
    const fired = await req({
      method: 'DELETE',
      url: `/api/agents/${agent.id}?deleteBranch=1`,
    });
    expect(fired.statusCode).toBe(200);
    expect(fired.json()).toMatchObject({ ok: true, branchDeleted: true });
    expect(git(repo, 'branch', '--list', agent.worktree.branch).trim()).toBe('');

    const other = tmpRepo();
    const kept = (await hire(other, 'Fay', true)).json();
    execFileSync('git', ['config', 'user.name', 't'], { cwd: kept.worktree.path });
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: kept.worktree.path });
    fs.writeFileSync(path.join(kept.worktree.path, 'b.txt'), 'fay\n');
    execFileSync('git', ['add', '-A'], { cwd: kept.worktree.path });
    execFileSync('git', ['commit', '-q', '-m', 'fay'], { cwd: kept.worktree.path });
    const still = await req({
      method: 'DELETE',
      url: `/api/agents/${kept.id}?deleteBranch=1`,
    });
    expect(still.statusCode).toBe(200);
    expect(still.json().branchDeleted).toBe(false);
    expect(still.json().warning).toBeTruthy();
    expect(git(other, 'branch', '--list', kept.worktree.branch)).toContain(kept.worktree.branch);
  });

  it('persists reviewTarget and sends the reviewer the engineer diff', async () => {
    const repo = tmpRepo();
    const engineer = (await hire(repo, 'Grace', true)).json();
    const reviewerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-rev-')));
    const reviewer = (await hire(reviewerDir, 'Ivy', false)).json();
    fs.writeFileSync(path.join(engineer.worktree.path, 'notes.txt'), 'please review\n');
    prompts.length = 0;
    readDirs.length = 0;
    const created = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review Grace',
        prompt: 'check the branch',
        assigneeAgentId: reviewer.id,
        reviewOfAgentId: engineer.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const task = created.json();
    expect(task.reviewTarget).toMatchObject({
      agentId: engineer.id,
      agentName: 'Grace',
      path: engineer.worktree.path,
      branch: engineer.worktree.branch,
      baseBranch: 'main',
    });
    const listed = await req({ method: 'GET', url: '/api/tasks' });
    const again = (listed.json() as { id: string; reviewTarget?: { path: string } }[]).find(
      (t) => t.id === task.id,
    );
    expect(again?.reviewTarget?.path).toBe(engineer.worktree.path);
    const sent = prompts.find((p) => p.agentId === reviewer.id);
    expect(sent?.text).toContain(engineer.worktree.path);
    expect(sent?.text).toContain(engineer.worktree.branch);
    expect(sent?.text).toContain('notes.txt');
    expect(sent?.text).toContain('+please review');
    const watched = readDirs.some(
      (r) => r.agentId === reviewer.id && r.dirs.includes(engineer.worktree.path),
    );
    expect(watched).toBe(true);

    const huge = 'h'.repeat(70_000);
    fs.writeFileSync(path.join(engineer.worktree.path, 'big.txt'), huge);
    prompts.length = 0;
    const long = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review the long diff',
        prompt: 'check the big file',
        assigneeAgentId: reviewer.id,
        reviewOfAgentId: engineer.id,
      },
    });
    expect(long.statusCode).toBe(201);
    const text = prompts.find((p) => p.taskId === long.json().id)?.text ?? '';
    expect(text).toContain('[diff truncated, read the files from the path]');
    expect(text).toContain('The diff above is truncated');
    expect(text.length).toBeLessThan(huge.length);
  });
});
