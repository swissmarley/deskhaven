import type {
  Agent,
  AgentEvent,
  AuthStatus,
  CreateAgent,
  CreateTask,
  PermissionRequest,
  RolePreset,
  Settings,
  Task,
  UpdateAgent,
  UpdateTask,
  UsageSnapshot,
} from '@agenthotel/shared';

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as {
        error?: string;
        issues?: { message: string; path: unknown[] }[];
      };
      if (j.issues?.length)
        message = j.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      else if (j.error) message = j.error;
    } catch {
      // keep status text
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  authStatus: () => call<AuthStatus>('GET', '/api/auth/status'),
  storeApiKey: (key: string) => call<{ stored: boolean }>('POST', '/api/auth/api-key', { key }),
  clearApiKey: () => call<{ stored: boolean }>('DELETE', '/api/auth/api-key'),
  settings: () => call<Settings>('GET', '/api/settings'),
  updateSettings: (patch: Partial<Settings>) => call<Settings>('PATCH', '/api/settings', patch),
  agents: () => call<Agent[]>('GET', '/api/agents'),
  createAgent: (input: CreateAgent) => call<Agent>('POST', '/api/agents', input),
  updateAgent: (id: string, patch: UpdateAgent) => call<Agent>('PATCH', `/api/agents/${id}`, patch),
  deleteAgent: (id: string, force = false) =>
    call<{ ok: true }>('DELETE', `/api/agents/${id}${force ? '?force=true' : ''}`),
  savePreset: (id: string, preset: unknown) =>
    call<RolePreset>('PUT', `/api/presets/${id}`, preset),
  resetPreset: (id: string) => call<{ preset: RolePreset | null }>('DELETE', `/api/presets/${id}`),
  tasks: () => call<Task[]>('GET', '/api/tasks'),
  createTask: (input: CreateTask) => call<Task>('POST', '/api/tasks', input),
  updateTask: (id: string, patch: UpdateTask) => call<Task>('PATCH', `/api/tasks/${id}`, patch),
  deleteTask: (id: string) => call<{ ok: true }>('DELETE', `/api/tasks/${id}`),
  assignTask: (id: string, agentId: string) =>
    call<Task>('POST', `/api/tasks/${id}/assign`, { agentId }),
  nudgeTask: (id: string, text: string) =>
    call<{ ok: true }>('POST', `/api/tasks/${id}/nudge`, { text }),
  sampleInit: () => call<{ path: string }>('POST', '/api/sample/init'),
  agentAction: (id: string, action: 'start' | 'stop' | 'pause' | 'resume' | 'interrupt') =>
    call<{ status?: string }>('POST', `/api/agents/${id}/${action}`),
  message: (id: string, text: string) =>
    call<{ ok: true }>('POST', `/api/agents/${id}/message`, { text }),
  events: (q: { agentId?: string; sinceSeq?: number; limit?: number; asc?: boolean }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    return call<AgentEvent[]>('GET', `/api/events?${params}`);
  },
  permissions: () => call<PermissionRequest[]>('GET', '/api/permissions'),
  resolvePermission: (id: string, decision: 'allow' | 'allow_session' | 'deny', message?: string) =>
    call<{ ok: true }>('POST', `/api/permissions/${id}/resolve`, { decision, message }),
  usage: () => call<UsageSnapshot>('GET', '/api/usage'),
  presets: () => call<RolePreset[]>('GET', '/api/presets'),
  models: () => call<{ id: string; label: string }[]>('GET', '/api/models'),
  kill: () => call<{ killSwitch: boolean }>('POST', '/api/kill'),
  resetKill: () => call<{ killSwitch: boolean }>('POST', '/api/kill/reset'),
};
