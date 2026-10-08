import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  allowedHosts,
  checkBindPolicy,
  isLoopbackAddress,
  normalizeHost,
  originHost,
  SESSION_COOKIE,
} from '../src/http/security.js';
import { type Built, client, TEST_HOST, TEST_ORIGIN, testApp } from './helpers.js';

let built: Built;
let req: ReturnType<typeof client>;

beforeAll(async () => {
  built = await testApp();
  req = client(built);
  await built.app.ready();
});
afterAll(async () => {
  await built.app.close();
});

const agentBody = {
  name: 'Mallory',
  rolePresetId: 'engineer',
  workdir: process.cwd(),
  allowedTools: ['Bash', 'Write', 'Edit'],
};

describe('host allow-list (DNS rebinding)', () => {
  it('refuses a foreign Host with 403 and creates nothing', async () => {
    const res = await req({
      method: 'POST',
      url: '/api/agents',
      payload: agentBody,
      headers: {
        host: 'rebind.attacker.example:8787',
        origin: 'http://rebind.attacker.example:8787',
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_host' });
    expect((await req({ method: 'GET', url: '/api/agents' })).json()).toEqual([]);
  });

  it('refuses a foreign Host on reads and health, and the wrong port', async () => {
    for (const host of ['rebind.attacker.example', 'localhost:9999', 'evil@127.0.0.1:8787', '']) {
      const res = await req({ method: 'GET', url: '/api/health', headers: { host } });
      expect(res.statusCode, host).toBe(403);
    }
  });

  it('accepts every loopback spelling on the configured port', async () => {
    for (const host of ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787']) {
      const res = await req({ method: 'GET', url: '/api/agents', headers: { host } });
      expect(res.statusCode, host).toBe(200);
    }
  });
});

describe('origin checks (CSRF)', () => {
  it('refuses a foreign Origin with 403', async () => {
    const res = await req({
      method: 'POST',
      url: '/api/kill',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'forbidden_origin' });
    expect((await req({ method: 'GET', url: '/api/usage' })).json().killSwitch).toBe(false);
  });

  it('refuses cross-origin reads too', async () => {
    const res = await req({
      method: 'GET',
      url: '/api/agents',
      headers: { origin: 'http://localhost:3000' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a foreign Referer when Origin is missing', async () => {
    const res = await req({
      method: 'POST',
      url: '/api/kill',
      headers: { origin: null, referer: 'https://evil.example/page' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('refuses a browser write that carries neither Origin nor Referer', async () => {
    const res = await req({
      method: 'POST',
      url: '/api/kill/reset',
      headers: { origin: null, 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'missing_origin' });
  });

  it('refuses requests marked cross-site by fetch metadata', async () => {
    const res = await req({
      method: 'GET',
      url: '/api/session',
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts the Vite dev origin outside production only', async () => {
    const vite = { host: 'localhost:5173', origin: 'http://localhost:5173' };
    expect((await req({ method: 'POST', url: '/api/kill/reset', headers: vite })).statusCode).toBe(
      200,
    );
    const prod = await testApp({ NODE_ENV: 'production' });
    try {
      const res = await client(prod)({ method: 'POST', url: '/api/kill/reset', headers: vite });
      expect(res.statusCode).toBe(403);
    } finally {
      await prod.app.close();
    }
  });
});

describe('content type', () => {
  it('rejects a text/plain cross-site style POST with 415', async () => {
    const res = await req({
      method: 'POST',
      url: '/api/kill',
      payload: '{}',
      headers: { 'content-type': 'text/plain' },
    });
    expect(res.statusCode).toBe(415);
    expect((await req({ method: 'GET', url: '/api/usage' })).json().killSwitch).toBe(false);
  });

  it('rejects a bodiless POST without a content type, and a form post', async () => {
    expect(
      (await req({ method: 'POST', url: '/api/kill', headers: { 'content-type': null } }))
        .statusCode,
    ).toBe(415);
    expect(
      (
        await req({
          method: 'POST',
          url: '/api/agents',
          payload: 'name=x',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      ).statusCode,
    ).toBe(415);
  });

  it('accepts an empty JSON body on bodiless routes', async () => {
    expect((await req({ method: 'POST', url: '/api/kill/reset' })).statusCode).toBe(200);
  });
});

describe('session token', () => {
  it('returns 401 without the token, on reads and writes', async () => {
    expect(
      (await req({ method: 'GET', url: '/api/agents', headers: { cookie: null } })).statusCode,
    ).toBe(401);
    const res = await req({
      method: 'POST',
      url: '/api/agents',
      payload: agentBody,
      headers: { cookie: null },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a wrong token and accepts the header forms', async () => {
    expect(
      (
        await req({
          method: 'GET',
          url: '/api/agents',
          headers: { cookie: `${SESSION_COOKIE}=nope` },
        })
      ).statusCode,
    ).toBe(401);
    const token = built.ctx.security.token;
    const forms: Record<string, string>[] = [
      { 'x-deskhaven-token': token },
      { authorization: `Bearer ${token}` },
    ];
    for (const h of forms) {
      const res = await req({ method: 'GET', url: '/api/agents', headers: { cookie: null, ...h } });
      expect(res.statusCode).toBe(200);
    }
  });

  it('keeps health public but host-checked', async () => {
    expect(
      (await req({ method: 'GET', url: '/api/health', headers: { cookie: null } })).statusCode,
    ).toBe(200);
  });

  it('hands the token out as an HttpOnly SameSite=Strict cookie', async () => {
    const res = await req({ method: 'GET', url: '/api/session', headers: { cookie: null } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${SESSION_COOKIE}=${encodeURIComponent(built.ctx.security.token)}`);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(res.body).not.toContain(built.ctx.security.token);
  });

  it('uses a fresh token per launch', async () => {
    const other = await testApp();
    try {
      expect(other.ctx.security.token).not.toBe(built.ctx.security.token);
      expect(other.ctx.security.token.length).toBeGreaterThanOrEqual(40);
    } finally {
      await other.app.close();
    }
  });
});

describe('websocket', () => {
  const token = () => built.ctx.security.token;
  const wsHeaders = (over: Record<string, string> = {}) => ({
    host: TEST_HOST,
    origin: TEST_ORIGIN,
    cookie: `${SESSION_COOKIE}=${token()}`,
    ...over,
  });

  it('rejects a foreign Origin', async () => {
    await expect(
      built.app.injectWS('/ws', { headers: wsHeaders({ origin: 'https://evil.example' }) }),
    ).rejects.toThrow(/403/);
  });

  it('rejects a browser upgrade without Origin, a foreign Host and a missing token', async () => {
    const { origin: _o, ...noOrigin } = wsHeaders({ 'user-agent': 'Mozilla/5.0' });
    await expect(built.app.injectWS('/ws', { headers: noOrigin })).rejects.toThrow(/403/);
    await expect(
      built.app.injectWS('/ws', { headers: wsHeaders({ host: 'rebind.attacker.example:8787' }) }),
    ).rejects.toThrow(/403/);
    const { cookie: _c, ...noCookie } = wsHeaders();
    await expect(built.app.injectWS('/ws', { headers: noCookie })).rejects.toThrow(/401/);
  });

  it('accepts the same-origin app with its token', async () => {
    const ws: WebSocket = await built.app.injectWS('/ws', { headers: wsHeaders() });
    const hello = new Promise<{ type: string }>((resolve) =>
      ws.on('message', (raw) => resolve(JSON.parse(String(raw)))),
    );
    ws.send(JSON.stringify({ type: 'hello' }));
    expect((await hello).type).toBe('hello');
    ws.terminate();
  });
});

describe('remote binding', () => {
  it('refuses a non-loopback bind without DESKHAVEN_ALLOW_REMOTE=1', async () => {
    expect(() => checkBindPolicy({ host: '0.0.0.0', allowRemote: false })).toThrow(/ALLOW_REMOTE/);
    expect(() => checkBindPolicy({ host: '192.168.1.5', allowRemote: false })).toThrow();
    expect(checkBindPolicy({ host: '127.0.0.1', allowRemote: false })).toBe(false);
    expect(checkBindPolicy({ host: '0.0.0.0', allowRemote: true })).toBe(true);
    await expect(testApp({ DESKHAVEN_HOST: '0.0.0.0' })).rejects.toThrow(/ALLOW_REMOTE/);
  });

  it('requires the token itself before handing out the cookie remotely', async () => {
    const remote = await testApp({
      DESKHAVEN_HOST: '0.0.0.0',
      DESKHAVEN_ALLOW_REMOTE: '1',
      DESKHAVEN_ALLOWED_HOSTS: 'deskhaven.lan',
    });
    try {
      const r = client(remote);
      const host = { host: 'deskhaven.lan:8787', cookie: null };
      expect((await r({ method: 'GET', url: '/api/session', headers: host })).statusCode).toBe(401);
      const ok = await r({
        method: 'GET',
        url: `/api/session?token=${encodeURIComponent(remote.ctx.security.token)}`,
        headers: host,
      });
      expect(ok.statusCode).toBe(200);
      expect(String(ok.headers['set-cookie'])).toContain(SESSION_COOKIE);
      expect((await r({ method: 'GET', url: '/api/agents', headers: host })).statusCode).toBe(401);
      expect(
        (await r({ method: 'GET', url: '/api/agents', headers: { host: 'deskhaven.lan:8787' } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await remote.app.close();
    }
  });
});

describe('helpers', () => {
  it('normalises hosts and origins', () => {
    expect(normalizeHost('LocalHost:8787')).toBe('localhost:8787');
    expect(normalizeHost('localhost')).toBe('localhost:80');
    expect(normalizeHost('[::1]:8787')).toBe('[::1]:8787');
    expect(normalizeHost('a@b:1')).toBeNull();
    expect(normalizeHost('a/b')).toBeNull();
    expect(originHost('http://localhost:5173')).toBe('localhost:5173');
    expect(originHost('https://x.example')).toBe('x.example:443');
    expect(originHost('null')).toBeNull();
    expect(originHost('file:///x')).toBeNull();
    expect(isLoopbackAddress('127.0.0.2')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('::')).toBe(false);
  });

  it('builds the allow-list from config', () => {
    const hosts = allowedHosts({
      host: '127.0.0.1',
      port: 8787,
      isProduction: true,
      devWebPort: 5173,
      allowedHosts: ['box.lan', 'proxy.example:443'],
    });
    expect([...hosts].sort()).toEqual(
      [
        '127.0.0.1:8787',
        '[::1]:8787',
        'box.lan:8787',
        'localhost:8787',
        'proxy.example:443',
      ].sort(),
    );
  });
});
