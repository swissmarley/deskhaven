import fs from 'node:fs';
import path from 'node:path';
import {
  type Agent,
  type AgentEventOf,
  AgentSchema,
  type Avatar,
  type CreateAgent,
  DEFAULT_MODEL,
  DEFAULT_ROOM_ID,
  emptyUsage,
  newId,
  presetById,
  type RolePreset,
  type Room,
  type UpdateAgent,
} from '@agenthotel/shared';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agents as agentsTable, usageDaily } from '../db/schema.js';
import type { SettingsService } from '../settings/service.js';
import type { WsHub } from '../ws/hub.js';

const PALETTES = {
  skin: ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#a1665e'],
  hair: ['#2c1b18', '#4a2c2a', '#b55239', '#d6b370', '#1b1b1b', '#6e6e6e', '#3a86ff', '#ef476f'],
  shirt: ['#3a86ff', '#ff006e', '#8338ec', '#fb5607', '#06d6a0', '#ffbe0b', '#118ab2', '#ef476f'],
  pants: ['#1d3557', '#2b2d42', '#4a4e69', '#22223b', '#5c677d', '#6c584c'],
} as const;

export function randomAvatar(seed = Math.random()): Avatar {
  const pick = <T>(arr: readonly [T, ...T[]], salt: number): T => {
    const idx =
      Math.floor((((seed * 9301 + salt * 49297) % 233280) / 233280) * arr.length) % arr.length;
    return arr[idx] ?? arr[0];
  };
  return {
    skin: pick(PALETTES.skin, 1),
    hair: pick(PALETTES.hair, 2),
    hairStyle: pick(['short', 'long', 'cap', 'bald', 'bun'] as const, 3),
    shirt: pick(PALETTES.shirt, 4),
    pants: pick(PALETTES.pants, 5),
    accessory: pick(['none', 'glasses', 'headset', 'tie', 'scarf', 'none'] as const, 6),
  };
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

  create(input: CreateAgent): Agent {
    const preset = this.presetLookup(input.rolePresetId);
    if (!preset) throw new Error(`Unknown role preset ${input.rolePresetId}`);
    const workdir = path.resolve(input.workdir);
    if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
      throw new Error(`Working directory does not exist: ${workdir}`);
    }
    const now = Date.now();
    const settings = this.settings.get();
    const agent: Agent = AgentSchema.parse({
      id: newId(),
      name: input.name.trim(),
      avatar: input.avatar ?? randomAvatar(),
      rolePresetId: preset.id,
      systemPrompt: input.systemPrompt ?? preset.systemPrompt,
      model:
        input.model ??
        preset.model ??
        (preset.manager ? settings.managerModel : settings.defaultModel) ??
        DEFAULT_MODEL,
      tools: input.tools === undefined ? preset.tools : input.tools,
      allowedTools: input.allowedTools ?? preset.allowedTools,
      permissionMode: input.permissionMode ?? preset.permissionMode,
      workdir,
      worktree: null,
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
    if (patch.workdir) {
      const workdir = path.resolve(patch.workdir);
      if (!fs.existsSync(workdir)) throw new Error(`Working directory does not exist: ${workdir}`);
      patch = { ...patch, workdir };
    }
    const next = AgentSchema.parse({ ...current, ...patch, updatedAt: Date.now() });
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
