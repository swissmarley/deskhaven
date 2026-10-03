import {
  newId,
  type PermissionDecision,
  type PermissionRequest,
  PermissionRequestSchema,
} from '@deskhaven/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { permissionRequests } from '../db/schema.js';
import type { PermissionResult, PermissionUpdate } from './sdk-adapter.js';

export interface PermissionAsk {
  agentId: string;
  taskId: string | null;
  toolUseId: string;
  tool: string;
  input: unknown;
  title?: string;
  description?: string;
  suggestions?: PermissionUpdate[];
}

export interface PermissionOutcome {
  decision: PermissionDecision;
  result: PermissionResult;
  message?: string;
}

interface Pending {
  request: PermissionRequest;
  suggestions: PermissionUpdate[];
  resolve: (o: PermissionOutcome) => void;
  timer: NodeJS.Timeout | null;
}

interface BrokerDeps {
  db: Db;
  timeoutMs: () => number;
  onUpsert: (request: PermissionRequest) => void;
}

/**
 * Bridges the SDK's `canUseTool` promise to the UI: creates a persisted request, waits for a decision
 * (or a timeout → deny), and returns the SDK-shaped result. "Allow for this session" echoes the SDK's own
 * suggestions back with their destination forced to `session`, so nothing is written to the user's
 * settings files.
 */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly deps: BrokerDeps) {}

  ask(ask: PermissionAsk, signal?: AbortSignal): Promise<PermissionOutcome> {
    const request: PermissionRequest = {
      id: newId(),
      agentId: ask.agentId,
      taskId: ask.taskId,
      toolUseId: ask.toolUseId,
      tool: ask.tool,
      input: ask.input,
      title: ask.title ?? null,
      description: ask.description ?? null,
      hasSuggestions: Boolean(ask.suggestions?.length),
      status: 'pending',
      decision: null,
      message: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.persist(request);
    this.deps.onUpsert(request);
    return new Promise<PermissionOutcome>((resolve) => {
      const timeoutMs = this.deps.timeoutMs();
      const timer =
        timeoutMs > 0
          ? setTimeout(() => this.finish(request.id, 'timeout', 'No decision in time'), timeoutMs)
          : null;
      this.pending.set(request.id, { request, suggestions: ask.suggestions ?? [], resolve, timer });
      signal?.addEventListener(
        'abort',
        () => this.finish(request.id, 'timeout', 'Request aborted'),
        { once: true },
      );
    });
  }

  /** Called by the REST route. Returns false when the request is unknown or already resolved. */
  resolve(id: string, decision: 'allow' | 'allow_session' | 'deny', message?: string): boolean {
    if (!this.pending.has(id)) return false;
    this.finish(id, decision, message);
    return true;
  }

  listPending(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  pendingForAgent(agentId: string): PermissionRequest[] {
    return this.listPending().filter((r) => r.agentId === agentId);
  }

  /** Deny everything outstanding for an agent (stop / kill switch). */
  cancelForAgent(agentId: string, reason = 'Agent stopped'): void {
    for (const p of [...this.pending.values()])
      if (p.request.agentId === agentId) this.finish(p.request.id, 'deny', reason);
  }

  private finish(id: string, decision: PermissionDecision, message?: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    const request: PermissionRequest = {
      ...p.request,
      status: 'resolved',
      decision,
      message: message ?? null,
      resolvedAt: Date.now(),
    };
    this.persist(request);
    this.deps.onUpsert(request);
    const result: PermissionResult =
      decision === 'allow'
        ? { behavior: 'allow' }
        : decision === 'allow_session'
          ? { behavior: 'allow', updatedPermissions: p.suggestions.map(sessionScoped) }
          : {
              behavior: 'deny',
              message:
                message ??
                (decision === 'timeout' ? 'Permission request timed out' : 'Denied by the user'),
            };
    p.resolve({ decision, result, message });
  }

  private persist(request: PermissionRequest): void {
    const json = JSON.stringify(PermissionRequestSchema.parse(request));
    this.deps.db
      .insert(permissionRequests)
      .values({
        id: request.id,
        agentId: request.agentId,
        status: request.status,
        json,
        createdAt: request.createdAt,
      })
      .onConflictDoUpdate({ target: permissionRequests.id, set: { status: request.status, json } })
      .run();
  }

  /** Requests left pending by a previous process are marked timed out on boot. */
  static reconcileOnBoot(db: Db): void {
    const rows = db
      .select()
      .from(permissionRequests)
      .where(eq(permissionRequests.status, 'pending'))
      .all();
    for (const r of rows) {
      const parsed = PermissionRequestSchema.safeParse(JSON.parse(r.json));
      if (!parsed.success) continue;
      const req: PermissionRequest = {
        ...parsed.data,
        status: 'resolved',
        decision: 'timeout',
        message: 'Server restarted',
        resolvedAt: Date.now(),
      };
      db.update(permissionRequests)
        .set({ status: 'resolved', json: JSON.stringify(req) })
        .where(eq(permissionRequests.id, r.id))
        .run();
    }
  }
}

export function sessionScoped(update: PermissionUpdate): PermissionUpdate {
  return { ...update, destination: 'session' };
}
