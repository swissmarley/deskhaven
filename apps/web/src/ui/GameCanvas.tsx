import type { Avatar } from '@agenthotel/shared';
import { type JSX, useEffect, useRef } from 'react';
import { createWorld } from '../game/index.js';
import type { World } from '../game/types.js';
import { worldBus } from '../state/bus.js';
import { useAppStore } from '../state/store.js';
import { beep } from './sfx.js';
import { setWorldHandle } from './worldHandle.js';

const INTERN_AVATAR: Avatar = {
  skin: '#f1c27d',
  hair: '#6e6e6e',
  hairStyle: 'cap',
  shirt: '#9aa0b4',
  pants: '#4a4e69',
  accessory: 'none',
};

/** Mounts the Pixi world and keeps it in sync with the store without re-rendering React. */
export function GameCanvas(): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const worldRef = useRef<World | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const world = createWorld();
    worldRef.current = world;
    setWorldHandle(world);
    let disposed = false;
    const unsubs: (() => void)[] = [];

    void world.mount(el).then(() => {
      if (disposed) {
        world.destroy();
        return;
      }
      const store = useAppStore;
      let prevAgents = store.getState().agents;
      let prevRooms = store.getState().rooms;
      let prevBehaviors = store.getState().behaviors;

      const syncRoom = () => {
        const room = Object.values(store.getState().rooms)[0];
        if (room) world.setRoom(room);
      };
      const syncAgents = () => {
        const s = store.getState();
        for (const a of Object.values(s.agents))
          world.upsertAvatar({ id: a.id, name: a.name, avatar: a.avatar, deskId: a.deskId });
        for (const id of Object.keys(prevAgents)) if (!s.agents[id]) world.removeAvatar(id);
        prevAgents = s.agents;
      };
      const syncBehaviors = (force: boolean) => {
        const s = store.getState();
        for (const [id, b] of Object.entries(s.behaviors)) {
          if (force || prevBehaviors[id] !== b) world.applyBehavior(id, b);
        }
        prevBehaviors = s.behaviors;
      };
      syncRoom();
      syncAgents();
      syncBehaviors(true);

      unsubs.push(
        store.subscribe((s) => {
          if (s.rooms !== prevRooms) {
            prevRooms = s.rooms;
            syncRoom();
          }
          if (s.agents !== prevAgents) syncAgents();
          if (s.behaviors !== prevBehaviors) syncBehaviors(false);
        }),
      );
      unsubs.push(
        worldBus.on(({ event }) => {
          const sound = store.getState().soundEnabled;
          switch (event.type) {
            case 'assistant_text':
              if (!event.parentToolUseId)
                world.say(event.agentId, event.text, { kind: 'speech', durationMs: 6000 });
              break;
            case 'subagent_started':
              world.upsertAvatar({
                id: `intern:${event.subagentId}`,
                name: event.subagentType,
                avatar: INTERN_AVATAR,
                deskId: null,
                isIntern: true,
                parentId: event.agentId,
              });
              break;
            case 'subagent_stopped':
              world.removeAvatar(`intern:${event.subagentId}`);
              break;
            case 'permission_requested':
              if (sound) beep('alert');
              break;
            case 'turn_completed':
              if (sound) beep(event.ok ? 'ok' : 'error');
              break;
            case 'error':
              if (sound) beep('error');
              break;
            default:
              break;
          }
        }),
      );
      world.setEvents({
        onAvatarClick: (id) => {
          if (!id.startsWith('intern:')) store.getState().selectAgent(id);
        },
        onTileClick: (tile) => {
          const s = store.getState();
          const target = s.selectedAgentId ?? Object.keys(s.agents)[0];
          if (target) world.walkTo(target, tile);
        },
      });
    });

    return () => {
      disposed = true;
      for (const u of unsubs) u();
      world.destroy();
      worldRef.current = null;
      setWorldHandle(null);
    };
  }, []);

  return <div ref={host} className="canvas-host" />;
}
