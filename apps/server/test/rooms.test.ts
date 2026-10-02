import { DEFAULT_ROOM_ID, defaultRoom } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import type { AgentService } from '../src/agents/service.js';
import { openDb } from '../src/db/client.js';
import { RoomService } from '../src/rooms/service.js';
import { WsHub } from '../src/ws/hub.js';

describe('RoomService', () => {
  it('seeds the lobby, validates saves, clears orphaned desks and resets', () => {
    const { db } = openDb(':memory:');
    const hub = new WsHub();
    const patched: string[] = [];
    const agents = {
      list: () => [{ id: 'a1', roomId: DEFAULT_ROOM_ID, deskId: 'desk-1' }],
      patch: (id: string) => {
        patched.push(id);
        return undefined;
      },
    } as unknown as AgentService;
    const svc = new RoomService(db, hub, () => agents);
    const lobby = svc.get(DEFAULT_ROOM_ID);
    expect(lobby?.furniture.length).toBe(defaultRoom().furniture.length);
    expect(svc.list()).toHaveLength(1);

    expect(() =>
      svc.save({ ...lobby, furniture: lobby?.furniture.filter((f) => f.kind !== 'door') }),
    ).toThrow(/needs a door/);

    const withoutDesk1 = { ...lobby, furniture: lobby?.furniture.filter((f) => f.id !== 'desk-1') };
    const saved = svc.save(withoutDesk1);
    expect(saved.furniture.some((f) => f.id === 'desk-1')).toBe(false);
    expect(patched).toEqual(['a1']);
    expect(svc.get(DEFAULT_ROOM_ID)?.furniture.some((f) => f.id === 'desk-1')).toBe(false);

    const reset = svc.reset(DEFAULT_ROOM_ID);
    expect(reset.furniture.some((f) => f.id === 'desk-1')).toBe(true);
    expect(() => svc.reset('other')).toThrow();
  });
});
