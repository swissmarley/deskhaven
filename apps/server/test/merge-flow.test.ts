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

async function mergePayload(taskId: string, extra: Record<string, unknown> = {}) {
  const preview = await req({ method: 'GET', url: `/api/tasks/${taskId}/merge-preview` });
  expect(preview.statusCode).toBe(200);
  const p = preview.json() as {
    branchSha: string;
    previewTree: string;
    hookFiles?: string[];
  };
  return {
    expectedBranchSha: p.branchSha,
    consentedHookFiles: p.hookFiles ?? [],
    previewTree: p.previewTree,
    ...extra,
  };
}

describe('merge and review over HTTP', { timeout: 20_000 }, () => {
  it('squash-merges, then merges a second change without a conflict', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Ada', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'from ada\n');
    const id = await reviewTask(agent.id);
    const merged = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
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
      payload: await mergePayload(id, { strategy: 'squash' }),
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
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
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
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
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
    const denied = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe('agent_busy');

    const plainDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-plain-')));
    const plain = (await hire(plainDir, 'NoTree', false)).json();
    const plainTask = await reviewTask(plain.id, 'No branch');
    const missing = await req({
      method: 'POST',
      url: `/api/tasks/${plainTask}/merge`,
      payload: {
        expectedBranchSha: 'abc1234567890',
        consentedHookFiles: [],
        previewTree: '0000000000000000000000000000000000000000',
      },
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
      payload: await mergePayload(id, { strategy: 'merge' }),
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

  it('returns 409 worktree_moved and does not mark the task merged', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Moved', true)).json();
    git(agent.worktree.path, 'checkout', '--detach', '-q');
    fs.writeFileSync(path.join(agent.worktree.path, 'lost.txt'), 'keep me\n');
    const sourceBefore = git(repo, 'rev-parse', 'HEAD').trim();
    const id = await reviewTask(agent.id, 'Moved');
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('worktree_moved');
    const task = (await req({ method: 'GET', url: '/api/tasks' })).json() as {
      id: string;
      status: string;
      merge?: { status?: string } | null;
    }[];
    const saved = task.find((t) => t.id === id);
    expect(saved?.status).toBe('review');
    expect(saved?.merge?.status).not.toBe('merged');
    expect(fs.readFileSync(path.join(agent.worktree.path, 'lost.txt'), 'utf8')).toBe('keep me\n');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(sourceBefore);
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('rejects a nudge and holds a new assignment until the merge finishes', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Lock', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'lock\n');
    const id = await reviewTask(agent.id, 'Lock merge');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = built.ctx.worktrees.withSourceLock(repo, () => gate);
    let settled = false;
    const pending = req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    }).then((res) => {
      settled = true;
      return res;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(settled).toBe(false);
    const nudged = await req({
      method: 'POST',
      url: `/api/tasks/${id}/nudge`,
      payload: { text: 'while merging' },
    });
    expect(nudged.statusCode).toBe(409);
    expect(nudged.json().error).toBe('agent_busy');
    prompts.length = 0;
    const other = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'During merge', prompt: 'wait for the merge', assigneeAgentId: agent.id },
    });
    expect(other.statusCode).toBe(201);
    const otherId = other.json().id as string;
    expect(other.json().status).toBe('assigned');
    expect(prompts.some((p) => p.taskId === otherId)).toBe(false);
    release();
    await held;
    const merged = await pending;
    expect(merged.statusCode).toBe(200);
    const until = Date.now() + 2000;
    while (!prompts.some((p) => p.taskId === otherId) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(prompts.some((p) => p.taskId === otherId)).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8')).toBe('lock\n');
  });

  it('snapshots the engineer at dispatch, not when an unassigned review is created', async () => {
    const repo = tmpRepo();
    const engineer = (await hire(repo, 'Ned', true)).json();
    const reviewerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-rev-')));
    const reviewer = (await hire(reviewerDir, 'Nell', false)).json();
    const busy = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Still writing', prompt: 'not done', assigneeAgentId: engineer.id },
    });
    expect(
      (
        await req({
          method: 'PATCH',
          url: `/api/tasks/${busy.json().id}`,
          payload: { status: 'in_progress' },
        })
      ).statusCode,
    ).toBe(200);
    fs.writeFileSync(path.join(engineer.worktree.path, 'early.txt'), 'early\n');
    const created = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review Ned',
        prompt: 'read the branch',
        reviewOfAgentId: engineer.id,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().reviewTarget).toMatchObject({
      agentId: engineer.id,
      path: engineer.worktree.path,
      branch: engineer.worktree.branch,
    });
    expect(created.json().status).toBe('backlog');
    expect(git(engineer.worktree.path, 'status', '--porcelain')).toContain('early.txt');
    fs.writeFileSync(path.join(engineer.worktree.path, 'later.txt'), 'later\n');
    expect(
      (
        await req({
          method: 'PATCH',
          url: `/api/tasks/${busy.json().id}`,
          payload: { status: 'done' },
        })
      ).statusCode,
    ).toBe(200);
    prompts.length = 0;
    const assigned = await req({
      method: 'POST',
      url: `/api/tasks/${created.json().id}/assign`,
      payload: { agentId: reviewer.id },
    });
    expect(assigned.statusCode).toBe(200);
    const sent = prompts.find((p) => p.taskId === created.json().id);
    expect(sent?.text).toContain('early.txt');
    expect(sent?.text).toContain('later.txt');
    expect(sent?.text).toContain('+later');
    expect(git(engineer.worktree.path, 'status', '--porcelain')).toBe('');
  });

  it('forgets done and removed review paths when refreshing read dirs', async () => {
    const repo = tmpRepo();
    const engineer = (await hire(repo, 'Old', true)).json();
    const reviewerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-rev-')));
    const reviewer = (await hire(reviewerDir, 'Pat', false)).json();
    fs.writeFileSync(path.join(engineer.worktree.path, 'old.txt'), 'old\n');
    const done = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review Old',
        prompt: 'old review',
        assigneeAgentId: reviewer.id,
        reviewOfAgentId: engineer.id,
      },
    });
    expect(done.statusCode).toBe(201);
    expect(
      (
        await req({
          method: 'PATCH',
          url: `/api/tasks/${done.json().id}`,
          payload: { status: 'done' },
        })
      ).statusCode,
    ).toBe(200);
    const repo2 = tmpRepo();
    const engineer2 = (await hire(repo2, 'New', true)).json();
    fs.writeFileSync(path.join(engineer2.worktree.path, 'new.txt'), 'new\n');
    readDirs.length = 0;
    const live = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review New',
        prompt: 'new review',
        assigneeAgentId: reviewer.id,
        reviewOfAgentId: engineer2.id,
      },
    });
    expect(live.statusCode).toBe(201);
    const watched = readDirs.filter((r) => r.agentId === reviewer.id).at(-1);
    expect(watched?.dirs).toContain(engineer2.worktree.path);
    expect(watched?.dirs ?? []).not.toContain(engineer.worktree.path);
    const gone = engineer2.worktree.path as string;
    expect(
      (await req({ method: 'DELETE', url: `/api/agents/${engineer2.id}?force=1` })).statusCode,
    ).toBe(200);
    readDirs.length = 0;
    const nudged = await req({
      method: 'POST',
      url: `/api/tasks/${live.json().id}/nudge`,
      payload: { text: 'look again' },
    });
    expect(nudged.statusCode).toBe(200);
    const after = readDirs.filter((r) => r.agentId === reviewer.id).at(-1);
    expect(after?.dirs ?? []).not.toContain(gone);
    expect(fs.existsSync(gone)).toBe(false);
  });

  it('returns 409 wrong_branch over HTTP when the checkout is detached', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Detached', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'x\n');
    git(repo, 'checkout', '--detach', '-q');
    const before = snapshot(repo);
    const id = await reviewTask(agent.id, 'Detached');
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('wrong_branch');
    expect(snapshot(repo)).toBe(before);
  });

  it('returns 409 nothing_to_merge without marking the task merged', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Quiet', true)).json();
    const id = await reviewTask(agent.id, 'Quiet');
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('nothing_to_merge');
    const saved = (
      (await req({ method: 'GET', url: '/api/tasks' })).json() as {
        id: string;
        status: string;
        merge?: { status?: string } | null;
      }[]
    ).find((t) => t.id === id);
    expect(saved?.status).toBe('review');
    expect(saved?.merge?.status).not.toBe('merged');
  });

  it('serializes two merges of the same checkout', async () => {
    const repo = tmpRepo();
    const ada = (await hire(repo, 'Ada2', true)).json();
    const bea = (await hire(repo, 'Bea2', true)).json();
    fs.writeFileSync(path.join(ada.worktree.path, 'ada.txt'), 'ada\n');
    fs.writeFileSync(path.join(bea.worktree.path, 'bea.txt'), 'bea\n');
    const ida = await reviewTask(ada.id, 'Ada2');
    const idb = await reviewTask(bea.id, 'Bea2');
    const [ra, rb] = await Promise.all([
      req({ method: 'POST', url: `/api/tasks/${ida}/merge`, payload: await mergePayload(ida) }),
      req({ method: 'POST', url: `/api/tasks/${idb}/merge`, payload: await mergePayload(idb) }),
    ]);
    expect(ra.statusCode).toBe(200);
    expect(rb.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(repo, 'ada.txt'), 'utf8')).toBe('ada\n');
    expect(fs.readFileSync(path.join(repo, 'bea.txt'), 'utf8')).toBe('bea\n');
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('returns 409 failed with the untracked filename', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Clash', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'collision.txt'), 'agent\n');
    fs.writeFileSync(path.join(repo, 'collision.txt'), 'local\n');
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const id = await reviewTask(agent.id, 'Clash');
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('failed');
    expect(res.json().message).toContain('collision.txt');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(fs.readFileSync(path.join(repo, 'collision.txt'), 'utf8')).toBe('local\n');
  });

  it('rejects a review assigned to the same agent', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Self', true)).json();
    const res = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review myself',
        prompt: 'no',
        assigneeAgentId: agent.id,
        reviewOfAgentId: agent.id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('self_review');
  });

  it('merges a subdirectory hire into the repository root', async () => {
    const repo = tmpRepo();
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'lib.txt'), 'v1\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'lib');
    const agent = (await hire(sub, 'Sub', true)).json();
    expect(agent.worktree.subdir).toBe('pkg');
    expect(agent.worktree.sourceRoot).toBe(fs.realpathSync(repo));
    fs.writeFileSync(path.join(agent.worktree.path, 'pkg', 'lib.txt'), 'v2\n');
    const id = await reviewTask(agent.id, 'Sub');
    const res = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(repo, 'pkg', 'lib.txt'), 'utf8')).toBe('v2\n');
  });

  it('does not leave a review task assigned when the engineer is busy on create', async () => {
    const repo = tmpRepo();
    const engineer = (await hire(repo, 'BusyCreate', true)).json();
    const reviewerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-rev-')));
    const reviewer = (await hire(reviewerDir, 'RevCreate', false)).json();
    const busy = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Still busy', prompt: 'wip', assigneeAgentId: engineer.id },
    });
    expect(
      (
        await req({
          method: 'PATCH',
          url: `/api/tasks/${busy.json().id}`,
          payload: { status: 'in_progress' },
        })
      ).statusCode,
    ).toBe(200);
    prompts.length = 0;
    const created = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review while busy',
        prompt: 'read it',
        assigneeAgentId: reviewer.id,
        reviewOfAgentId: engineer.id,
      },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json().error).toBe('agent_busy');
    const tasks = (await req({ method: 'GET', url: '/api/tasks' })).json() as {
      title: string;
      status: string;
      assigneeAgentId: string | null;
    }[];
    const stuck = tasks.find((t) => t.title === 'Review while busy');
    expect(stuck).toBeUndefined();
    expect(prompts.some((p) => p.agentId === reviewer.id)).toBe(false);
  });

  it('rolls back assign when the engineer is busy at dispatch', async () => {
    const repo = tmpRepo();
    const engineer = (await hire(repo, 'BusyAssign', true)).json();
    const reviewerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-rev-')));
    const reviewer = (await hire(reviewerDir, 'RevAssign', false)).json();
    const created = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: {
        title: 'Review later',
        prompt: 'read it',
        reviewOfAgentId: engineer.id,
      },
    });
    expect(created.statusCode).toBe(201);
    const reviewId = created.json().id as string;
    const busy = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Block', prompt: 'wip', assigneeAgentId: engineer.id },
    });
    expect(
      (
        await req({
          method: 'PATCH',
          url: `/api/tasks/${busy.json().id}`,
          payload: { status: 'in_progress' },
        })
      ).statusCode,
    ).toBe(200);
    prompts.length = 0;
    const assigned = await req({
      method: 'POST',
      url: `/api/tasks/${reviewId}/assign`,
      payload: { agentId: reviewer.id },
    });
    expect(assigned.statusCode).toBe(409);
    expect(assigned.json().error).toBe('agent_busy');
    const listed = (await req({ method: 'GET', url: '/api/tasks' })).json() as {
      id: string;
      status: string;
      assigneeAgentId: string | null;
    }[];
    const again = listed.find((t) => t.id === reviewId);
    expect(again).toMatchObject({ status: 'backlog', assigneeAgentId: null });
    expect(prompts.some((p) => p.taskId === reviewId)).toBe(false);
  });

  it('PATCH with assignee and title keeps both fields', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'PatchBoth', true)).json();
    const created = await req({
      method: 'POST',
      url: '/api/tasks',
      payload: { title: 'Old title', prompt: 'original prompt', assigneeAgentId: agent.id },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    const other = (await hire(repo, 'Other', true)).json();
    const patched = await req({
      method: 'PATCH',
      url: `/api/tasks/${id}`,
      payload: {
        assigneeAgentId: other.id,
        title: 'New title',
        prompt: 'updated prompt',
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      title: 'New title',
      prompt: 'updated prompt',
      assigneeAgentId: other.id,
      status: 'assigned',
    });
  });

  it('returns 409 hooks_changed when the branch touches the hooks directory', async () => {
    const repo = tmpRepo();
    git(repo, 'config', 'core.hooksPath', '.husky');
    const agent = (await hire(repo, 'Hooks', true)).json();
    const hooks = path.join(agent.worktree.path, '.husky');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'post-commit'), '#!/bin/sh\necho hooked\n');
    fs.chmodSync(path.join(hooks, 'post-commit'), 0o755);
    git(agent.worktree.path, 'add', '-A');
    git(agent.worktree.path, 'commit', '-q', '-m', 'evil hook');
    const id = await reviewTask(agent.id, 'Hook merge');
    const preview = await req({ method: 'GET', url: `/api/tasks/${id}/merge-preview` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().hookFiles?.length).toBeGreaterThan(0);
    expect(preview.json().hooksWarning).toMatch(/hook/i);
    const head = git(repo, 'rev-parse', 'HEAD').trim();
    const denied = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id),
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error).toBe('hooks_changed');
    expect(git(repo, 'rev-parse', 'HEAD').trim()).toBe(head);
    const allowed = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id, { allowHookChanges: true }),
    });
    expect(allowed.statusCode).toBe(200);
  });

  it('returns 409 merge_preview_stale when worktree content changes after preview', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'TreeStale', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'v1\n');
    const id = await reviewTask(agent.id, 'Tree bind');
    const body = await mergePayload(id);
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'v2\n');
    const stale = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: body });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('merge_preview_stale');
  });

  it('returns 400 when previewTree is omitted', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'NoTree', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'x\n');
    const id = await reviewTask(agent.id, 'No preview tree');
    const partial = await mergePayload(id);
    delete (partial as { previewTree?: string }).previewTree;
    const res = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: partial });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 merge_preview_stale after the branch moves', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Stale', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'x\n');
    const id = await reviewTask(agent.id, 'Stale merge');
    const body = await mergePayload(id);
    git(agent.worktree.path, 'add', 'b.txt');
    git(agent.worktree.path, 'commit', '-q', '-m', 'after preview');
    const stale = await req({ method: 'POST', url: `/api/tasks/${id}/merge`, payload: body });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('merge_preview_stale');
  });

  it('does not run worktree hooks during Deskhaven git commands', async () => {
    const repo = tmpRepo();
    git(repo, 'config', 'core.hooksPath', '.githooks');
    const hooks = path.join(repo, '.githooks');
    fs.mkdirSync(hooks, { recursive: true });
    const marker = path.join(repo, 'wt-hook-fired.txt');
    fs.writeFileSync(
      path.join(hooks, 'post-index-change'),
      `#!/bin/sh\necho fired > '${marker}'\n`,
    );
    fs.chmodSync(path.join(hooks, 'post-index-change'), 0o755);
    const agent = (await hire(repo, 'WtHooks', true)).json();
    fs.writeFileSync(path.join(agent.worktree.path, 'b.txt'), 'touch index\n');
    const id = await reviewTask(agent.id, 'No wt hooks');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const merged = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id, { skipHooks: true }),
    });
    expect(merged.statusCode).toBe(200);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('lists untracked hook files individually in the preview', async () => {
    const repo = tmpRepo();
    git(repo, 'config', 'core.hooksPath', '.githooks');
    const agent = (await hire(repo, 'UntrackedHook', true)).json();
    const dir = path.join(agent.worktree.path, '.githooks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(dir, 'pre-commit'), 0o755);
    const id = await reviewTask(agent.id, 'Untracked');
    const preview = await req({ method: 'GET', url: `/api/tasks/${id}/merge-preview` });
    expect(preview.json().hookFiles).toContain('.githooks/pre-commit');
  });

  it('lists the files inside a new untracked folder, not the folder', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'NewFolder', true)).json();
    const dir = path.join(agent.worktree.path, '.husky');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pre-commit'), '#!/bin/sh\nexit 0\n');
    fs.mkdirSync(path.join(agent.worktree.path, 'docs', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(agent.worktree.path, 'docs', 'deep', 'note.md'), 'hi\n');
    const id = await reviewTask(agent.id, 'New folder');
    const preview = await req({ method: 'GET', url: `/api/tasks/${id}/merge-preview` });
    const paths = (preview.json().files as { path: string }[]).map((f) => f.path).sort();
    expect(paths).toEqual(['.husky/pre-commit', 'docs/deep/note.md']);
  });

  it('counts ahead consistently, and a sibling merge of the same agent leaves nothing to merge', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Shared', true)).json();
    const wt = agent.worktree.path as string;
    for (const n of [1, 2, 3]) {
      fs.writeFileSync(path.join(wt, `f${n}.txt`), `${n}\n`);
      git(wt, 'add', '-A');
      git(wt, 'commit', '-q', '--no-verify', '-m', `c${n}`);
    }
    const first = await reviewTask(agent.id, 'First');
    const a = (await req({ method: 'GET', url: `/api/tasks/${first}/merge-preview` })).json();
    const b = (await req({ method: 'GET', url: `/api/tasks/${first}/merge-preview` })).json();
    expect(a).toMatchObject({ ahead: 3, behind: 0, canMerge: true });
    expect(b).toMatchObject({ ahead: a.ahead, behind: a.behind, branchSha: a.branchSha });
    // The worktree (and its branch) belongs to the agent, not to one task: merging another task of
    // the same agent integrates every commit and realigns the branch onto the merge commit.
    const second = await reviewTask(agent.id, 'Second');
    const merged = await req({
      method: 'POST',
      url: `/api/tasks/${second}/merge`,
      payload: await mergePayload(second),
    });
    expect(merged.statusCode).toBe(200);
    const after = (await req({ method: 'GET', url: `/api/tasks/${first}/merge-preview` })).json();
    expect(after).toMatchObject({
      ahead: 0,
      behind: 0,
      dirty: false,
      files: [],
      canMerge: false,
      reason: 'Nothing to merge',
    });
  });

  it('lists uncommitted hook runner configs in the preview', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'UncommittedRunner', true)).json();
    fs.writeFileSync(
      path.join(agent.worktree.path, 'lefthook.toml'),
      '[pre-commit]\ncommands = {}\n',
    );
    const id = await reviewTask(agent.id, 'Runner preview');
    const preview = await req({ method: 'GET', url: `/api/tasks/${id}/merge-preview` });
    expect(preview.json().runnerFiles).toContain('lefthook.toml');
  });

  it('merges with skipHooks without running hook scripts', async () => {
    const repo = tmpRepo();
    git(repo, 'config', 'core.hooksPath', '.husky');
    const agent = (await hire(repo, 'SkipHooks', true)).json();
    const hooks = path.join(repo, '.husky');
    fs.mkdirSync(hooks, { recursive: true });
    const marker = path.join(repo, 'hook-ran.txt');
    fs.writeFileSync(path.join(hooks, 'post-commit'), `#!/bin/sh\necho ran > '${marker}'\n`);
    fs.chmodSync(path.join(hooks, 'post-commit'), 0o755);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'hooks');
    const wtHooks = path.join(agent.worktree.path, '.husky');
    fs.mkdirSync(wtHooks, { recursive: true });
    fs.writeFileSync(path.join(wtHooks, 'post-merge'), '#!/bin/sh\necho merge\n');
    fs.chmodSync(path.join(wtHooks, 'post-merge'), 0o755);
    git(agent.worktree.path, 'add', '-A');
    execFileSync(
      'git',
      ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '--no-verify', '-m', 'wt hook'],
      { cwd: agent.worktree.path },
    );
    const id = await reviewTask(agent.id, 'Skip hook merge');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    const merged = await req({
      method: 'POST',
      url: `/api/tasks/${id}/merge`,
      payload: await mergePayload(id, { skipHooks: true }),
    });
    expect(merged.statusCode).toBe(200);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('waits for an in-progress merge before removing the worktree', async () => {
    const repo = tmpRepo();
    const agent = (await hire(repo, 'Fire', true)).json();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = built.ctx.worktrees.withSourceLock(repo, () => gate);
    let finished = false;
    const pending = req({ method: 'DELETE', url: `/api/agents/${agent.id}?force=1` }).then(
      (res) => {
        finished = true;
        return res;
      },
    );
    await new Promise((r) => setTimeout(r, 150));
    expect(finished).toBe(false);
    expect(fs.existsSync(agent.worktree.path)).toBe(true);
    release();
    await held;
    const res = await pending;
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(agent.worktree.path)).toBe(false);
  });
});
