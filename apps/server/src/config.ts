import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  webDist: string | null;
  isProduction: boolean;
  keyStore: 'keyring' | 'memory';
  probeOnBoot: boolean;
}

/** Legacy prefix from before the rename (AgentHotel → Deskhaven, 2026-10-03); still honoured. */
const LEGACY_PREFIX = 'AGENTHOTEL_';

/** `DESKHAVEN_<name>`, falling back to `AGENTHOTEL_<name>` so existing shells keep working. */
export function envVar(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`DESKHAVEN_${name}`] ?? env[`${LEGACY_PREFIX}${name}`];
}

/**
 * Default data directory: `~/.deskhaven`, unless it does not exist yet and the pre-rename
 * `~/.agenthotel` does. The old directory is then used as is (its worktree paths are stored as
 * absolute paths in the database, so moving it would break resumed agents).
 */
export function defaultDataDir(
  home = os.homedir(),
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const current = path.join(home, '.deskhaven');
  const legacy = path.join(home, '.agenthotel');
  return !exists(current) && exists(legacy) ? legacy : current;
}

/** The database file inside `dataDir`: `deskhaven.db`, or a pre-rename `agenthotel.db` if present. */
export function defaultDbPath(
  dataDir: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  const current = path.join(dataDir, 'deskhaven.db');
  const legacy = path.join(dataDir, 'agenthotel.db');
  return !exists(current) && exists(legacy) ? legacy : current;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = envVar(env, 'DATA_DIR') ?? defaultDataDir();
  const port = Number.parseInt(envVar(env, 'PORT') ?? '8787', 10);
  return {
    host: envVar(env, 'HOST') ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    dataDir,
    dbPath: envVar(env, 'DB') ?? defaultDbPath(dataDir),
    webDist: envVar(env, 'WEB_DIST') ?? null,
    isProduction: env.NODE_ENV === 'production',
    keyStore: envVar(env, 'KEYSTORE') === 'memory' ? 'memory' : 'keyring',
    probeOnBoot: (envVar(env, 'PROBE_ON_BOOT') ?? '1') !== '0',
  };
}
