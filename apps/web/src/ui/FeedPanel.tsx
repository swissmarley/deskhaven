import type { JSX } from 'react';
import { useEffect, useRef } from 'react';
import { useAppStore } from '../state/store.js';
import { describeEvent, fmtTime } from './eventText.js';

export function FeedPanel(): JSX.Element {
  const feed = useAppStore((s) => s.feed);
  const agents = useAppStore((s) => s.agents);
  const selectAgent = useAppStore((s) => s.selectAgent);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, []);

  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Activity</h3>
        <span className="muted small">{feed.length} events</span>
      </div>
      <div className="feed">
        {feed.slice(-400).map((e) => {
          const d = describeEvent(e);
          if (!d.text) return null;
          return (
            <div key={e.id} className={`feed-line tone-${d.tone}`}>
              <span className="t-time">{fmtTime(e.ts)}</span>
              <button type="button" className="link name" onClick={() => selectAgent(e.agentId)}>
                {agents[e.agentId]?.name ?? 'agent'}
              </button>
              <span className="t-icon">{d.icon}</span>
              <span className="t-text">{d.text}</span>
            </div>
          );
        })}
        <div ref={end} />
      </div>
    </div>
  );
}
