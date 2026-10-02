import { type ServerMessage, ServerMessageSchema } from '@agenthotel/shared';
import type { WebSocket } from 'ws';

/** Fan-out of validated server messages to every connected browser. */
export class WsHub {
  private readonly clients = new Set<WebSocket>();

  add(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  size(): number {
    return this.clients.size;
  }

  send(socket: WebSocket, message: ServerMessage): void {
    const payload = JSON.stringify(ServerMessageSchema.parse(message));
    if (socket.readyState === socket.OPEN) socket.send(payload);
  }

  broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(ServerMessageSchema.parse(message));
    for (const c of this.clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  }
}
