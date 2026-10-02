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
    'AgentHotel server ready',
  );

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
