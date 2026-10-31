import { describe, expect, it, vi } from 'vitest';
import { WsClient } from '../src/net/ws.js';

describe('WsClient hello', () => {
  it('asks only for the events after the last one the app applied', () => {
    let last = 0;
    const client = new WsClient({
      url: 'ws://x',
      onMessage: () => {},
      onState: () => {},
      lastSeq: () => last,
    });
    const send = vi.spyOn(client, 'send').mockImplementation(() => {});
    client.sendHello();
    expect(send).toHaveBeenLastCalledWith({ type: 'hello' });
    last = 42;
    client.sendHello();
    expect(send).toHaveBeenLastCalledWith({ type: 'hello', sinceSeq: 42 });
  });
});
