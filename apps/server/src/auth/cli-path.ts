import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Locate the unmodified `claude` binary that the SDK bundles as a platform package
 * (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`). With pnpm it is a sibling of the SDK package
 * inside the virtual store; with npm it is a sibling under node_modules/@anthropic-ai. Falls back to
 * `claude` on PATH.
 */
export function resolveBundledCli(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const sdkMain = req.resolve('@anthropic-ai/claude-agent-sdk');
    const sdkDir = path.dirname(sdkMain);
    const platformPkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
    const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const candidates = [
      path.join(sdkDir, '..', platformPkg, bin),
      path.join(sdkDir, 'node_modules', '@anthropic-ai', platformPkg, bin),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } catch {
    // fall through
  }
  return null;
}

export function resolveCli(): { path: string; source: 'bundled' | 'path' } | null {
  const bundled = resolveBundledCli();
  if (bundled) return { path: bundled, source: 'bundled' };
  return { path: 'claude', source: 'path' };
}

export interface CliAuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  subscriptionType?: string;
  email?: string;
  apiProvider?: string;
}

/**
 * Harmless probe: `claude auth status` prints JSON about the login state. We read stdout only; we
 * never open ~/.claude/.credentials.json or the keychain entry. Runs with a scrubbed env so an API key
 * in our own environment cannot change the answer.
 */
export function cliAuthStatus(
  env: Record<string, string | undefined>,
  timeoutMs = 15_000,
): Promise<CliAuthStatus> {
  const cli = resolveCli();
  if (!cli) return Promise.resolve({ loggedIn: false });
  return new Promise((resolve) => {
    execFile(
      cli.path,
      ['auth', 'status'],
      { env: env as NodeJS.ProcessEnv, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const text = String(stdout ?? '').trim();
        try {
          const start = text.indexOf('{');
          const json = JSON.parse(start >= 0 ? text.slice(start) : text) as Record<string, unknown>;
          resolve({
            loggedIn: Boolean(json.loggedIn),
            authMethod: typeof json.authMethod === 'string' ? json.authMethod : undefined,
            subscriptionType:
              typeof json.subscriptionType === 'string' ? json.subscriptionType : undefined,
            email: typeof json.email === 'string' ? json.email : undefined,
            apiProvider: typeof json.apiProvider === 'string' ? json.apiProvider : undefined,
          });
        } catch {
          // exit code 1 means "not logged in" per the CLI reference; anything unparsable is "unknown".
          resolve({ loggedIn: false, authMethod: err ? 'none' : undefined });
        }
      },
    );
  });
}
