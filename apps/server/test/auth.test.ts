import { describe, expect, it } from 'vitest';
import { ApiKeyAuthProvider, MemoryKeyStore } from '../src/auth/api-key.js';
import { AUTH_ENV_VARS, hasAuthEnv, scrubAuthEnv } from '../src/auth/env.js';
import { createAuthProvider } from '../src/auth/index.js';
import { ClaudeSubscriptionAuthProvider } from '../src/auth/subscription.js';
import { defaultSettings } from '../src/settings/service.js';

const dirty = {
  PATH: '/usr/bin',
  HOME: '/Users/x',
  ANTHROPIC_API_KEY: 'sk-ant-secret',
  ANTHROPIC_AUTH_TOKEN: 'bearer-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
  OTHER: '1',
};

describe('scrubAuthEnv', () => {
  it('removes exactly the three auth variables and keeps the rest', () => {
    const out = scrubAuthEnv(dirty);
    for (const k of AUTH_ENV_VARS) expect(out[k]).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/Users/x');
    expect(out.OTHER).toBe('1');
    expect(hasAuthEnv(out)).toBe(false);
    expect(hasAuthEnv(dirty)).toBe(true);
    // does not mutate the input
    expect(dirty.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
  });
});

describe('ApiKeyAuthProvider', () => {
  const common = {
    subscriptionModeEnabled: true,
    policyCheckedAt: '2026-10-02',
    bindHost: '127.0.0.1',
  };

  it('uses the env key and passes only ANTHROPIC_API_KEY to the child', async () => {
    const p = new ApiKeyAuthProvider({ ...common, env: dirty, keyStore: new MemoryKeyStore() });
    const status = await p.probe();
    expect(status).toMatchObject({ mode: 'API_KEY', available: true, keySource: 'env' });
    const env = p.childEnv(dirty);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-secret');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    // the status DTO never carries the key
    expect(JSON.stringify(status)).not.toContain('sk-ant');
  });

  it('falls back to the keychain and reports when nothing is configured', async () => {
    const withKey = new ApiKeyAuthProvider({
      ...common,
      env: { PATH: '/bin' },
      keyStore: new MemoryKeyStore('sk-ant-fromkeychain'),
    });
    expect(await withKey.probe()).toMatchObject({ available: true, keySource: 'keychain' });
    expect(withKey.childEnv({ PATH: '/bin' }).ANTHROPIC_API_KEY).toBe('sk-ant-fromkeychain');

    const none = new ApiKeyAuthProvider({
      ...common,
      env: { PATH: '/bin' },
      keyStore: new MemoryKeyStore(),
    });
    const s = await none.probe();
    expect(s.available).toBe(false);
    expect(s.keySource).toBe('none');
    expect(s.error).toMatch(/No API key/);
    expect(none.constraints()).toEqual({ bindHost: null, defaultConcurrency: 4 });
  });
});

describe('ClaudeSubscriptionAuthProvider', () => {
  it('is available when the CLI reports a claude.ai login and strips every auth var', async () => {
    const seen: Record<string, string | undefined>[] = [];
    const p = new ClaudeSubscriptionAuthProvider({
      env: dirty,
      policyCheckedAt: '2026-10-02',
      probeFn: async (env) => {
        seen.push(env);
        return {
          loggedIn: true,
          authMethod: 'claude.ai',
          subscriptionType: 'max',
          email: 'u@example.com',
        };
      },
    });
    const s = await p.probe();
    expect(s).toMatchObject({
      mode: 'CLAUDE_SUBSCRIPTION',
      available: true,
      loggedIn: true,
      subscriptionType: 'max',
      bindHost: '127.0.0.1',
    });
    expect(s.notice).toMatch(/plan usage/);
    // the probe itself ran with a scrubbed env so an API key cannot change the answer
    expect(seen[0]?.ANTHROPIC_API_KEY).toBeUndefined();
    const env = p.childEnv(dirty);
    for (const k of AUTH_ENV_VARS) expect(env[k]).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(p.constraints()).toMatchObject({ bindHost: '127.0.0.1', defaultConcurrency: 2 });
  });

  it('reports not logged in and non-subscription logins as unavailable', async () => {
    const out = new ClaudeSubscriptionAuthProvider({
      env: {},
      policyCheckedAt: '',
      probeFn: async () => ({ loggedIn: false }),
    });
    expect(await out.probe()).toMatchObject({
      available: false,
      error: expect.stringMatching(/claude login/),
    });
    const api = new ClaudeSubscriptionAuthProvider({
      env: {},
      policyCheckedAt: '',
      probeFn: async () => ({ loggedIn: true, authMethod: 'api_key' }),
    });
    expect(await api.probe()).toMatchObject({
      available: false,
      error: expect.stringMatching(/api_key/),
    });
  });
});

describe('createAuthProvider', () => {
  it('honours the feature flag', () => {
    const s = defaultSettings({ authMode: 'CLAUDE_SUBSCRIPTION', subscriptionModeEnabled: false });
    expect(() =>
      createAuthProvider(s, { env: {}, keyStore: new MemoryKeyStore(), bindHost: '127.0.0.1' }),
    ).toThrow(/feature flag/);
    const ok = createAuthProvider(
      defaultSettings({ authMode: 'CLAUDE_SUBSCRIPTION', subscriptionModeEnabled: true }),
      { env: {}, keyStore: new MemoryKeyStore(), bindHost: '127.0.0.1' },
    );
    expect(ok.mode).toBe('CLAUDE_SUBSCRIPTION');
    expect(
      createAuthProvider(defaultSettings(), {
        env: {},
        keyStore: new MemoryKeyStore(),
        bindHost: '127.0.0.1',
      }).mode,
    ).toBe('API_KEY');
  });
});
