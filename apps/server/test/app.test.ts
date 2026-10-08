import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl, scrubSecrets } from '../src/logger.js';
import { type Built, client, testApp } from './helpers.js';

let built: Built;
let app: { inject: ReturnType<typeof client> };

beforeAll(async () => {
  built = await testApp();
  app = { inject: client(built) };
});
afterAll(async () => {
  await built.app.close();
});

describe('server', () => {
  it('answers health and settings', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/health' })).json()).toMatchObject({
      ok: true,
    });
    const settings = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    expect(settings).toMatchObject({ authMode: 'API_KEY', concurrencyCap: 4 });
  });

  it('exposes auth status without secrets', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'API_KEY', bindHost: '127.0.0.1' });
    expect(res.body).not.toMatch(/sk-ant/);
  });

  it('creates agents from presets and validates the workdir', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'X', rolePresetId: 'engineer', workdir: '/definitely/not/here' },
    });
    expect(bad.statusCode).toBe(400);
    const good = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: { name: 'Ada', rolePresetId: 'reviewer', workdir: process.cwd() },
    });
    expect(good.statusCode).toBe(201);
    const agent = good.json();
    expect(agent).toMatchObject({
      name: 'Ada',
      rolePresetId: 'reviewer',
      tools: ['Read', 'Grep', 'Glob', 'LS'],
      permissionMode: 'default',
      status: 'stopped',
      deskId: 'desk-1',
    });
    const list = (await app.inject({ method: 'GET', url: '/api/agents' })).json();
    expect(list).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/agents/${agent.id}` });
    expect(del.statusCode).toBe(200);
  });

  it('serves rooms, presets, models, usage and permissions', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/rooms' })).json()[0]).toMatchObject({
      id: 'lobby',
    });
    expect((await app.inject({ method: 'GET', url: '/api/presets' })).json()).toHaveLength(6);
    expect((await app.inject({ method: 'GET', url: '/api/models' })).json().length).toBeGreaterThan(
      1,
    );
    expect((await app.inject({ method: 'GET', url: '/api/usage' })).json()).toMatchObject({
      killSwitch: false,
      running: 0,
    });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/permissions/nope/resolve',
          payload: { decision: 'allow' },
        })
      ).statusCode,
    ).toBe(404);
  });

  it('rejects bypassPermissions and unknown settings values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'X',
        rolePresetId: 'engineer',
        workdir: process.cwd(),
        permissionMode: 'bypassPermissions',
      },
    });
    expect(res.statusCode).toBe(400);
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      payload: { concurrencyCap: 99 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('parses boolean query flags strictly', async () => {
    const bad = await app.inject({ method: 'GET', url: '/api/events?asc=maybe' });
    expect(bad.statusCode).toBe(400);
    expect(
      (await app.inject({ method: 'GET', url: '/api/events?asc=false&limit=5' })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/events?asc=true&limit=5' })).statusCode,
    ).toBe(200);
  });

  it('scrubs key-like strings', () => {
    expect(scrubSecrets('key sk-ant-abcdefghijklmnop rest')).toBe('key sk-ant-[redacted] rest');
    expect(redactUrl('/api/session?token=abc&x=1')).toBe('/api/session?token=[redacted]&x=1');
  });
});
