import { type Behavior, defaultRoom } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import { buildGrid, isWalkable, tileKey } from '../src/game/grid.js';
import { mulberry32 } from '../src/game/rng.js';
import { resolveStation } from '../src/game/stations.js';

describe('resolveStation on the default room', () => {
  const room = defaultRoom(0);
  const grid = buildGrid(room);
  const none = new Set<string>();
  const me = { id: 'a1', deskId: 'desk-1', tile: { x: 7, y: 6 }, facing: 2 as const };

  it('typing goes to the own desk seat, facing the desk', () => {
    const t = resolveStation(room, { kind: 'typing', label: 'x' }, me, none, { grid });
    expect(t).toEqual({ x: 2, y: 2, facing: 0, seated: true, furnitureId: 'desk-1' });
  });

  it('falls back to a free desk seat when the own desk is missing or taken', () => {
    const noDesk = resolveStation(
      room,
      { kind: 'working', label: 'x' },
      { ...me, deskId: null },
      none,
      {
        grid,
      },
    );
    expect(noDesk?.seated).toBe(true);
    expect(noDesk?.furnitureId).toMatch(/^desk-/);
    const taken = new Set([tileKey(2, 2)]);
    const other = resolveStation(room, { kind: 'typing', label: 'x' }, me, taken, { grid });
    expect(other?.furnitureId).not.toBe('desk-1');
    expect(other?.seated).toBe(true);
  });

  it('reading goes to the nearest free bookshelf stand tile', () => {
    const t = resolveStation(room, { kind: 'reading', label: 'x' }, me, none, { grid });
    expect(t?.furnitureId).toBe('bookshelf-1');
    expect(t?.seated).toBe(false);
    expect(t?.facing).toBe(0);
    expect([tileKey(11, 1), tileKey(12, 1)]).toContain(tileKey(t?.x ?? -1, t?.y ?? -1));
    // Nearest from (7,6) is (11,1); when it is taken the other slot is used.
    expect(t).toMatchObject({ x: 11, y: 1 });
    const t2 = resolveStation(
      room,
      { kind: 'reading', label: 'x' },
      me,
      new Set([tileKey(11, 1)]),
      {
        grid,
      },
    );
    expect(t2).toMatchObject({ x: 12, y: 1 });
  });

  it('terminal goes to a walkable server-rack stand tile', () => {
    const t = resolveStation(room, { kind: 'terminal', command: 'ls' }, me, none, { grid });
    // Both racks expose a stand tile: rack-1 → (13,3), rack-2 → (13,5). The nearest free one wins.
    expect(t?.facing).toBe(0);
    expect(t?.seated).toBe(false);
    expect([tileKey(13, 3), tileKey(13, 5)]).toContain(tileKey(t?.x ?? -1, t?.y ?? -1));
    const taken = new Set([tileKey(t?.x ?? -1, t?.y ?? -1)]);
    const t2 = resolveStation(room, { kind: 'terminal', command: 'ls' }, me, taken, { grid });
    expect(t2?.furnitureId).not.toBe(t?.furnitureId);
  });

  it('browsing, delegating, coffee, sofa and leave resolve to their stations', () => {
    const browse = resolveStation(room, { kind: 'browsing', query: 'q' }, me, none, { grid });
    expect(browse).toEqual({ x: 11, y: 4, facing: 0, seated: true, furnitureId: 'library-1' });
    const deleg = resolveStation(room, { kind: 'delegating', label: 'x' }, me, none, { grid });
    expect(deleg?.furnitureId).toBe('whiteboard-1');
    const coffee = resolveStation(room, { kind: 'idle', variant: 'coffee' }, me, none, { grid });
    expect(coffee?.furnitureId).toBe('coffee-1');
    expect([tileKey(12, 8), tileKey(13, 7)]).toContain(tileKey(coffee?.x ?? -1, coffee?.y ?? -1));
    const sofa = resolveStation(room, { kind: 'idle', variant: 'sofa' }, me, none, { grid });
    expect(sofa?.furnitureId).toBe('sofa-1');
    expect(sofa?.seated).toBe(true);
    expect(sofa?.facing).toBe(2);
    const leave = resolveStation(room, { kind: 'leave' }, me, none, { grid });
    expect(leave).toEqual({ x: 0, y: 9, facing: 2, seated: false, furnitureId: 'door-1' });
  });

  it('stay keeps the current tile and facing', () => {
    for (const b of [
      { kind: 'thinking' },
      { kind: 'raise_hand', reason: 'permission' },
      { kind: 'celebrate' },
    ] satisfies Behavior[]) {
      expect(resolveStation(room, b, me, none, { grid })).toEqual({
        x: 7,
        y: 6,
        facing: 2,
        seated: false,
        furnitureId: null,
      });
    }
  });

  it('roam picks a deterministic walkable tile at least 3 tiles away', () => {
    const a = resolveStation(room, { kind: 'idle', variant: 'wander' }, me, none, {
      grid,
      rng: mulberry32(42),
    });
    const b = resolveStation(room, { kind: 'idle', variant: 'wander' }, me, none, {
      grid,
      rng: mulberry32(42),
    });
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
    expect(isWalkable(grid, a?.x ?? -1, a?.y ?? -1)).toBe(true);
    expect(Math.max(Math.abs((a?.x ?? 0) - 7), Math.abs((a?.y ?? 0) - 6))).toBeGreaterThanOrEqual(
      3,
    );
    expect(a?.seated).toBe(false);
  });

  it('returns null when no station exists', () => {
    const bare = { ...room, furniture: [] };
    expect(resolveStation(bare, { kind: 'reading', label: 'x' }, me, none)).toBeNull();
  });
});
