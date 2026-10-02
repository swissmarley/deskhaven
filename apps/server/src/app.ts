import path from 'node:path';
import {
  APP_VERSION,
  ClientMessageSchema,
  DEFAULT_MANAGER_MODEL,
  DEFAULT_MODEL,
  defaultRoom,
  type RolePreset,
  type Room,
} from '@agenthotel/shared';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { AgentManager } from './agent/manager.js';
import { PermissionBroker } from './agent/permission-broker.js';
import { AgentService } from './agents/service.js';
import {
  ApiKeyAuthProvider,
  type AuthProvider,
  ClaudeSubscriptionAuthProvider,
  createAuthProvider,
  KeyringKeyStore,
  type KeyStore,
  MemoryKeyStore,
} from './auth/index.js';
import type { ServerConfig } from './config.js';
import { type Db, openDb } from './db/client.js';
import { EventStore } from './events/store.js';
import { registerRoutes } from './http/routes.js';
import { registerSampleRoutes } from './http/sample.js';
import { loggerOptions } from './logger.js';
import { PresetService } from './presets/service.js';
import { SettingsService, SUBSCRIPTION_MODE_FEATURE_FLAG } from './settings/service.js';
import { UsageService } from './usage/service.js';
import { WorktreeService } from './worktree/service.js';
import { WsHub } from './ws/hub.js';

export interface AppContext {
  config: ServerConfig;
  db: Db;
  hub: WsHub;
  settings: SettingsService;
  keyStore: KeyStore;
  auth: () => AuthProvider;
  reloadAuth: () => void;
  events: EventStore;
  broker: PermissionBroker;
  agents: AgentService;
  manager: AgentManager;
  usage: UsageService;
  room: () => Room;
  presets: () => RolePreset[];
  presetService: PresetService;
  worktrees: WorktreeService;
  models: () => { id: string; label: string }[];
  log: FastifyBaseLogger;
}

export const KNOWN_MODELS = [
  { id: DEFAULT_MODEL, label: 'Claude Sonnet 5.5 (default)' },
  { id: DEFAULT_MANAGER_MODEL, label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

export async function buildApp(
  config: ServerConfig,
): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({ logger: loggerOptions(config.isProduction) });
  const { db } = openDb(config.dbPath);
  const hub = new WsHub();
  const settings = new SettingsService(db);
  const keyStore: KeyStore =
    config.keyStore === 'memory' ? new MemoryKeyStore() : new KeyringKeyStore();
  const baseEnv = () => ({ ...process.env });

  // First run: API_KEY is the product default, but a machine with no key and a claude.ai login gets
  // subscription mode preselected so the app is usable right away (decision recorded in PLAN.md).
  if (settings.isFirstRun()) {
    let mode: 'API_KEY' | 'CLAUDE_SUBSCRIPTION' = 'API_KEY';
    if (config.probeOnBoot && SUBSCRIPTION_MODE_FEATURE_FLAG) {
      const api = new ApiKeyAuthProvider({
        env: baseEnv(),
        keyStore,
        subscriptionModeEnabled: true,
        policyCheckedAt: '',
        bindHost: config.host,
      });
      const sub = new ClaudeSubscriptionAuthProvider({ env: baseEnv(), policyCheckedAt: '' });
      const [a, s] = await Promise.all([api.probe(), sub.probe()]);
      if (!a.available && s.available) mode = 'CLAUDE_SUBSCRIPTION';
    }
    settings.update({ authMode: mode, concurrencyCap: mode === 'CLAUDE_SUBSCRIPTION' ? 2 : 4 });
    app.log.info({ mode }, 'first run: auth mode chosen');
  }

  let auth = createAuthProvider(settings.get(), {
    env: baseEnv(),
    keyStore,
    bindHost: config.host,
  });
  const enforceBind = (p: AuthProvider) => {
    const must = p.constraints().bindHost;
    if (must && config.host !== must) {
      throw new Error(
        `${p.mode} mode requires binding to ${must}; refusing to start on ${config.host}`,
      );
    }
  };
  enforceBind(auth);
  if (auth instanceof ApiKeyAuthProvider) await auth.prepare();

  const reloadAuth = () => {
    const next = createAuthProvider(settings.get(), {
      env: baseEnv(),
      keyStore,
      bindHost: config.host,
    });
    enforceBind(next);
    if (next instanceof ApiKeyAuthProvider) void next.prepare();
    auth = next;
  };

  const room = () => defaultRoom(0);
  const events = new EventStore(db, hub);
  PermissionBroker.reconcileOnBoot(db);
  const broker = new PermissionBroker({
    db,
    timeoutMs: () => settings.get().permissionTimeoutMs,
    onUpsert: (request) => hub.broadcast({ type: 'permission_upserted', request }),
  });
  const presetService = new PresetService(db);
  const worktrees = new WorktreeService(config.dataDir);
  const agents = new AgentService(db, hub, settings, room, (id) => presetService.get(id));
  // Agents from a previous process are not running anymore.
  for (const a of agents.list())
    if (a.status !== 'stopped')
      agents.patch(a.id, (x) => ({ ...x, status: 'stopped', currentTaskId: null }));

  let manager: AgentManager;
  const usage = new UsageService(agents, () => ({
    killSwitch: manager.killSwitch,
    running: manager.runningCount(),
    concurrencyCap: settings.get().concurrencyCap,
  }));
  events.onEvent((e) => usage.observe(e));

  manager = new AgentManager({
    agents,
    hub,
    concurrencyCap: () => settings.get().concurrencyCap,
    runtimeDeps: {
      auth: () => auth,
      events,
      broker,
      settings: () => settings.get(),
      baseEnv,
      log: app.log,
      onTurn: (agentId, _taskId, turn) => {
        agents.addUsage(agentId, turn);
        hub.broadcast({ type: 'usage', usage: usage.snapshot() });
      },
      onApiKeySource: () => hub.broadcast({ type: 'usage', usage: usage.snapshot() }),
    },
  });

  const ctx: AppContext = {
    config,
    db,
    hub,
    settings,
    keyStore,
    auth: () => auth,
    reloadAuth,
    events,
    broker,
    agents,
    manager,
    usage,
    room,
    presets: () => presetService.list(),
    presetService,
    worktrees,
    models: () => KNOWN_MODELS,
    log: app.log,
  };

  await app.register(websocket);
  registerRoutes(app, ctx);
  registerSampleRoutes(app, ctx);

  app.get('/ws', { websocket: true }, (socket) => {
    hub.add(socket);
    socket.on('message', (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = ClientMessageSchema.safeParse(data);
      if (!parsed.success) return;
      if (parsed.data.type === 'ping') hub.send(socket, { type: 'pong' });
      if (parsed.data.type === 'hello') {
        hub.send(socket, {
          type: 'hello',
          serverTime: Date.now(),
          version: APP_VERSION,
          agents: agents.list(),
          tasks: [],
          rooms: [room()],
          settings: settings.get(),
          pendingPermissions: broker.listPending(),
          usage: usage.snapshot(),
        });
        const recent = events.list({ sinceSeq: parsed.data.sinceSeq, limit: 500, ascending: true });
        if (recent.length) hub.send(socket, { type: 'events_batch', events: recent });
      }
    });
  });

  if (config.webDist) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDist), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws'))
        return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  app.addHook('onClose', async () => {
    await manager.shutdown();
  });

  return { app, ctx };
}
