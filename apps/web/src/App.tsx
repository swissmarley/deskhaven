import { type JSX, useEffect } from 'react';
import { WsClient, wsUrl } from './net/ws.js';
import { useAppStore } from './state/store.js';

export function App(): JSX.Element {
  const connection = useAppStore((s) => s.connection);
  const serverVersion = useAppStore((s) => s.serverVersion);

  useEffect(() => {
    const client = new WsClient({
      url: wsUrl(),
      onMessage: (m) => useAppStore.getState().applyServerMessage(m),
      onState: (c) => useAppStore.getState().setConnection(c),
    });
    client.connect();
    return () => client.close();
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">AgentHotel</span>
        <span className="status">
          <span
            className={`dot ${connection === 'open' ? 'ok' : connection === 'closed' ? 'bad' : ''}`}
          />
          {connection}
          {serverVersion ? ` · server ${serverVersion}` : ''}
        </span>
      </header>
      <main className="stage" id="stage" />
      <aside className="side">
        <p className="muted">M0 scaffold. The isometric room arrives in M1.</p>
      </aside>
    </div>
  );
}
