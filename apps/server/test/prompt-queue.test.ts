import { describe, expect, it } from 'vitest';
import { createPromptQueue } from '../src/agent/sdk-adapter.js';

describe('createPromptQueue', () => {
  it('delivers pushed prompts in order and ends cleanly', async () => {
    const q = createPromptQueue();
    const it = q.iterable[Symbol.asyncIterator]();
    q.push('one');
    q.push('two');
    expect((await it.next()).value?.message.content).toBe('one');
    const pending = it.next(); // waits for the next push
    q.push('three');
    expect((await it.next()).value?.message.content).toBe('three');
    expect((await pending).value?.message.content).toBe('two');
    const tail = it.next();
    q.end();
    expect((await tail).done).toBe(true);
    expect(q.ended).toBe(true);
    q.push('ignored');
    expect((await it.next()).done).toBe(true);
  });

  it('builds SDK user messages', async () => {
    const q = createPromptQueue();
    q.push('hello');
    const r = await q.iterable[Symbol.asyncIterator]().next();
    expect(r.value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hello' },
      parent_tool_use_id: null,
    });
  });
});
