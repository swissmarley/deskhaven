import type { JSX } from 'react';
import { useAppStore } from '../state/store.js';
import { AgentsPanel } from './AgentsPanel.js';
import { EditorPanel } from './EditorPanel.js';
import { FeedPanel } from './FeedPanel.js';
import { InspectorPanel } from './InspectorPanel.js';
import { ReplayPanel } from './ReplayPanel.js';
import { SettingsPanel } from './SettingsPanel.js';

const TABS = [
  { id: 'agents', label: 'HR desk' },
  { id: 'inspector', label: 'Inspector' },
  { id: 'feed', label: 'Feed' },
  { id: 'room', label: 'Room' },
  { id: 'replay', label: 'Replay' },
  { id: 'settings', label: 'Settings' },
] as const;

export function SidePanel(): JSX.Element {
  const tab = useAppStore((s) => s.sideTab);
  const setTab = useAppStore((s) => s.setSideTab);
  const pending = useAppStore((s) => Object.keys(s.permissions).length);
  return (
    <aside className="side">
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.id === 'inspector' && pending ? <span className="badge">{pending}</span> : null}
          </button>
        ))}
      </nav>
      <div className="side-body">
        {tab === 'agents' ? <AgentsPanel /> : null}
        {tab === 'inspector' ? <InspectorPanel /> : null}
        {tab === 'feed' ? <FeedPanel /> : null}
        {tab === 'room' ? <EditorPanel /> : null}
        {tab === 'replay' ? <ReplayPanel /> : null}
        {tab === 'settings' ? <SettingsPanel /> : null}
        {tab === 'board' ? <p className="muted">Task board arrives in M4.</p> : null}
      </div>
    </aside>
  );
}
