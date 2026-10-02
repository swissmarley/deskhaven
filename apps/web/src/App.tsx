import { type JSX, useEffect } from 'react';
import { WsClient, wsUrl } from './net/ws.js';
import { useAppStore } from './state/store.js';
import { BoardPanel } from './ui/BoardPanel.js';
import { GameCanvas } from './ui/GameCanvas.js';
import { Notices } from './ui/Notices.js';
import { Onboarding } from './ui/Onboarding.js';
import { PermissionModal } from './ui/PermissionModal.js';
import { SidePanel } from './ui/SidePanel.js';
import { TopBar } from './ui/TopBar.js';

export function App(): JSX.Element {
  const boardOpen = useAppStore((s) => s.boardOpen);
  useEffect(() => {
    const client = new WsClient({
      url: wsUrl(),
      onMessage: (m) => useAppStore.getState().applyServerMessage(m),
      onState: (c) => useAppStore.getState().setConnection(c),
    });
    client.connect();
    useAppStore.setState({ requestResync: () => client.send({ type: 'hello' }) });
    return () => client.close();
  }, []);

  return (
    <div className={`app ${boardOpen ? 'with-board' : ''}`}>
      <TopBar />
      <main className="stage">
        <GameCanvas />
      </main>
      <SidePanel />
      {boardOpen ? <BoardPanel /> : null}
      <PermissionModal />
      <Onboarding />
      <Notices />
    </div>
  );
}
