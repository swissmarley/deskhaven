import {
  APP_VERSION,
  CreateAgentSchema,
  CreateTaskSchema,
  newId,
  ResolvePermissionSchema,
  UpdateAgentSchema,
  UpdateSettingsSchema,
  UpdateTaskSchema,
} from '@deskhaven/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../app.js';
import type { WorktreeInfo } from '../worktree/service.js';

const idParams = z.object({ id: z.string().min(1) });
const messageBody = z.object({ text: z.string().min(1) });
const apiKeyBody = z.object({ key: z.string().min(10) });
const eventsQuery = z
  .object({
    agentId: z.string().optional(),
    sinceSeq: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().positive().max(5000).optional(),
    asc: z.stringbool().optional(),
    fromTs: z.coerce.number().int().nonnegative().optional(),
    toTs: z.coerce.number().int().nonnegative().optional(),
  })
  .refine((q) => q.fromTs === undefined || q.toTs === undefined || q.fromTs <= q.toTs, {
    message: 'fromTs must not be after toTs',
    path: ['fromTs'],
  });

function parse<T>(schema: z.ZodType<T>, value: unknown, reply: FastifyReply): T | null {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  void reply.code(400).send({ error: 'invalid_request', issues: r.error.issues });
  return null;
}

function fail(reply: FastifyReply, err: unknown, code = 400): void {
  void reply.code(code).send({ error: err instanceof Error ? err.message : String(err) });
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION, time: Date.now() }));

  // ---- auth & settings --------------------------------------------------------------------------
  app.get('/api/auth/status', async () => ctx.auth().probe());

  app.post('/api/auth/api-key', async (req, reply) => {
    const body = parse(apiKeyBody, req.body, reply);
    if (!body) return;
    await ctx.keyStore.set(body.key.trim());
    await ctx.reloadAuth();
    return { stored: true, keySource: 'keychain' };
  });

  app.delete('/api/auth/api-key', async () => {
    await ctx.keyStore.clear();
    await ctx.reloadAuth();
    return { stored: false };
  });

  app.get('/api/settings', async () => ctx.settings.get());

  app.patch('/api/settings', async (req, reply) => {
    const body = parse(UpdateSettingsSchema, req.body, reply);
    if (!body) return;
    const known = new Set(ctx.models().map((m) => m.id));
    for (const field of ['defaultModel', 'managerModel'] as const) {
      const id = body[field];
      if (id !== undefined && !known.has(id)) {
        return reply.code(400).send({ error: `Unknown model: ${id}` });
      }
    }
    try {
      // Validate the whole change (including the auth provider's bind constraints) before
      // persisting anything: a refused auth switch must leave the stored settings untouched.
      const before = ctx.settings.get();
      const candidate = ctx.settings.preview(body);
      const nextAuth = candidate.authMode !== before.authMode ? ctx.buildAuth(candidate) : null;
      const next = ctx.settings.update(body);
      if (nextAuth) await ctx.applyAuth(nextAuth);
      ctx.hub.broadcast({ type: 'settings_updated', settings: next });
      return next;
    } catch (err) {
      fail(reply, err);
    }
  });

  // ---- agents -----------------------------------------------------------------------------------
  app.get('/api/agents', async () => ctx.agents.list());

  app.post('/api/agents', async (req, reply) => {
    const body = parse(CreateAgentSchema, req.body, reply);
    if (!body) return;
    const id = newId();
    let repo: string | null = null;
    let worktree: WorktreeInfo | null = null;
    try {
      const workdir = ctx.agents.validateCreate(body);
      if (body.useWorktree) {
        repo = workdir;
        worktree = await ctx.worktrees.create(repo, id, body.name);
      }
      const agent = ctx.agents.create(body, { id, worktree });
      if (repo && worktree && (await ctx.worktrees.isDirty(repo).catch(() => false))) {
        // The worktree starts from HEAD: uncommitted work in the user's checkout is not in it.
        ctx.events.append({
          id: newId(),
          ts: Date.now(),
          agentId: agent.id,
          type: 'notification',
          kind: 'worktree',
          message: `${repo} has uncommitted changes; they are not in ${agent.name}'s worktree (${worktree.branch}), which starts from the last commit.`,
        });
      }
      return reply.code(201).send(agent);
    } catch (err) {
      if (repo && worktree) await ctx.worktrees.remove(repo, worktree, true).catch(() => undefined);
      fail(reply, err);
    }
  });

  app.get('/api/agents/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params, reply) ?? {};
    if (!id) return;
    const agent = ctx.agents.get(id);
    return agent ?? reply.code(404).send({ error: 'not_found' });
  });

  app.patch('/api/agents/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = p && parse(UpdateAgentSchema, req.body, reply);
    if (!p || !body) return;
    try {
      const agent = ctx.agents.update(p.id, body);
      ctx.manager.get(p.id)?.updateAgent(agent);
      return agent;
    } catch (err) {
      fail(reply, err);
    }
  });

  app.delete('/api/agents/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const q = p && parse(z.object({ force: z.stringbool().optional() }), req.query, reply);
    if (!p || !q) return;
    const agent = ctx.agents.get(p.id);
    if (!agent) return reply.code(404).send({ error: 'not_found' });
    const conflict = (err: unknown) =>
      reply.code(409).send({
        error: err instanceof Error ? err.message : String(err),
        worktree: agent.worktree,
      });
    // Refuse before stopping anything: firing an agent must not throw away uncommitted work, and a
    // check that cannot run (source repository moved or deleted) counts as "might be dirty".
    if (agent.worktree && !q.force) {
      const state = await ctx.worktrees.state(agent.workdir, agent.worktree);
      if (state.kind === 'dirty')
        return conflict(
          new Error(
            `worktree ${agent.worktree.path} has uncommitted changes; commit them or force removal`,
          ),
        );
      if (state.kind === 'unknown')
        return conflict(
          new Error(
            `cannot check worktree ${agent.worktree.path} for uncommitted changes (${state.reason}); force removal to delete the folder anyway`,
          ),
        );
    }
    await ctx.manager.remove(p.id);
    if (agent.worktree) {
      try {
        await ctx.worktrees.remove(agent.workdir, agent.worktree, q.force ?? false);
      } catch (err) {
        return conflict(err);
      }
    }
    ctx.agents.remove(p.id);
    return { ok: true };
  });

  for (const action of ['start', 'stop', 'pause', 'resume', 'interrupt'] as const) {
    app.post(`/api/agents/:id/${action}`, async (req, reply) => {
      const p = parse(idParams, req.params, reply);
      if (!p) return;
      try {
        switch (action) {
          case 'start':
            return { status: ctx.manager.start(p.id) };
          case 'stop':
            await ctx.manager.stop(p.id);
            return { status: 'stopped' };
          case 'pause':
            await ctx.manager.pause(p.id);
            return { status: 'paused' };
          case 'resume':
            ctx.manager.resume(p.id);
            return { status: ctx.manager.get(p.id)?.getStatus() ?? 'idle' };
          case 'interrupt':
            await ctx.manager.interrupt(p.id);
            return { ok: true };
        }
      } catch (err) {
        fail(reply, err);
      }
    });
  }

  app.post('/api/agents/:id/message', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = p && parse(messageBody, req.body, reply);
    if (!p || !body) return;
    try {
      ctx.manager.sendPrompt(p.id, body.text, null);
      return { ok: true };
    } catch (err) {
      fail(reply, err);
    }
  });

  // ---- tasks ------------------------------------------------------------------------------------
  app.get('/api/tasks', async () => ctx.tasks.list());

  app.post('/api/tasks', async (req, reply) => {
    const body = parse(CreateTaskSchema, req.body, reply);
    if (!body) return;
    try {
      return reply.code(201).send(ctx.tasks.create(body));
    } catch (err) {
      fail(reply, err);
    }
  });

  app.patch('/api/tasks/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = p && parse(UpdateTaskSchema, req.body, reply);
    if (!p || !body) return;
    try {
      return ctx.tasks.update(p.id, body);
    } catch (err) {
      fail(reply, err);
    }
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    if (!ctx.tasks.get(p.id)) return reply.code(404).send({ error: 'not_found' });
    ctx.tasks.remove(p.id);
    return { ok: true };
  });

  app.post('/api/tasks/:id/assign', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = p && parse(z.object({ agentId: z.string().min(1) }), req.body, reply);
    if (!p || !body) return;
    try {
      return ctx.tasks.assign(p.id, body.agentId);
    } catch (err) {
      fail(reply, err);
    }
  });

  app.post('/api/tasks/:id/nudge', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = p && parse(messageBody, req.body, reply);
    if (!p || !body) return;
    try {
      ctx.tasks.nudge(p.id, body.text);
      return { ok: true };
    } catch (err) {
      fail(reply, err);
    }
  });

  // ---- events, permissions, rooms, usage --------------------------------------------------------
  app.get('/api/events', async (req, reply) => {
    const q = parse(eventsQuery, req.query, reply);
    if (!q) return;
    return ctx.events.list({
      agentId: q.agentId,
      sinceSeq: q.sinceSeq,
      limit: q.limit,
      ascending: q.asc,
      fromTs: q.fromTs,
      toTs: q.toTs,
    });
  });

  app.get('/api/events/summary', async () => ctx.events.summary());

  app.get('/api/permissions', async () => ctx.broker.listPending());

  app.post('/api/permissions/:id/resolve', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    const body = p && parse(ResolvePermissionSchema, req.body, reply);
    if (!p || !body) return;
    const ok = ctx.broker.resolve(p.id, body.decision, body.message);
    return ok ? { ok: true } : reply.code(404).send({ error: 'not_pending' });
  });

  app.get('/api/rooms', async () => ctx.rooms.list());
  app.get('/api/rooms/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    return ctx.rooms.get(p.id) ?? reply.code(404).send({ error: 'not_found' });
  });
  app.put('/api/rooms/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return ctx.rooms.save({ ...body, id: p.id });
    } catch (err) {
      fail(reply, err);
    }
  });
  app.post('/api/rooms/:id/reset', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    try {
      return ctx.rooms.reset(p.id);
    } catch (err) {
      fail(reply, err);
    }
  });
  app.get('/api/usage', async () => ctx.usage.snapshot());
  app.get('/api/presets', async () => ctx.presets());
  app.put('/api/presets/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      return ctx.presetService.upsert({ ...body, id: p.id });
    } catch (err) {
      fail(reply, err);
    }
  });
  app.delete('/api/presets/:id', async (req, reply) => {
    const p = parse(idParams, req.params, reply);
    if (!p) return;
    return { preset: ctx.presetService.reset(p.id) ?? null };
  });
  app.get('/api/models', async () => ctx.models());

  app.post('/api/kill', async () => {
    await ctx.manager.killAll();
    return { killSwitch: true };
  });
  app.post('/api/kill/reset', async () => {
    ctx.manager.resetKillSwitch();
    return { killSwitch: false };
  });
}
