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
  if (ctx.security.remote && !config.sessionToken) {
    // Remote binds cannot hand the session cookie to whoever asks, so the owner gets a login URL
    // (valid for this launch) on the terminal. Written to stderr directly, never through the logger.
    const host = config.allowedHosts[0] ?? config.host;
    process.stderr.write(
      `\nOpen Deskhaven with this login URL (valid until restart; keep it private):\n  http://${host.includes(':') ? host : `${host}:${config.port}`}/?token=${encodeURIComponent(ctx.security.token)}\n\n`,
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
