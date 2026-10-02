import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { scrubSecrets } from '../src/logger.js';

let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp(loadConfig({ AGENTHOTEL_DATA_DIR: '/tmp/agenthotel-test' })));
});
afterAll(async () => {
  await app.close();
});

describe('server skeleton', () => {
  it('answers health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
  it('scrubs key-like strings', () => {
    expect(scrubSecrets('key sk-ant-abcdefghijklmnop rest')).toBe('key sk-ant-[redacted] rest');
  });
});
