import fs from 'node:fs';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const { app, ctx } = await buildApp(config);
  await app.listen({ host: config.host, port: config.port });
  const status = await ctx.auth().probe();
  app.log.info(
    {
      dataDir: config.dataDir,
      authMode: status.mode,
      authAvailable: status.available,
      keySource: status.keySource,
      loggedIn: status.loggedIn,
    },
    'Deskhaven server ready',
  );
  if (ctx.security.remote) {
    // Remote binds cannot hand the session cookie to whoever asks, so the owner gets login URLs
    // (one per reachable address, never 0.0.0.0) on the terminal. Written to stderr directly,
    // never through the logger.
    const query = config.sessionToken
      ? '?token=<DESKHAVEN_SESSION_TOKEN>'
      : `?token=${encodeURIComponent(ctx.security.token)}`;
    const lines = ctx.security.loginUrls.map((u) => `  ${u}${query}`).join('\n');
    process.stderr.write(
      `\nOpen Deskhaven with one of these login URLs (valid until restart; keep them private):\n${lines}\n\n`,
    );
  }

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
