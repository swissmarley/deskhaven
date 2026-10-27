import { UNKNOWN_MODEL_CODE } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import { client, testApp } from './helpers.js';

const hire = {
  name: 'Test',
  rolePresetId: 'engineer',
  workdir: process.cwd(),
};

describe('agent model validation', () => {
  it('rejects empty, whitespace, and unknown models on create', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      for (const model of ['', '   ', 'pippo']) {
        const res = await req({
          method: 'POST',
          url: '/api/agents',
          payload: { ...hire, model },
        });
        expect(res.statusCode, model).toBe(400);
      }
    } finally {
      await built.app.close();
    }
  });

  it('rejects unknown models on patch with a code', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const created = await req({ method: 'POST', url: '/api/agents', payload: hire });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      const res = await req({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: { model: 'pippo' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_request' });
    } finally {
      await built.app.close();
    }
  });

  it('hires a manager from settings.managerModel without a preset.model', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      await req({
        method: 'PATCH',
        url: '/api/settings',
        payload: { managerModel: 'claude-haiku-5-5' },
      });
      const res = await req({
        method: 'POST',
        url: '/api/agents',
        payload: { ...hire, name: 'Boss', rolePresetId: 'manager' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().model).toBe('claude-haiku-5-5');
    } finally {
      await built.app.close();
    }
  });

  it('keeps a saved model that is no longer in the catalog', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const created = await req({
        method: 'POST',
        url: '/api/agents',
        payload: { ...hire, model: 'claude-haiku-4-5-20251001' },
      });
      expect(created.statusCode).toBe(201);
      const id = created.json().id;
      const got = await req({ method: 'GET', url: `/api/agents/${id}` });
      expect(got.json().model).toBe('claude-haiku-4-5-20251001');

      const reset = await req({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: { model: null },
      });
      expect(reset.statusCode).toBe(200);
      expect(reset.json().model).toBe('claude-sonnet-5-5');
    } finally {
      await built.app.close();
    }
  });

  it('resets model via empty string on patch', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const created = await req({
        method: 'POST',
        url: '/api/agents',
        payload: { ...hire, model: 'claude-haiku-5-5' },
      });
      const id = created.json().id;
      const res = await req({
        method: 'PATCH',
        url: `/api/agents/${id}`,
        payload: { model: '' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().model).toBe('claude-sonnet-5-5');
    } finally {
      await built.app.close();
    }
  });
});

describe('settings model errors', () => {
  it('returns unknown_model code for bad settings', async () => {
    const built = await testApp();
    try {
      const req = client(built);
      const res = await req({
        method: 'PATCH',
        url: '/api/settings',
        payload: { defaultModel: 'pippo' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'Unknown model: pippo',
        code: UNKNOWN_MODEL_CODE,
      });
    } finally {
      await built.app.close();
    }
  });
});
