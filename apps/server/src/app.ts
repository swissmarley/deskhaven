import path from 'node:path';
import {
  APP_VERSION,
  ClientMessageSchema,
  DEFAULT_MANAGER_MODEL,
  DEFAULT_MODEL,
  DEFAULT_ROOM_ID,
  defaultRoom,
  type RolePreset,
  type Room,
  type Settings,
  WORKDIR_ERROR_PREFIX,
} from '@deskhaven/shared';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { createBudgetGuard } from './agent/budget.js';
import { AgentManager } from './agent/manager.js';
import { PermissionBroker } from './agent/permission-broker.js';
import { AgentService, workdirProblem } from './agents/service.js';
import {
  ApiKeyAuthProvider,
  type AuthProvider,
  ClaudeSubscriptionAuthProvider,
  createAuthProvider,
  KeyringKeyStore,
  type KeyStore,
  MemoryKeyStore,
} from './auth/index.js';
import { type ServerConfig, webDistProblem } from './config.js';
import { type Db, openDb } from './db/client.js';
import { EventStore } from './events/store.js';
import { registerRoutes } from './http/routes.js';
import { registerSampleRoutes } from './http/sample.js';
import { generateToken, registerSecurity, type Security } from './http/security.js';
import { loggerOptions } from './logger.js';
import { createManagerMcpServer } from './manager/tools.js';
import { PresetService } from './presets/service.js';
import { RoomService } from './rooms/service.js';
import { SettingsService, SUBSCRIPTION_MODE_FEATURE_FLAG } from './settings/service.js';
import { TaskService } from './tasks/service.js';
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
  /** Provider for `settings` (bind constraints checked); throws instead of switching. */
  buildAuth: (settings: Settings) => AuthProvider;
  /** Makes `next` current once its key is loaded; idle agents pick it up on their next prompt. */
  applyAuth: (next: AuthProvider) => Promise<void>;
  /** Rebuilds the provider from the stored settings (after the keychain changed). */
  reloadAuth: () => Promise<void>;
  events: EventStore;
  broker: PermissionBroker;
  agents: AgentService;
  manager: AgentManager;
  usage: UsageService;
  room: () => Room;
  rooms: RoomService;
  presets: () => RolePreset[];
  presetService: PresetService;
  worktrees: WorktreeService;
  tasks: TaskService;
  models: () => { id: string; label: string }[];
  log: FastifyBaseLogger;
  security: Security;
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
  // Before anything else: refuses a non-loopback bind without DESKHAVEN_ALLOW_REMOTE=1.
  const security = registerSecurity(app, {
    config,
    token: config.sessionToken ?? generateToken(),
  });
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

  const buildAuth = (s: Settings) => {
    const next = createAuthProvider(s, { env: baseEnv(), keyStore, bindHost: config.host });
    enforceBind(next);
    return next;
  };
  const applyAuth = async (next: AuthProvider) => {
    // Load the key before publishing the provider, so the next agent start already sees it.
    if (next instanceof ApiKeyAuthProvider) await next.prepare();
    auth = next;
  };
  const reloadAuth = () => applyAuth(buildAuth(settings.get()));

  const events = new EventStore(db, hub);
  PermissionBroker.reconcileOnBoot(db);
  const broker = new PermissionBroker({
    db,
    timeoutMs: () => settings.get().permissionTimeoutMs,
    onUpsert: (request) => hub.broadcast({ type: 'permission_upserted', request }),
  });
  const presetService = new PresetService(db);
  const worktrees = new WorktreeService(config.dataDir);
  let agents: AgentService;
  const roomService = new RoomService(db, hub, () => agents);
  const room = () => roomService.get(DEFAULT_ROOM_ID) ?? defaultRoom();
  agents = new AgentService(db, hub, settings, room, (id) => presetService.get(id));
  // Agents from a previous process are not running anymore. Agents saved before the workdir rules
  // (e.g. with workdir "/") are flagged now, so the UI asks for a new folder before they can start.
  for (const a of agents.list()) {
    const problem = workdirProblem(a);
    if (problem) {
      app.log.warn({ agentId: a.id, workdir: a.workdir }, problem);
      agents.patch(a.id, (x) => ({
        ...x,
        status: 'error',
        currentTaskId: null,
        lastError: problem,
      }));
    } else if (a.status !== 'stopped' || a.lastError?.startsWith(WORKDIR_ERROR_PREFIX))
      // Also clears an "invalid working directory" error once the folder is usable again.
      agents.patch(a.id, (x) => ({
        ...x,
        status: 'stopped',
        currentTaskId: null,
        lastError: x.lastError?.startsWith(WORKDIR_ERROR_PREFIX) ? null : x.lastError,
      }));
  }

  let manager: AgentManager;
  const usage = new UsageService(agents, () => ({
    killSwitch: manager.killSwitch,
    running: manager.busyCount(),
    concurrencyCap: settings.get().concurrencyCap,
  }));
  events.onEvent((e) => usage.observe(e));
  // Seed the HUD's "auth mode in use" and plan windows from the last persisted events.
  for (const type of ['session_started', 'rate_limit'] as const) {
    const last = events.list({ types: [type], limit: 1 })[0];
    if (last) usage.observe(last);
  }

  let tasks: TaskService;
  manager = new AgentManager({
    agents,
    hub,
    concurrencyCap: () => settings.get().concurrencyCap,
    budgetCheck: createBudgetGuard(agents, () => settings.get()),
    idleTimeoutMs: () => settings.get().idleTimeoutMinutes * 60_000,
    runtimeDeps: {
      mcpServers: (agent) =>
        presetService.get(agent.rolePresetId)?.manager
          ? {
              deskhaven: createManagerMcpServer({
                agents,
                tasks,
                selfId: agent.id,
                isManager: (a) => Boolean(presetService.get(a.rolePresetId)?.manager),
              }),
            }
          : undefined,
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

  tasks = new TaskService(db, hub, { manager, agents, events, worktrees, broker, log: app.log });
  events.onEvent((e) => tasks.onEvent(e));
  tasks.reconcileOnBoot();

  const ctx: AppContext = {
    config,
    db,
    hub,
    settings,
    keyStore,
    auth: () => auth,
    buildAuth,
    applyAuth,
    reloadAuth,
    events,
    broker,
    agents,
    manager,
    usage,
    room,
    rooms: roomService,
    presets: () => presetService.list(),
    presetService,
    worktrees,
    tasks,
    models: () => KNOWN_MODELS,
    log: app.log,
    security,
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
          tasks: tasks.list(),
          rooms: roomService.list(),
          settings: settings.get(),
          pendingPermissions: broker.listPending(),
          usage: usage.snapshot(),
        });
        const recent = events.list({ sinceSeq: parsed.data.sinceSeq, limit: 500, ascending: true });
        if (recent.length) hub.send(socket, { type: 'events_batch', events: recent });
      }
    });
  });

  const distProblem = config.webDist ? webDistProblem(config.webDist) : null;
  if (distProblem) app.log.error({ webDist: config.webDist }, distProblem);
  if (config.webDist && !distProblem) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDist), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0] ?? req.url;
      // API, WS and file-like paths (anything with an extension, e.g. a missing /models/x.glb)
      // must not fall back to the SPA shell: a 200 index.html would reach a model loader as a
      // confusing parse error instead of a clean 404.
      if (
        pathname.startsWith('/api') ||
        pathname.startsWith('/ws') ||
        /\.[a-z0-9]+$/i.test(pathname)
      )
        return reply.code(404).send({ error: 'not_found' });
      return reply.sendFile('index.html');
    });
  }

  const idleSweep = setInterval(() => {
    void manager.sweepIdle().then((n) => {
      if (n) app.log.info({ stopped: n }, 'stopped idle agent processes');
    });
  }, 60_000);
  idleSweep.unref();

  app.addHook('onClose', async () => {
    clearInterval(idleSweep);
    await manager.shutdown();
  });

  return { app, ctx };
}
