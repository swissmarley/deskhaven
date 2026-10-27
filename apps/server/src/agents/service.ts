import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type Agent,
  type AgentEventOf,
  AgentSchema,
  type Avatar,
  agentCwd,
  type CreateAgent,
  DEFAULT_ROOM_ID,
  emptyUsage,
  newId,
  presetById,
  type RolePreset,
  type Room,
  resolveAgentModel,
  type UpdateAgent,
  WORKDIR_ERROR_PREFIX,
} from '@deskhaven/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents as agentsTable, usageDaily } from '../db/schema.js';
import type { SettingsService } from '../settings/service.js';
import type { WsHub } from '../ws/hub.js';

export const PALETTES = {
  skin: ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a1665e'],
  hair: ['#2c1b18', '#4a2c2a', '#b55239', '#d6b370', '#1b1b1b', '#6e6e6e', '#3a86ff', '#ef476f'],
  shirt: ['#3a86ff', '#ff006e', '#8338ec', '#fb5607', '#06d6a0', '#ffbe0b', '#118ab2', '#ef476f'],
  pants: ['#1d3557', '#2b2d42', '#4a4e69', '#22223b', '#5c677d', '#6c584c'],
} as const;

/** mulberry32: a small, well-mixed 32-bit PRNG returning floats in [0, 1). */
function mulberry32(a: number): () => number {
  let t = a >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random avatar; the same `seed` (in [0, 1)) always gives the same one. Every field draws its own
 * number from a seeded PRNG. (The old per-field LCG barely moved with the seed, so 10,000 calls
 * produced only two distinct avatars.)
 */
export function randomAvatar(seed = Math.random()): Avatar {
  const next = mulberry32(Math.floor(seed * 4294967296));
  const pick = <T>(arr: readonly [T, ...T[]]): T => arr[Math.floor(next() * arr.length)] ?? arr[0];
  return {
    skin: pick(PALETTES.skin),
    hair: pick(PALETTES.hair),
    hairStyle: pick(['short', 'long', 'cap', 'bald', 'bun'] as const),
    shirt: pick(PALETTES.shirt),
    pants: pick(PALETTES.pants),
    accessory: pick(['none', 'glasses', 'headset', 'tie', 'scarf', 'none'] as const),
  };
}

/**
 * Directories an agent may never use as its working directory: the filesystem root, top-level
 * system folders and the home directory itself (an agent there could edit ~/.ssh or ~/.claude).
 * Only exact matches: projects below them (e.g. /usr/local/src/app) stay allowed.
 */
export function forbiddenWorkdirs(home = os.homedir()): Set<string> {
  const unix = [
    '/bin',
    '/boot',
    '/dev',
    '/etc',
    '/home',
    '/lib',
    '/lib64',
    '/opt',
    '/proc',
    '/root',
    '/run',
    '/sbin',
    '/srv',
    '/sys',
    '/tmp',
    '/usr',
    '/var',
    '/Applications',
    '/Library',
    '/System',
    '/Users',
    '/Volumes',
    '/private',
    '/private/tmp',
    '/private/var',
  ];
  const out = new Set<string>([...unix, home].map((p) => path.resolve(p)));
  for (const p of [...out]) {
    try {
      out.add(fs.realpathSync(p));
    } catch {
      // not on this system
    }
  }
  return out;
}

/**
 * The canonical working directory for `input`: must be absolute (a relative path would be resolved
 * against the server's own folder), exist, be a directory, and not be a system root. Symlinks are
 * resolved so the checks and the edit guard see the real location.
 */
export function validateWorkdir(input: string, forbidden = forbiddenWorkdirs()): string {
  if (!path.isAbsolute(input))
    throw new Error(`Working directory must be an absolute path: ${input}`);
  let real: string;
  try {
    real = fs.realpathSync(input);
  } catch {
    throw new Error(`Working directory does not exist: ${input}`);
  }
  if (!fs.statSync(real).isDirectory())
    throw new Error(`Working directory is not a directory: ${real}`);
  if (path.parse(real).root === real || forbidden.has(real))
    throw new Error(
      `Refusing ${real} as a working directory: pick a project folder, not a system or home root`,
    );
  return real;
}

/**
 * Why `agent` cannot run in its directory, as a user-facing `lastError`, or null when it can. Agents
 * stored before the workdir rules existed are checked here, at boot and on every start.
 */
export function workdirProblem(agent: Pick<Agent, 'workdir' | 'worktree'>): string | null {
  try {
    validateWorkdir(agentCwd(agent));
    return null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // A worktree agent's folder cannot be edited (its repository is fixed): only firing helps.
    const action = agent.worktree
      ? 'Its worktree cannot be repaired from here: fire the agent and hire a new one.'
      : 'Edit the agent to pick another folder, or fire it.';
    return `${WORKDIR_ERROR_PREFIX}${reason}. ${action}`;
  }
}

export class AgentService {
  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
    private readonly settings: SettingsService,
    private readonly room: () => Room,
    private readonly presetLookup: (id: string) => RolePreset | undefined = presetById,
  ) {}

  list(): Agent[] {
    return this.db
      .select()
      .from(agentsTable)
      .all()
      .map((r) => AgentSchema.parse(JSON.parse(r.json)))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): Agent | undefined {
    const row = this.db.select().from(agentsTable).where(eq(agentsTable.id, id)).get();
    return row ? AgentSchema.parse(JSON.parse(row.json)) : undefined;
  }

  /** Throws when `input` cannot become an agent; returns the resolved working directory. */
  validateCreate(input: CreateAgent): string {
    if (!this.presetLookup(input.rolePresetId))
      throw new Error(`Unknown role preset ${input.rolePresetId}`);
    if (!input.name.trim()) throw new Error('Name must not be empty');
    return validateWorkdir(input.workdir);
  }

  /**
   * `extra.worktree` is the agent's own checkout (created by the caller under the data dir); the
   * runtime then uses it as the cwd while `workdir` keeps pointing at the source repository.
   */
  create(input: CreateAgent, extra: { id?: string; worktree?: Agent['worktree'] } = {}): Agent {
    const workdir = this.validateCreate(input);
    const preset = this.presetLookup(input.rolePresetId);
    if (!preset) throw new Error(`Unknown role preset ${input.rolePresetId}`);
    const now = Date.now();
    const settings = this.settings.get();
    const agent: Agent = AgentSchema.parse({
      id: extra.id ?? newId(),
      name: input.name.trim(),
      avatar: input.avatar ?? randomAvatar(),
      rolePresetId: preset.id,
      systemPrompt: input.systemPrompt ?? preset.systemPrompt,
      model: resolveAgentModel(input.model, preset, settings),
      tools: input.tools === undefined ? preset.tools : input.tools,
      allowedTools: input.allowedTools ?? preset.allowedTools,
      permissionMode: input.permissionMode ?? preset.permissionMode,
      workdir,
      worktree: extra.worktree ?? null,
      sessionId: null,
      status: 'stopped',
      roomId: input.roomId ?? DEFAULT_ROOM_ID,
      deskId: this.freeDesk(),
      budget: input.budget ?? {},
      currentTaskId: null,
      usage: emptyUsage(),
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    this.write(agent);
    return agent;
  }

  update(id: string, patch: UpdateAgent): Agent {
    const current = this.mustGet(id);
    if (patch.name !== undefined && !patch.name.trim()) throw new Error('Name must not be empty');
    const rolePresetId = patch.rolePresetId ?? current.rolePresetId;
    const preset = this.presetLookup(rolePresetId);
    if (!preset) throw new Error(`Unknown role preset ${rolePresetId}`);
    if (patch.model === null) {
      patch = {
        ...patch,
        model: resolveAgentModel(undefined, preset, this.settings.get()),
      };
    }
    let fixesWorkdirError = false;
    if (patch.workdir !== undefined) {
      const workdir = validateWorkdir(patch.workdir);
      if (current.worktree && workdir !== current.workdir)
        throw new Error(
          'This agent works in its own git worktree; fire it and hire a new one to change the repository',
        );
      patch = { ...patch, workdir };
      fixesWorkdirError = Boolean(current.lastError?.startsWith(WORKDIR_ERROR_PREFIX));
    }
    const next = AgentSchema.parse({
      ...current,
      ...patch,
      // A valid new workdir clears the "invalid working directory" error so the agent can start.
      ...(fixesWorkdirError && !workdirProblem({ ...current, ...patch })
        ? { status: 'stopped', lastError: null }
        : {}),
      updatedAt: Date.now(),
    });
    this.write(next);
    return next;
  }

  /** Functional update used by the runtime callbacks. */
  patch(id: string, fn: (a: Agent) => Agent): Agent | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = AgentSchema.parse({ ...fn(current), updatedAt: Date.now() });
    this.write(next);
    return next;
  }

  remove(id: string): void {
    this.db.delete(agentsTable).where(eq(agentsTable.id, id)).run();
    this.hub.broadcast({ type: 'agent_removed', agentId: id });
  }

  addUsage(id: string, turn: AgentEventOf<'turn_completed'>): void {
    this.patch(id, (a) => ({
      ...a,
      usage: {
        costUsd: a.usage.costUsd + turn.costUsd,
        inputTokens: a.usage.inputTokens + turn.inputTokens,
        outputTokens: a.usage.outputTokens + turn.outputTokens,
        cacheReadTokens: a.usage.cacheReadTokens + turn.cacheReadTokens,
        cacheCreationTokens: a.usage.cacheCreationTokens + turn.cacheCreationTokens,
        turns: a.usage.turns + 1,
      },
    }));
    const date = localDate();
    const row = this.db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.date, date), eq(usageDaily.agentId, id)))
      .get();
    const next = {
      date,
      agentId: id,
      costUsd: (row?.costUsd ?? 0) + turn.costUsd,
      inputTokens: (row?.inputTokens ?? 0) + turn.inputTokens,
      outputTokens: (row?.outputTokens ?? 0) + turn.outputTokens,
      cacheReadTokens: (row?.cacheReadTokens ?? 0) + turn.cacheReadTokens,
      cacheCreationTokens: (row?.cacheCreationTokens ?? 0) + turn.cacheCreationTokens,
      turns: (row?.turns ?? 0) + 1,
    };
    this.db
      .insert(usageDaily)
      .values(next)
      .onConflictDoUpdate({ target: [usageDaily.date, usageDaily.agentId], set: next })
      .run();
  }

  todayUsage(agentId?: string) {
    const date = localDate();
    const rows = this.db
      .select()
      .from(usageDaily)
      .where(
        agentId
          ? and(eq(usageDaily.date, date), eq(usageDaily.agentId, agentId))
          : eq(usageDaily.date, date),
      )
      .all();
    const total = emptyUsage();
    for (const r of rows) {
      total.costUsd += r.costUsd;
      total.inputTokens += r.inputTokens;
      total.outputTokens += r.outputTokens;
      total.cacheReadTokens += r.cacheReadTokens;
      total.cacheCreationTokens += r.cacheCreationTokens;
      total.turns += r.turns;
    }
    return total;
  }

  private freeDesk(): string | null {
    const taken = new Set(this.list().map((a) => a.deskId));
    const desk = this.room().furniture.find((f) => f.kind === 'desk' && !taken.has(f.id));
    return desk?.id ?? null;
  }

  private mustGet(id: string): Agent {
    const a = this.get(id);
    if (!a) throw new Error(`Unknown agent ${id}`);
    return a;
  }

  private write(agent: Agent): void {
    const json = JSON.stringify(agent);
    this.db
      .insert(agentsTable)
      .values({
        id: agent.id,
        json,
        status: agent.status,
        sessionId: agent.sessionId,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })
      .onConflictDoUpdate({
        target: agentsTable.id,
        set: { json, status: agent.status, sessionId: agent.sessionId, updatedAt: agent.updatedAt },
      })
      .run();
    this.hub.broadcast({ type: 'agent_upserted', agent });
  }
}

export function localDate(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
