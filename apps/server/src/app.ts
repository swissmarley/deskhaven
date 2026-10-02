import { APP_VERSION, ClientMessageSchema } from '@agenthotel/shared';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { loggerOptions } from './logger.js';
import { WsHub } from './ws/hub.js';

export interface AppContext {
  config: ServerConfig;
  hub: WsHub;
}

export async function buildApp(
  config: ServerConfig,
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: loggerOptions(config.isProduction) });
  const hub = new WsHub();
  const ctx: AppContext = { config, hub };

  await app.register(websocket);

  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION, time: Date.now() }));

  app.get('/ws', { websocket: true }, (socket) => {
    hub.add(socket);
    socket.on('message', (raw) => {
      const parsed = ClientMessageSchema.safeParse(JSON.parse(String(raw)));
      if (!parsed.success) return;
      if (parsed.data.type === 'ping') hub.send(socket, { type: 'pong' });
      // 'hello' is answered with the full snapshot once state services exist (M2+).
    });
  });

  return { app, ctx };
}
