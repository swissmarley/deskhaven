import { type ClientMessage, type ServerMessage, ServerMessageSchema } from '@agenthotel/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface WsClientOptions {
  url: string;
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
}

/** Small reconnecting WebSocket client that validates every inbound message. */
export class WsClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempt = 0;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    this.closed = false;
    this.open();
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
  }

  private open(): void {
    this.opts.onState('connecting');
    const socket = new WebSocket(this.opts.url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.opts.onState('open');
      this.send({ type: 'hello' });
    };
    socket.onmessage = (ev) => {
      try {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(String(ev.data)));
        if (parsed.success) this.opts.onMessage(parsed.data);
        else console.warn('dropped invalid server message', parsed.error.issues[0]);
      } catch (err) {
        console.warn('bad ws payload', err);
      }
    };
    socket.onclose = () => {
      this.opts.onState('closed');
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
      setTimeout(() => this.open(), delay);
    };
    socket.onerror = () => socket.close();
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
