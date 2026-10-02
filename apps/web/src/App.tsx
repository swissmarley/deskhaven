import { type JSX, useEffect } from 'react';
import { WsClient, wsUrl } from './net/ws.js';
import { useAppStore } from './state/store.js';
import { GameCanvas } from './ui/GameCanvas.js';
import { Notices } from './ui/Notices.js';
import { PermissionModal } from './ui/PermissionModal.js';
import { SidePanel } from './ui/SidePanel.js';
import { TopBar } from './ui/TopBar.js';

export function App(): JSX.Element {
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
      <TopBar />
      <main className="stage">
        <GameCanvas />
      </main>
      <SidePanel />
      <PermissionModal />
      <Notices />
    </div>
  );
}
