import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultDataDir, defaultDbPath, envVar, loadConfig } from '../src/config.js';

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
