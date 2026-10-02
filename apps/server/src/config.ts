import os from 'node:os';
import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  webDist: string | null;
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = env.AGENTHOTEL_DATA_DIR ?? path.join(os.homedir(), '.agenthotel');
  const port = Number.parseInt(env.AGENTHOTEL_PORT ?? '8787', 10);
  return {
    host: env.AGENTHOTEL_HOST ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 8787,
    dataDir,
    dbPath: path.join(dataDir, 'agenthotel.db'),
    webDist: env.AGENTHOTEL_WEB_DIST ?? null,
    isProduction: env.NODE_ENV === 'production',
  };
}
