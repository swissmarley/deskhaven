import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultDataDir,
  defaultDbPath,
  envVar,
  loadConfig,
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
