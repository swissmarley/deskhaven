import type { ServerMessage } from '@agenthotel/shared';
import { create } from 'zustand';
import type { ConnectionState } from '../net/ws.js';

export interface AppState {
  connection: ConnectionState;
  serverVersion: string | null;
  setConnection: (c: ConnectionState) => void;
  applyServerMessage: (m: ServerMessage) => void;
}

export const useAppStore = create<AppState>((set) => ({
  connection: 'closed',
  serverVersion: null,
  setConnection: (connection) => set({ connection }),
  applyServerMessage: (m) => {
    switch (m.type) {
      case 'hello':
        set({ serverVersion: m.version });
        break;
      default:
        break;
    }
  },
}));
