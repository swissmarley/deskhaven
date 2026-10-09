import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export const TEST_HOST = '127.0.0.1:8787';
export const TEST_ORIGIN = `http://${TEST_HOST}`;

export type Built = Awaited<ReturnType<typeof buildApp>>;

/** In-memory app with the keychain and boot probe disabled. */
export async function testApp(env: Record<string, string> = {}): Promise<Built> {
  return buildApp(
    loadConfig({
      DESKHAVEN_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'deskhaven-data-')),
      DESKHAVEN_DB: ':memory:',
      DESKHAVEN_KEYSTORE: 'memory',
      DESKHAVEN_PROBE_ON_BOOT: '0',
      NODE_ENV: 'test',
      ...env,
    }),
  );
}

/**
 * `inject` as the web app would send it: loopback Host, same-origin Origin on writes, JSON content
 * type and the session cookie. Explicit headers win, and `null` removes a default.
 */
export type ClientOptions = Omit<InjectOptions, 'headers'> & {
  headers?: Record<string, string | null>;
};

export function client(built: Built) {
  return (opts: ClientOptions): Promise<LightMyRequestResponse> => {
    const method = String(opts.method ?? 'GET').toUpperCase();
    const defaults: Record<string, string> = {
      host: TEST_HOST,
      cookie: `${built.ctx.security.cookieName}=${built.ctx.security.token}`,
      ...(method === 'GET' ? {} : { origin: TEST_ORIGIN, 'content-type': 'application/json' }),
    };
    const merged: Record<string, string> = { ...defaults };
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    return built.app.inject({ ...opts, headers: merged } as InjectOptions);
  };
}
