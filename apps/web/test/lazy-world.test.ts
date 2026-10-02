import { defaultRoom } from '@agenthotel/shared';
import { describe, expect, it } from 'vitest';
import { LazyWorld } from '../src/game/lazy-world.js';
import type { TilePoint, World, WorldAvatarInput } from '../src/game/types.js';
import type { WorldExtras } from '../src/game/world-extras.js';

const AVATAR: WorldAvatarInput = {
  id: 'a1',
  name: 'Ada',
  avatar: {
    skin: '#f1c27d',
    hair: '#6e6e6e',
    hairStyle: 'cap',
    shirt: '#9aa0b4',
    pants: '#4a4e69',
    accessory: 'none',
  },
  deskId: null,
};

class FakeWorld implements World, WorldExtras {
  readonly calls: string[] = [];
  destroyed = 0;
  mounted = 0;
  gridVisible = true;
  /** Resolved by the test to let `mount` finish. */
  release: () => void = () => {};

  mount(): Promise<void> {
    this.mounted++;
    this.calls.push('mount');
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
  destroy(): void {
    this.destroyed++;
    this.calls.push('destroy');
  }
  setRoom(): void {
    this.calls.push('setRoom');
  }
  upsertAvatar(input: WorldAvatarInput): void {
    this.calls.push(`upsertAvatar:${input.id}`);
  }
  removeAvatar(id: string): void {
    this.calls.push(`removeAvatar:${id}`);
  }
  applyBehavior(id: string): void {
    this.calls.push(`applyBehavior:${id}`);
  }
  walkTo(id: string, t: TilePoint): void {
    this.calls.push(`walkTo:${id}:${t.x},${t.y}`);
  }
  say(id: string, text: string): void {
    this.calls.push(`say:${id}:${text}`);
  }
  setEvents(): void {
    this.calls.push('setEvents');
  }
  getAvatarAt(t: TilePoint): string | null {
    this.calls.push(`getAvatarAt:${t.x},${t.y}`);
    return 'a1';
  }
  screenToTile(x: number, y: number): TilePoint | null {
    this.calls.push(`screenToTile:${x},${y}`);
    return { x: 3, y: 2 };
  }
  setHighlight(): void {
    this.calls.push('setHighlight');
  }
  setEditorMode(on: boolean): void {
    this.calls.push(`setEditorMode:${on}`);
  }
  setGhost(): void {
    this.calls.push('setGhost');
  }
  setGridVisible(v: boolean): void {
    this.gridVisible = v;
    this.calls.push(`setGridVisible:${v}`);
  }
}

const container = {} as HTMLElement;

function setup(): { lazy: LazyWorld; created: FakeWorld[] } {
  const created: FakeWorld[] = [];
  const lazy = new LazyWorld(async () => {
    const w = new FakeWorld();
    created.push(w);
    return w;
  });
  return { lazy, created };
}

/** Let the factory promise and the inner `mount` call settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function mountAndRelease(lazy: LazyWorld, created: FakeWorld[]): Promise<void> {
  const p = lazy.mount(container);
  await settle();
  created[0]?.release();
  await p;
}

describe('LazyWorld', () => {
  it('replays calls made before mount in FIFO order', async () => {
    const { lazy, created } = setup();
    lazy.setRoom(defaultRoom());
    lazy.upsertAvatar(AVATAR);
    lazy.applyBehavior('a1', { kind: 'thinking' });
    lazy.setEditorMode(true);
    lazy.setGridVisible(false);
    lazy.say('a1', 'hi');
    lazy.walkTo('a1', { x: 1, y: 2 });
    lazy.setEvents({});
    lazy.setHighlight(null);
    lazy.setGhost(null);
    lazy.removeAvatar('a1');
    expect(created).toHaveLength(0);

    await mountAndRelease(lazy, created);
    const inner = created[0];
    expect(inner).toBeDefined();
    expect(inner?.calls).toEqual([
      'mount',
      'setRoom',
      'upsertAvatar:a1',
      'applyBehavior:a1',
      'setEditorMode:true',
      'setGridVisible:false',
      'say:a1:hi',
      'walkTo:a1:1,2',
      'setEvents',
      'setHighlight',
      'setGhost',
      'removeAvatar:a1',
    ]);
    // After mount, calls go straight through.
    lazy.setRoom(defaultRoom());
    expect(inner?.calls.at(-1)).toBe('setRoom');
  });

  it('answers queries with defaults before mount and delegates after', async () => {
    const { lazy, created } = setup();
    expect(lazy.screenToTile(10, 20)).toBeNull();
    expect(lazy.getAvatarAt({ x: 0, y: 0 })).toBeNull();
    expect(lazy.gridVisible).toBe(true);
    lazy.setGridVisible(false);
    expect(lazy.gridVisible).toBe(false);

    await mountAndRelease(lazy, created);
    expect(lazy.screenToTile(10, 20)).toEqual({ x: 3, y: 2 });
    expect(lazy.getAvatarAt({ x: 0, y: 0 })).toBe('a1');
    expect(lazy.gridVisible).toBe(false);
    lazy.setGridVisible(true);
    expect(lazy.gridVisible).toBe(true);
    expect(created[0]?.gridVisible).toBe(true);
  });

  it('destroy before the factory resolves destroys the inner world and replays nothing', async () => {
    const { lazy, created } = setup();
    lazy.setRoom(defaultRoom());
    const p = lazy.mount(container);
    lazy.destroy();
    await settle();
    created[0]?.release();
    await p;
    expect(created).toHaveLength(1);
    expect(created[0]?.destroyed).toBe(1);
    expect(created[0]?.calls).not.toContain('setRoom');
    expect(lazy.screenToTile(0, 0)).toBeNull();
  });

  it('destroy while the inner mount is pending destroys it once it resolves', async () => {
    const { lazy, created } = setup();
    lazy.setRoom(defaultRoom());
    const p = lazy.mount(container);
    await settle();
    expect(created[0]?.mounted).toBe(1);
    lazy.destroy();
    created[0]?.release();
    await p;
    expect(created[0]?.destroyed).toBe(1);
    expect(created[0]?.calls).toEqual(['mount', 'destroy']);
  });

  it('destroy is idempotent', async () => {
    const { lazy, created } = setup();
    await mountAndRelease(lazy, created);
    lazy.destroy();
    lazy.destroy();
    expect(created[0]?.destroyed).toBe(1);
    // Calls after destroy are dropped, not queued.
    lazy.setRoom(defaultRoom());
    expect(created[0]?.calls).not.toContain('setRoom');
  });

  it('can be mounted again after destroy, creating a second inner world', async () => {
    const { lazy, created } = setup();
    await mountAndRelease(lazy, created);
    lazy.destroy();
    const p = lazy.mount(container);
    // Queued again once a new mount is under way.
    lazy.upsertAvatar(AVATAR);
    await settle();
    created[1]?.release();
    await p;
    expect(created).toHaveLength(2);
    expect(created[1]?.calls).toEqual(['mount', 'upsertAvatar:a1']);
    expect(created[0]?.destroyed).toBe(1);
    lazy.destroy();
    expect(created[1]?.destroyed).toBe(1);
  });

  it('a re-mount that overtakes a pending mount tears the stale world down', async () => {
    const { lazy, created } = setup();
    const p1 = lazy.mount(container);
    const p2 = lazy.mount(container);
    await settle();
    created[0]?.release();
    created[1]?.release();
    await Promise.all([p1, p2]);
    expect(created).toHaveLength(2);
    expect(created[0]?.destroyed).toBe(1);
    expect(created[1]?.destroyed).toBe(0);
    lazy.setRoom(defaultRoom());
    expect(created[1]?.calls.at(-1)).toBe('setRoom');
  });
});
