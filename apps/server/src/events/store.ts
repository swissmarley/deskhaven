import { type AgentEvent, AgentEventSchema } from '@agenthotel/shared';
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events as eventsTable } from '../db/schema.js';
import type { WsHub } from '../ws/hub.js';

/** Events that are broadcast live but never written to disk (too chatty, no replay value). */
const EPHEMERAL_TYPES = new Set<AgentEvent['type']>(['text_delta', 'thinking_delta']);

export interface ListEventsQuery {
  agentId?: string;
  sinceSeq?: number;
  limit?: number;
  types?: AgentEvent['type'][];
  /** Oldest first when true (replay), newest first otherwise. */
  ascending?: boolean;
}

export class EventStore {
  private readonly listeners = new Set<(e: AgentEvent) => void>();

  constructor(
    private readonly db: Db,
    private readonly hub: WsHub,
  ) {}

  /** Validates, persists (unless ephemeral), broadcasts, and notifies in-process listeners. */
  append(input: AgentEvent): AgentEvent {
    let event = AgentEventSchema.parse(input);
    if (!EPHEMERAL_TYPES.has(event.type)) {
      const row = this.db
        .insert(eventsTable)
        .values({
          id: event.id,
          ts: event.ts,
          agentId: event.agentId,
          sessionId: event.sessionId ?? null,
          taskId: event.taskId ?? null,
          type: event.type,
          payload: JSON.stringify(event),
        })
        .returning({ seq: eventsTable.seq })
        .get();
      if (row) event = { ...event, seq: row.seq };
    }
    this.hub.broadcast({ type: 'event', event });
    for (const l of this.listeners) l(event);
    return event;
  }

  list(q: ListEventsQuery = {}): AgentEvent[] {
    const conds = [];
    if (q.agentId) conds.push(eq(eventsTable.agentId, q.agentId));
    if (q.sinceSeq !== undefined) conds.push(gt(eventsTable.seq, q.sinceSeq));
    if (q.types?.length) conds.push(inArray(eventsTable.type, q.types));
    const rows = this.db
      .select({ seq: eventsTable.seq, payload: eventsTable.payload })
      .from(eventsTable)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(q.ascending ? asc(eventsTable.seq) : desc(eventsTable.seq))
      .limit(Math.min(q.limit ?? 200, 5000))
      .all();
    const out: AgentEvent[] = [];
    for (const r of rows) {
      const parsed = AgentEventSchema.safeParse({ ...JSON.parse(r.payload), seq: r.seq });
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  latest(agentId: string, type: AgentEvent['type']): AgentEvent | undefined {
    return this.list({ agentId, types: [type], limit: 1 })[0];
  }

  deleteForAgent(agentId: string): void {
    this.db.delete(eventsTable).where(eq(eventsTable.agentId, agentId)).run();
  }

  onEvent(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
