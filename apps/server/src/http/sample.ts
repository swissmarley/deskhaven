import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../app.js';
import { REPO_ROOT } from '../config.js';

/** Where the bundled sample repo lives inside this monorepo. */
export function bundledSamplePath(): string {
  return path.join(REPO_ROOT, 'examples', 'sample-repo');
}

/**
 * Copy the bundled sample CLI into the data dir (once) and make it a git repo so agents can work in
 * a realistic, disposable workspace. Returns the path.
 */
export function ensureSampleRepo(dataDir: string, source = bundledSamplePath()): string {
  const target = path.join(dataDir, 'sample-repo');
  if (!fs.existsSync(path.join(target, 'package.json'))) {
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
  if (!fs.existsSync(path.join(target, '.git'))) {
    try {
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: target, stdio: 'ignore', timeout: 20_000 });
      git('init', '-q', '-b', 'main');
      git('add', '-A');
      git(
        '-c',
        'user.name=Deskhaven',
        '-c',
        'user.email=deskhaven@localhost',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '-m',
        'sample-cli: initial import',
      );
    } catch {
      // git is optional; the folder still works as a plain workdir
    }
  }
  return target;
}

export function registerSampleRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/sample/init', async (_req, reply) => {
    try {
      return { path: ensureSampleRepo(ctx.config.dataDir) };
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
