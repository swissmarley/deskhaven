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
  /** Extra Host values accepted besides loopback (DESKHAVEN_ALLOWED_HOSTS, comma-separated). */
  allowedHosts: string[];
  /** Explicit opt-in for binding to a non-loopback address (DESKHAVEN_ALLOW_REMOTE=1). */
  allowRemote: boolean;
  /** Port of the Vite dev server whose origin is accepted outside production. */
  devWebPort: number;
  /** Fixed session token (DESKHAVEN_SESSION_TOKEN); a random one is generated per launch otherwise. */
  sessionToken: string | null;
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

/**
 * The monorepo root: the nearest folder above `start` holding `pnpm-workspace.yaml`. Found by
 * walking up rather than by a fixed `../..`, because the same code runs from `apps/server/src`
 * (tsx, tests) and bundled into `apps/server/dist/index.js` (`pnpm start`).
 */
export function findRepoRoot(
  start: string,
  exists: (p: string) => boolean = fs.existsSync,
): string {
  let dir = path.resolve(start);
  for (;;) {
    if (exists(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, '../../..');
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(import.meta.dirname);

/**
 * `pnpm start` runs the server with apps/server as its cwd, so a relative DESKHAVEN_WEB_DIST such as
 * the documented `apps/web/dist` is resolved from the repository root, not from the process cwd.
 */
export function resolveWebDist(value: string | undefined, root = REPO_ROOT): string | null {
  if (!value) return null;
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(root, value);
}

/** Why `dir` cannot be served as the web UI, or null when it looks like a built app. */
export function webDistProblem(dir: string): string | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
    return `DESKHAVEN_WEB_DIST does not exist: ${dir} (run \`pnpm build\` first)`;
  if (!fs.existsSync(path.join(dir, 'index.html')))
    return `DESKHAVEN_WEB_DIST has no index.html: ${dir} (run \`pnpm build\` first)`;
  return null;
}

/** Shortest DESKHAVEN_SESSION_TOKEN accepted (the generated one is 43 base64url characters). */
export const MIN_SESSION_TOKEN_LENGTH = 32;

/** The fixed session token, or null for a random per-launch one. Throws when it is too short. */
export function sessionTokenFrom(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length < MIN_SESSION_TOKEN_LENGTH)
    throw new Error(
      `DESKHAVEN_SESSION_TOKEN must be at least ${MIN_SESSION_TOKEN_LENGTH} characters (got ${value.length}). ` +
        'Unset it to get a random token per launch, or generate one with `openssl rand -base64 32`.',
    );
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = envVar(env, 'DATA_DIR') ?? defaultDataDir();
  const port = Number.parseInt(envVar(env, 'PORT') ?? '8787', 10);
  const devWebPort = Number.parseInt(envVar(env, 'DEV_WEB_PORT') ?? '5173', 10);
  return {
    host: envVar(env, 'HOST') ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    dataDir,
    dbPath: envVar(env, 'DB') ?? defaultDbPath(dataDir),
    webDist: resolveWebDist(envVar(env, 'WEB_DIST')),
    isProduction: env.NODE_ENV === 'production',
    keyStore: envVar(env, 'KEYSTORE') === 'memory' ? 'memory' : 'keyring',
    probeOnBoot: (envVar(env, 'PROBE_ON_BOOT') ?? '1') !== '0',
    allowedHosts: (envVar(env, 'ALLOWED_HOSTS') ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    allowRemote: envVar(env, 'ALLOW_REMOTE') === '1',
    devWebPort: Number.isFinite(devWebPort) ? devWebPort : 5173,
    sessionToken: sessionTokenFrom(envVar(env, 'SESSION_TOKEN')),
  };
}
