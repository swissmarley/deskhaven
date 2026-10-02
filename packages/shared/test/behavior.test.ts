import { describe, expect, it } from 'vitest';
import {
  type Behavior,
  type BehaviorContext,
  IDLE,
  idleVariant,
  mapEventToBehavior,
  stationForBehavior,
  THINKING,
} from '../src/behavior.js';
import type { AgentEvent } from '../src/events.js';
import { AgentEventSchema } from '../src/events.js';

const base = { id: 'e1', ts: 1, agentId: 'a1' };
const ctx = (over: Partial<BehaviorContext> = {}): BehaviorContext => ({
  current: IDLE,
  hasOpenTool: false,
  seed: 0,
  ...over,
});

function ev<T extends AgentEvent['type']>(
  type: T,
  fields: Omit<Extract<AgentEvent, { type: T }>, 'type' | keyof typeof base>,
): Extract<AgentEvent, { type: T }> {
  const e = { ...base, type, ...fields } as Extract<AgentEvent, { type: T }>;
  AgentEventSchema.parse(e);
  return e;
}

describe('mapEventToBehavior', () => {
  it('maps read tools to the bookshelf', () => {
    const b = mapEventToBehavior(
      ev('tool_started', {
        toolUseId: 't1',
        tool: 'Read',
        category: 'read',
        input: {},
        summary: 'README.md',
      }),
      ctx(),
    );
    expect(b).toEqual<Behavior>({ kind: 'reading', label: 'README.md' });
    expect(stationForBehavior(b)).toBe('bookshelf');
  });

  it('maps Grep and Glob to reading too', () => {
    for (const tool of ['Grep', 'Glob']) {
      const b = mapEventToBehavior(
        ev('tool_started', { toolUseId: 't', tool, category: 'read', input: {}, summary: 'x' }),
        ctx(),
      );
      expect(b.kind).toBe('reading');
    }
  });

  it('maps Edit/Write to typing at own desk', () => {
    const b = mapEventToBehavior(
      ev('tool_started', {
        toolUseId: 't2',
        tool: 'Edit',
        category: 'edit',
        input: {},
        summary: 'src/a.ts',
      }),
      ctx(),
    );
    expect(b).toEqual<Behavior>({ kind: 'typing', label: 'src/a.ts' });
    expect(stationForBehavior(b)).toBe('own_desk');
  });

  it('maps Bash to the server rack with the command', () => {
    const b = mapEventToBehavior(
      ev('tool_started', {
        toolUseId: 't3',
        tool: 'Bash',
        category: 'bash',
        input: {},
        summary: 'pnpm test',
      }),
      ctx(),
    );
    expect(b).toEqual<Behavior>({ kind: 'terminal', command: 'pnpm test' });
    expect(stationForBehavior(b)).toBe('server_rack');
  });

  it('maps WebSearch/WebFetch to the library computer', () => {
    const b = mapEventToBehavior(
      ev('tool_started', {
        toolUseId: 't4',
        tool: 'WebSearch',
        category: 'web',
        input: {},
        summary: 'pixi v8',
      }),
      ctx(),
    );
    expect(b).toEqual<Behavior>({ kind: 'browsing', query: 'pixi v8' });
    expect(stationForBehavior(b)).toBe('library_pc');
  });

  it('streams text without an open tool as thinking; keeps the tool pose while a tool is open', () => {
    expect(mapEventToBehavior(ev('text_delta', { text: 'hm' }), ctx())).toEqual(THINKING);
    const reading: Behavior = { kind: 'reading', label: 'x' };
    expect(
      mapEventToBehavior(
        ev('text_delta', { text: 'hm' }),
        ctx({ current: reading, hasOpenTool: true }),
      ),
    ).toBe(reading);
  });

  it('raises a hand on permission requests and on AskUserQuestion / ExitPlanMode', () => {
    expect(
      mapEventToBehavior(
        ev('permission_requested', {
          requestId: 'r',
          toolUseId: 't',
          tool: 'Bash',
          category: 'bash',
          input: {},
          hasSuggestions: true,
        }),
        ctx(),
      ),
    ).toEqual<Behavior>({ kind: 'raise_hand', reason: 'permission' });
    expect(
      mapEventToBehavior(
        ev('tool_started', {
          toolUseId: 't',
          tool: 'AskUserQuestion',
          category: 'ask',
          input: {},
          summary: '',
        }),
        ctx(),
      ),
    ).toEqual<Behavior>({ kind: 'raise_hand', reason: 'question' });
    expect(
      mapEventToBehavior(
        ev('tool_started', {
          toolUseId: 't',
          tool: 'ExitPlanMode',
          category: 'plan',
          input: {},
          summary: '',
        }),
        ctx(),
      ),
    ).toEqual<Behavior>({ kind: 'raise_hand', reason: 'plan' });
  });

  it('returns to the tool pose after an allow, thinking after a deny', () => {
    const hand: Behavior = { kind: 'raise_hand', reason: 'permission' };
    expect(
      mapEventToBehavior(
        ev('permission_resolved', {
          requestId: 'r',
          tool: 'Bash',
          category: 'bash',
          decision: 'allow',
        }),
        ctx({ current: hand }),
      ),
    ).toMatchObject({ kind: 'terminal' });
    expect(
      mapEventToBehavior(
        ev('permission_resolved', {
          requestId: 'r',
          tool: 'Bash',
          category: 'bash',
          decision: 'deny',
        }),
        ctx({ current: hand }),
      ),
    ).toEqual(THINKING);
  });

  it('shows interns as delegating', () => {
    expect(
      mapEventToBehavior(
        ev('subagent_started', { subagentId: 's', subagentType: 'Explore' }),
        ctx(),
      ),
    ).toEqual<Behavior>({
      kind: 'delegating',
      label: 'Explore',
    });
  });

  it('sweats on failures and auth/rate-limit errors with distinct reasons', () => {
    expect(
      mapEventToBehavior(
        ev('tool_failed', { toolUseId: 't', tool: 'Bash', category: 'bash', error: 'exit 1' }),
        ctx(),
      ),
    ).toEqual<Behavior>({
      kind: 'sweat',
      reason: 'tool_failed',
      message: 'exit 1',
    });
    expect(
      mapEventToBehavior(ev('error', { kind: 'auth', status: 401, message: 'nope' }), ctx()),
    ).toMatchObject({ kind: 'sweat', reason: 'auth' });
    expect(
      mapEventToBehavior(ev('error', { kind: 'rate_limit', status: 429, message: 'slow' }), ctx()),
    ).toMatchObject({ kind: 'sweat', reason: 'rate_limit' });
    expect(
      mapEventToBehavior(ev('error', { kind: 'billing', message: 'pay' }), ctx()),
    ).toMatchObject({ kind: 'sweat', reason: 'billing' });
  });

  it('cools down only when a plan window is rejected', () => {
    expect(
      mapEventToBehavior(ev('rate_limit', { status: 'rejected', resetsAt: 5 }), ctx()),
    ).toEqual<Behavior>({ kind: 'cooldown', resetsAt: 5 });
    expect(
      mapEventToBehavior(
        ev('rate_limit', { status: 'allowed_warning' }),
        ctx({ current: THINKING }),
      ),
    ).toEqual(THINKING);
  });

  it('celebrates when a task turn completes, idles otherwise', () => {
    const done = {
      ok: true,
      subtype: 'success',
      costUsd: 0.1,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      numTurns: 1,
      durationMs: 10,
    };
    expect(
      mapEventToBehavior(ev('turn_completed', { ...done, taskId: 'task1' }), ctx()),
    ).toEqual<Behavior>({ kind: 'celebrate' });
    expect(mapEventToBehavior(ev('turn_completed', done), ctx({ seed: 1 }))).toEqual(
      idleVariant(1),
    );
    expect(
      mapEventToBehavior(
        ev('turn_completed', { ...done, ok: false, subtype: 'error_max_turns' }),
        ctx(),
      ),
    ).toMatchObject({ kind: 'sweat' });
  });

  it('maps lifecycle statuses', () => {
    expect(mapEventToBehavior(ev('status', { status: 'paused' }), ctx())).toEqual<Behavior>({
      kind: 'nap',
    });
    expect(mapEventToBehavior(ev('status', { status: 'stopped' }), ctx())).toEqual<Behavior>({
      kind: 'wait',
    });
    expect(mapEventToBehavior(ev('status', { status: 'waiting' }), ctx())).toEqual<Behavior>({
      kind: 'wait',
    });
    expect(mapEventToBehavior(ev('status', { status: 'needs_input' }), ctx())).toEqual<Behavior>({
      kind: 'raise_hand',
      reason: 'input',
    });
  });

  it('idle variants are deterministic in the seed', () => {
    expect(idleVariant(0)).toEqual({ kind: 'idle', variant: 'wander' });
    expect(idleVariant(1)).toEqual({ kind: 'idle', variant: 'sofa' });
    expect(idleVariant(2)).toEqual({ kind: 'idle', variant: 'coffee' });
    expect(idleVariant(3)).toEqual(idleVariant(0));
  });

  it('ignores unknown events', () => {
    const cur: Behavior = { kind: 'reading', label: 'a' };
    expect(mapEventToBehavior(ev('unknown', { raw: 'weird' }), ctx({ current: cur }))).toBe(cur);
  });
});
