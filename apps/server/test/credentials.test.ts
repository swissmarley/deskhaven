import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { externalCredentials } from '../src/auth/external.js';
import type { AuthProvider } from '../src/auth/types.js';
import { client, testApp } from './helpers.js';
import { apiKeyAuth, managerHarness, tick } from './manager-harness.js';

const init = (apiKeySource: string) => ({
  type: 'system',
  subtype: 'init',
  model: 'm',
  tools: [],
  permissionMode: 'default',
  apiKeySource,
  claude_code_version: '2',
  cwd: '/',
  mcp_servers: [],
  slash_commands: [],
  output_style: 'default',
  skills: [],
  plugins: [],
});

describe('credentials changed in Settings', () => {
  it('reach an idle agent on its next prompt (session restarted and resumed)', async () => {
    let auth: AuthProvider = apiKeyAuth('sk-ant-old-key-000');
    const h = managerHarness({ cap: 2, auth: () => auth });
    const a = h.hire('Ada');
    h.manager.sendPrompt(a.id, 'first', null);
    const first = h.sessions[0];
    if (!first) throw new Error('no session');
    expect(first.cfg.env.ANTHROPIC_API_KEY).toBe('sk-ant-old-key-000');
    first.emit(init('ANTHROPIC_API_KEY'));
    first.finishTurn();
    await tick();
    expect(h.manager.get(a.id)?.getStatus()).toBe('idle');

    auth = apiKeyAuth('sk-ant-new-key-111'); // what POST /api/auth/api-key → reloadAuth does
    h.manager.sendPrompt(a.id, 'second', null);
    await tick(80);
    expect(first.closed).toBe(true);
    const second = h.sessions[1];
    expect(second?.cfg.env.ANTHROPIC_API_KEY).toBe('sk-ant-new-key-111');
    expect(second?.cfg.resume).toBe('sess');
    expect(second?.prompts).toEqual(['second']);
    expect(first.prompts).toEqual(['first']);
    expect(h.manager.get(a.id)?.getStatus()).toBe('working');
  });

  it('keeps the process when credentials did not change', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Ada');
    h.manager.sendPrompt(a.id, 'first', null);
    h.sessions[0]?.finishTurn();
    await tick();
    h.manager.sendPrompt(a.id, 'second', null);
    await tick();
    expect(h.sessions).toHaveLength(1);
    expect(h.sessions[0]?.prompts).toEqual(['first', 'second']);
  });

  it('applies a key stored through the API before the response returns', async () => {
    const built = await testApp();
    try {
      const before = built.ctx.auth();
      const res = await client(built)({
        method: 'POST',
        url: '/api/auth/api-key',
        payload: { key: 'sk-ant-api-stored-key-123' },
      });
      expect(res.statusCode).toBe(200);
      expect(built.ctx.auth()).not.toBe(before);
      expect(built.ctx.auth().childEnv({}).ANTHROPIC_API_KEY).toBe('sk-ant-api-stored-key-123');
    } finally {
      await built.app.close();
    }
  });
});

describe('API key mode without a key', () => {
  it('refuses to spawn instead of falling back to other credentials', async () => {
    const h = managerHarness({ cap: 2, auth: () => noKey });
    const noKey = apiKeyAuth(null);
    const a = h.hire('Ada');
    const task = await h.tasks.create({ title: 't', prompt: 'p', assigneeAgentId: a.id });
    await tick();
    expect(h.sessions).toHaveLength(0);
    expect(h.agents.get(a.id)?.status).toBe('error');
    expect(h.agents.get(a.id)?.lastError).toMatch(/no API key/);
    expect(h.tasks.get(task.id)?.status).toBe('needs_input');
  });

  it('stops a session that reports credentials other than the API key', async () => {
    const h = managerHarness({ cap: 2 });
    const a = h.hire('Ada');
    h.manager.sendPrompt(a.id, 'first', null);
    h.sessions[0]?.emit(init('none'));
    await tick(80);
    const errors = h.events.list({ agentId: a.id, types: ['error'] });
    expect(errors[0]).toMatchObject({ kind: 'auth' });
    expect(String(errors[0] && 'message' in errors[0] ? errors[0].message : '')).toMatch(
      /apiKeySource="none"/,
    );
    expect(h.manager.get(a.id)?.isRunning()).toBe(false);
  });
});

describe('API key mode with external credentials (Bedrock, Vertex, apiKeyHelper, opt-in)', () => {
  const run = async (
    opts: { baseEnv?: Record<string, string>; workdir?: string },
    source: string,
  ) => {
    const h = managerHarness({ cap: 2, auth: () => noKey, ...opts });
    const noKey = apiKeyAuth(null);
    const a = h.hire('Ada');
    h.manager.sendPrompt(a.id, 'first', null);
    await tick();
    const started = h.sessions.length === 1;
    h.sessions[0]?.emit(init(source));
    await tick(80);
    return { started, running: h.manager.get(a.id)?.isRunning() ?? false, h, a };
  };

  for (const [name, env, source] of [
    ['Bedrock', { CLAUDE_CODE_USE_BEDROCK: '1' }, 'none'],
    ['Vertex', { CLAUDE_CODE_USE_VERTEX: 'true' }, 'none'],
    ['Foundry', { CLAUDE_CODE_USE_FOUNDRY: '1' }, 'none'],
    ['the explicit opt-in', { DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS: '1' }, 'oauth'],
  ] as const) {
    it(`starts without ANTHROPIC_API_KEY and keeps running with ${name}`, async () => {
      const r = await run({ baseEnv: { ...env } }, source);
      expect(r.started).toBe(true);
      expect(r.running).toBe(true);
      expect(r.h.events.list({ agentId: r.a.id, types: ['error'] })).toHaveLength(0);
    });
  }

  it('accepts a project apiKeyHelper, but not some other credential source', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-helper-')));
    fs.mkdirSync(path.join(dir, '.claude'));
    fs.writeFileSync(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify({ apiKeyHelper: '~/bin/get-key.sh' }),
    );
    const ok = await run({ workdir: dir }, 'apiKeyHelper');
    expect(ok.started).toBe(true);
    expect(ok.running).toBe(true);
    const fallback = await run({ workdir: dir }, 'none');
    expect(fallback.started).toBe(true);
    expect(fallback.running).toBe(false);
    const errors = fallback.h.events.list({ agentId: fallback.a.id, types: ['error'] });
    expect(JSON.stringify(errors)).toMatch(/apiKeyHelper in/);
  });

  it('treats "0" and "false" as not configured', () => {
    for (const v of ['0', 'false', '']) {
      expect(externalCredentials({ CLAUDE_CODE_USE_BEDROCK: v }, os.tmpdir()), v).toBeNull();
    }
    expect(
      externalCredentials({ DESKHAVEN_ALLOW_EXTERNAL_CREDENTIALS: '0' }, os.tmpdir()),
    ).toBeNull();
  });
});
