import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'agenthotel-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  ({ app } = await buildApp(
    loadConfig({
      AGENTHOTEL_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'agenthotel-data-')),
      AGENTHOTEL_DB: ':memory:',
      AGENTHOTEL_KEYSTORE: 'memory',
      AGENTHOTEL_PROBE_ON_BOOT: '0',
      AGENTHOTEL_WEB_DIST: dist,
    }),
  ));
});
afterAll(async () => {
  await app.close();
});

describe('static web dist', () => {
  it('serves the SPA shell for app routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/room/editor?tab=1' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('shell');
  });

  it('returns 404 for missing files instead of the shell (model loaders need a clean miss)', async () => {
    for (const url of ['/models/characters/missing.glb', '/assets/x.js?v=1', '/api/nope']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'not_found' });
    }
  });
});
