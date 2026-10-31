// @vitest-environment happy-dom
import { AgentSchema, emptyUsage, type UsageSnapshot } from '@deskhaven/shared';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/ui/AvatarPicker.js', () => ({ AvatarPreview: () => null }));
vi.mock('../src/ui/AgentForm.js', () => ({ AgentForm: () => <form aria-label="hire form" /> }));

import { useAppStore } from '../src/state/store.js';
import { AgentsPanel } from '../src/ui/AgentsPanel.js';

const ada = AgentSchema.parse({
  id: 'ada',
  name: 'Ada',
  avatar: { skin: '#fff', hair: '#000', shirt: '#f00', pants: '#00f' },
  rolePresetId: 'engineer',
  systemPrompt: '',
  model: 'm',
  tools: null,
  allowedTools: [],
  permissionMode: 'default',
  workdir: '/repo',
  worktree: null,
  sessionId: null,
  status: 'idle',
  roomId: 'lobby',
  deskId: null,
  budget: {},
  currentTaskId: null,
  usage: { ...emptyUsage(), costUsd: 1.2 },
  lastError: null,
  createdAt: 1,
  updatedAt: 1,
});

const snapshot = (today: number, perAgentToday: Record<string, number>): UsageSnapshot => ({
  authModeInUse: 'API_KEY',
  totals: { ...emptyUsage(), costUsd: 2 },
  today: { ...emptyUsage(), costUsd: today },
  perAgent: {},
  perAgentToday: Object.fromEntries(
    Object.entries(perAgentToday).map(([k, v]) => [k, { ...emptyUsage(), costUsd: v }]),
  ),
  rateLimits: [],
  killSwitch: false,
  running: 0,
  concurrencyCap: 4,
});

describe('AgentsPanel', () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ agents: {}, usage: null, connection: 'closed' });
  });

  it('does not open the hire form while the agent list is still loading', () => {
    useAppStore.setState({ connection: 'open', usage: null, agents: {} });
    render(<AgentsPanel />);
    expect(screen.queryByRole('form', { name: 'hire form' })).toBeNull();
    act(() => {
      useAppStore.setState({ usage: snapshot(0, { ada: 0 }), agents: { ada } });
    });
    expect(screen.queryByRole('form', { name: 'hire form' })).toBeNull();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeTruthy();
  });

  it('opens the hire form for an empty office', () => {
    useAppStore.setState({ connection: 'open', usage: snapshot(0, {}), agents: {} });
    render(<AgentsPanel />);
    expect(screen.getByRole('form', { name: 'hire form' })).toBeTruthy();
  });

  it("shows each agent's cost today and what fired agents spent", () => {
    useAppStore.setState({
      connection: 'open',
      usage: snapshot(0.6996, { ada: 0.5 }),
      agents: { ada },
    });
    render(<AgentsPanel />);
    expect(screen.getByTitle(/all time: \$1\.20\)/).textContent).toBe('$0.5000');
    expect(screen.getByText(/no longer on staff: \$0\.1996 today/)).toBeTruthy();
  });
});
