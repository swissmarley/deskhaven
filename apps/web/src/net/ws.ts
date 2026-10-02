import { type ClientMessage, type ServerMessage, ServerMessageSchema } from '@agenthotel/shared';

export type ConnectionState = 'connecting' | 'open' | 'closed';

export interface WsClientOptions {
  url: string;
  onMessage: (message: ServerMessage) => void;
  onState: (state: ConnectionState) => void;
}

const PING_EVERY_MS = 15_000;
const PONG_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 5_000;

/**
 * Reconnecting WebSocket client that validates every inbound message. A ping/pong heartbeat detects
 * sockets that died silently (for example when the dev server restarts behind the Vite proxy).
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempt = 0;
  private pingTimer: number | null = null;
  private pongTimer: number | null = null;
  private reconnectTimer: number | null = null;

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
    this.clearTimers();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    const s = this.socket;
    this.socket = null;
    if (!s) return;
    // Closing a CONNECTING socket logs a browser warning; let it open and close it then instead.
    if (s.readyState === WebSocket.CONNECTING) s.onopen = () => s.close();
    else s.close();
  }

  private open(): void {
    this.opts.onState('connecting');
    const socket = new WebSocket(this.opts.url);
    this.socket = socket;
    socket.onopen = () => {
      if (this.closed) {
        socket.close();
        return;
      }
      this.attempt = 0;
      this.opts.onState('open');
      this.send({ type: 'hello' });
      this.startHeartbeat();
    };
    socket.onmessage = (ev) => {
      try {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(String(ev.data)));
        if (!parsed.success) {
          console.warn('dropped invalid server message', parsed.error.issues[0]);
          return;
        }
        if (parsed.data.type === 'pong') {
          if (this.pongTimer) window.clearTimeout(this.pongTimer);
          this.pongTimer = null;
          return;
        }
        this.opts.onMessage(parsed.data);
      } catch (err) {
        console.warn('bad ws payload', err);
      }
    };
    socket.onclose = () => {
      this.clearTimers();
      if (this.socket === socket) this.socket = null;
      this.opts.onState('closed');
      if (this.closed) return;
      const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempt++);
      this.reconnectTimer = window.setTimeout(() => this.open(), delay);
    };
    socket.onerror = () => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
        socket.close();
    };
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.pingTimer = window.setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      this.send({ type: 'ping' });
      this.pongTimer = window.setTimeout(() => {
        console.warn('ws heartbeat timed out; reconnecting');
        this.socket?.close();
      }, PONG_TIMEOUT_MS);
    }, PING_EVERY_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    if (this.pongTimer) window.clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }
}

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
