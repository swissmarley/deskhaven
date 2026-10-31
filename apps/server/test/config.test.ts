import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultDataDir,
  defaultDbPath,
  envVar,
  findRepoRoot,
  loadConfig,
  MIN_SESSION_TOKEN_LENGTH,
  REPO_ROOT,
  resolveWebDist,
  webDistProblem,
} from '../src/config.js';

describe('config rename compatibility', () => {
  it('prefers DESKHAVEN_* and falls back to AGENTHOTEL_*', () => {
    expect(envVar({ DESKHAVEN_PORT: '1', AGENTHOTEL_PORT: '2' }, 'PORT')).toBe('1');
    expect(envVar({ AGENTHOTEL_PORT: '2' }, 'PORT')).toBe('2');
    expect(loadConfig({ AGENTHOTEL_DATA_DIR: '/x', AGENTHOTEL_DB: ':memory:' }).dataDir).toBe('/x');
  });

  it('keeps using an existing ~/.agenthotel until ~/.deskhaven exists', () => {
    const only = (p: string) => (q: string) => q === p;
    expect(defaultDataDir('/home/u', only('/home/u/.agenthotel'))).toBe('/home/u/.agenthotel');
    expect(defaultDataDir('/home/u', only('/home/u/.deskhaven'))).toBe('/home/u/.deskhaven');
    expect(defaultDataDir('/home/u', () => false)).toBe('/home/u/.deskhaven');
    expect(defaultDbPath('/d', only(path.join('/d', 'agenthotel.db')))).toBe('/d/agenthotel.db');
    expect(defaultDbPath('/d', () => false)).toBe('/d/deskhaven.db');
  });
});

describe('DESKHAVEN_WEB_DIST', () => {
  it('resolves a relative path from the repository root, not the server package', () => {
    const root = path.resolve(import.meta.dirname, '../../..');
    expect(REPO_ROOT).toBe(root);
    expect(loadConfig({ DESKHAVEN_WEB_DIST: 'apps/web/dist' }).webDist).toBe(
      path.join(root, 'apps/web/dist'),
    );
    expect(resolveWebDist('/srv/dist')).toBe('/srv/dist');
    expect(resolveWebDist(undefined)).toBeNull();
  });

  it('reports a missing folder or index.html', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskhaven-dist-'));
    expect(webDistProblem(path.join(dir, 'nope'))).toMatch(/does not exist/);
    expect(webDistProblem(dir)).toMatch(/no index\.html/);
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
    expect(webDistProblem(dir)).toBeNull();
  });
});

describe('DESKHAVEN_SESSION_TOKEN', () => {
  it('refuses tokens shorter than 32 characters', () => {
    for (const t of ['1', 'short-token', 'x'.repeat(MIN_SESSION_TOKEN_LENGTH - 1)]) {
      expect(() => loadConfig({ DESKHAVEN_SESSION_TOKEN: t }), t).toThrow(/at least 32 characters/);
    }
  });

  it('accepts 32+ characters and defaults to a random token when unset', () => {
    const t = 'x'.repeat(MIN_SESSION_TOKEN_LENGTH);
    expect(loadConfig({ DESKHAVEN_SESSION_TOKEN: t }).sessionToken).toBe(t);
    expect(loadConfig({}).sessionToken).toBeNull();
    expect(loadConfig({ DESKHAVEN_SESSION_TOKEN: '' }).sessionToken).toBeNull();
  });
});

describe('findRepoRoot', () => {
  it('finds the workspace root from the sources and from the bundle alike', () => {
    const root = '/repo';
    const exists = (p: string) => p === '/repo/pnpm-workspace.yaml';
    expect(findRepoRoot('/repo/apps/server/src', exists)).toBe(root);
    expect(findRepoRoot('/repo/apps/server/dist', exists)).toBe(root);
    expect(findRepoRoot('/repo/apps/server/src/http', exists)).toBe(root);
  });

  it('points at the real checkout', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'pnpm-workspace.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'examples', 'sample-repo'))).toBe(true);
  });
});
