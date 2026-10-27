import { MAX_PERMISSION_TIMEOUT_MS, UNKNOWN_MODEL_CODE } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '../src/agent/permission-broker.js';
import { openDb } from '../src/db/client.js';
import { settings as settingsTable } from '../src/db/schema.js';
import { SettingsService } from '../src/settings/service.js';
import { client, testApp } from './helpers.js';

describe('auth mode switch', () => {
  it('returns 400 and leaves settings unchanged when the new mode cannot bind here', async () => {
    const built = await testApp({
      DESKHAVEN_HOST: '0.0.0.0',
      DESKHAVEN_ALLOW_REMOTE: '1',
      DESKHAVEN_ALLOWED_HOSTS: 'box.lan',
    });
    try {
      const req = client(built);
      const before = (await req({ method: 'GET', url: '/api/settings' })).json();
      expect(before.authMode).toBe('API_KEY');
      const authBefore = built.ctx.auth();
      const res = await req({
        method: 'PATCH',
        url: '/api/settings',
        payload: { authMode: 'CLAUDE_SUBSCRIPTION', concurrencyCap: 1 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/requires binding to 127\.0\.0\.1/);
      expect((await req({ method: 'GET', url: '/api/settings' })).json()).toEqual(before);
      expect(built.ctx.auth()).toBe(authBefore);
      // Nothing reached the database either (a fresh service reads the stored row).
      expect(new SettingsService(built.ctx.db).get().authMode).toBe('API_KEY');
    } finally {
      await built.app.close();
    }
  });
});

describe('model settings', () => {
  it('rejects an unknown defaultModel or managerModel with 400', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const before = (await req({ method: 'GET', url: '/api/settings' })).json();
      for (const payload of [{ defaultModel: 'pippo' }, { managerModel: 'pippo' }]) {
        const res = await req({ method: 'PATCH', url: '/api/settings', payload });
        expect(res.statusCode, JSON.stringify(payload)).toBe(400);
        expect(res.json()).toMatchObject({
          error: 'Unknown model: pippo',
          code: UNKNOWN_MODEL_CODE,
        });
      }
      expect((await req({ method: 'GET', url: '/api/settings' })).json()).toEqual(before);
    } finally {
      await built.app.close();
    }
  });

  it('applies defaultModel only to agents created afterwards', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const first = await req({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Ada', rolePresetId: 'engineer', workdir: process.cwd() },
      });
      expect(first.statusCode).toBe(201);
      expect(first.json().model).toBe('claude-sonnet-5-5');

      const patched = await req({
        method: 'PATCH',
        url: '/api/settings',
        payload: { defaultModel: 'claude-haiku-5-5' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().defaultModel).toBe('claude-haiku-5-5');
      // A fresh service reads the stored row, the same path a restart takes.
      expect(new SettingsService(built.ctx.db).get().defaultModel).toBe('claude-haiku-5-5');

      const existing = await req({ method: 'GET', url: `/api/agents/${first.json().id}` });
      expect(existing.json().model).toBe('claude-sonnet-5-5');

      const second = await req({
        method: 'POST',
        url: '/api/agents',
        payload: { name: 'Bea', rolePresetId: 'engineer', workdir: process.cwd() },
      });
      expect(second.statusCode).toBe(201);
      expect(second.json().model).toBe('claude-haiku-5-5');
    } finally {
      await built.app.close();
    }
  });
});

describe('permission timeout', () => {
  it('rejects values above 24 h (Node timers overflow above 2^31-1 ms)', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      for (const v of [2 ** 31, 2 ** 31 - 1, MAX_PERMISSION_TIMEOUT_MS + 1]) {
        const res = await req({
          method: 'PATCH',
          url: '/api/settings',
          payload: { permissionTimeoutMs: v },
        });
        expect(res.statusCode, String(v)).toBe(400);
      }
      const ok = await req({
        method: 'PATCH',
        url: '/api/settings',
        payload: { permissionTimeoutMs: MAX_PERMISSION_TIMEOUT_MS },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().permissionTimeoutMs).toBe(MAX_PERMISSION_TIMEOUT_MS);
    } finally {
      await built.app.close();
    }
  });

  it('clamps an oversized stored value instead of resetting every setting', () => {
    const { db } = openDb(':memory:');
    const svc = new SettingsService(db);
    svc.update({ concurrencyCap: 3 });
    const raw = JSON.stringify({ ...svc.get(), permissionTimeoutMs: 2 ** 32 });
    db.update(settingsTable).set({ value: raw }).run();
    const fresh = new SettingsService(db).get();
    expect(fresh.permissionTimeoutMs).toBe(MAX_PERMISSION_TIMEOUT_MS);
    expect(fresh.concurrencyCap).toBe(3);
  });

  it('never arms an overflowing timer in the broker', async () => {
    const { db } = openDb(':memory:');
    const broker = new PermissionBroker({ db, timeoutMs: () => 2 ** 31 + 5, onUpsert: () => {} });
    let settled = false;
    const pending = broker.ask({
      agentId: 'a',
      taskId: null,
      toolUseId: 't',
      tool: 'Bash',
      input: {},
    });
    void pending.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(broker.listPending()).toHaveLength(1);
    broker.resolve(broker.listPending()[0]?.id ?? '', 'deny');
    await pending;
  });
});
