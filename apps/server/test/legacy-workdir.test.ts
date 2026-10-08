import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKDIR_ERROR_PREFIX } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { client, testApp } from './helpers.js';
import { managerHarness, tick } from './manager-harness.js';

/** Agents saved before PR #1's workdir rules may still carry workdir "/" in the database. */
describe('agents stored with a now-forbidden workdir', () => {
  it('are flagged at boot, refuse to start, and recover once the workdir is changed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-legacy-'));
    const env = { DESKHAVEN_DATA_DIR: dir, DESKHAVEN_DB: path.join(dir, 'deskhaven.db') };

    // A first launch stores an agent, then forces the legacy workdir past validation.
    const first = await testApp(env);
    const created = await client(first)({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Old', rolePresetId: 'engineer', workdir: process.cwd() },
    });
    const id = created.json().id as string;
    first.ctx.agents.patch(id, (a) => ({ ...a, workdir: '/' }));
    await first.app.close();

    // The next launch flags it.
    const second = await testApp(env);
    const req = client(second);
    try {
      const agent = (await req({ method: 'GET', url: `/api/agents/${id}` })).json();
      expect(agent.status).toBe('error');
      expect(agent.lastError).toMatch(new RegExp(`^${WORKDIR_ERROR_PREFIX}`));
      expect(agent.lastError).toMatch(/Refusing \/ as a working directory/);

      // Starting is refused without spawning anything.
      const start = await req({ method: 'POST', url: `/api/agents/${id}/start` });
      expect(start.json()).toEqual({ status: 'error' });
      expect(second.ctx.manager.get(id)?.isRunning()).toBe(false);

      // Picking a valid folder clears the error.
      const fixed = await req({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: { workdir: process.cwd() },
      });
      expect(fixed.statusCode).toBe(200);
      expect(fixed.json()).toMatchObject({ status: 'stopped', lastError: null });

      // And firing works either way.
      expect((await req({ method: 'DELETE', url: `/api/agents/${id}` })).statusCode).toBe(200);
    } finally {
      await second.app.close();
    }
  });

  it('are refused at start by the runtime too (no process spawned)', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Legacy');
    h.agents.patch(a.id, (x) => ({ ...x, workdir: '/' }));
    const task = h.tasks.create({ title: 't', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    expect(h.sessions).toHaveLength(0);
    const stored = h.agents.get(a.id);
    expect(stored?.status).toBe('error');
    expect(stored?.lastError?.startsWith(WORKDIR_ERROR_PREFIX)).toBe(true);
    expect(h.tasks.get(task.id)?.status).toBe('needs_input');
  });

  it('a worktree agent whose worktree folder vanished is flagged too', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Gone');
    h.agents.patch(a.id, (x) => ({
      ...x,
      worktree: { path: path.join(os.tmpdir(), 'deskhaven-no-such-worktree'), branch: 'b' },
    }));
    h.manager.sendPrompt(a.id, 'hi', null);
    await tick();
    expect(h.sessions).toHaveLength(0);
    expect(h.agents.get(a.id)?.lastError).toMatch(/does not exist/);
  });
});
