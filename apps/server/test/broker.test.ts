import type { PermissionRequest } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import { PermissionBroker, sessionScoped } from '../src/agent/permission-broker.js';
import { openDb } from '../src/db/client.js';

function makeBroker(timeoutMs = 0) {
  const { db } = openDb(':memory:');
  const upserts: PermissionRequest[] = [];
  const broker = new PermissionBroker({
    db,
    timeoutMs: () => timeoutMs,
    onUpsert: (r) => upserts.push(r),
  });
  return { broker, upserts, db };
}
const ask = {
  agentId: 'a1',
  taskId: null,
  toolUseId: 't1',
  tool: 'Bash',
  input: { command: 'rm -rf dist' },
  title: 'Run rm -rf dist?',
};

describe('PermissionBroker', () => {
  it('resolves allow / deny and reports pending requests', async () => {
    const { broker, upserts } = makeBroker();
    const p = broker.ask(ask);
    expect(broker.listPending()).toHaveLength(1);
    const id = broker.listPending()[0]?.id ?? '';
    expect(upserts[0]).toMatchObject({
      status: 'pending',
      tool: 'Bash',
      title: 'Run rm -rf dist?',
    });
    expect(broker.resolve(id, 'allow')).toBe(true);
    const out = await p;
    expect(out.decision).toBe('allow');
    expect(out.result).toEqual({ behavior: 'allow' });
    expect(broker.listPending()).toHaveLength(0);
    expect(broker.resolve(id, 'allow')).toBe(false);

    const p2 = broker.ask({ ...ask, toolUseId: 't2' });
    broker.resolve(broker.listPending()[0]?.id ?? '', 'deny', 'not today');
    expect((await p2).result).toEqual({ behavior: 'deny', message: 'not today' });
  });

  it('scopes "allow for this session" suggestions to the session', async () => {
    const { broker } = makeBroker();
    const p = broker.ask({
      ...ask,
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    });
    broker.resolve(broker.listPending()[0]?.id ?? '', 'allow_session');
    const out = await p;
    expect(out.result).toEqual({
      behavior: 'allow',
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    });
    expect(
      sessionScoped({ type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }),
    ).toEqual({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
  });

  it('times out into a deny and honours abort signals', async () => {
    const { broker } = makeBroker(10);
    const out = await broker.ask(ask);
    expect(out.decision).toBe('timeout');
    expect(out.result).toMatchObject({ behavior: 'deny' });

    const { broker: b2 } = makeBroker();
    const ac = new AbortController();
    const p = b2.ask(ask, ac.signal);
    ac.abort();
    expect((await p).decision).toBe('timeout');
  });

  it('cancels every pending request of an agent', async () => {
    const { broker } = makeBroker();
    const p1 = broker.ask(ask);
    const p2 = broker.ask({ ...ask, agentId: 'other', toolUseId: 't9' });
    broker.cancelForAgent('a1');
    expect((await p1).result).toMatchObject({ behavior: 'deny', message: 'Agent stopped' });
    expect(broker.listPending().map((r) => r.agentId)).toEqual(['other']);
    broker.resolve(broker.listPending()[0]?.id ?? '', 'allow');
    await p2;
  });
});
