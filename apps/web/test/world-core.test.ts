import { type Behavior, defaultRoom, type Furniture, type Room } from '@deskhaven/shared';
import { describe, expect, it } from 'vitest';
import type { InputBinder } from '../src/game/core/dom-input.js';
import { WorldCore } from '../src/game/core/world-core.js';
import { buildGrid, isWalkable } from '../src/game/grid.js';
import { chebyshev, facingFromDelta, tileToScreen } from '../src/game/iso.js';
import type { Ghost, TilePoint, WorldAvatarInput } from '../src/game/types.js';
import { FakeScene } from './helpers/fake-scene.js';

const AVATAR = {
  skin: '#f1c27d',
  hair: '#6e6e6e',
  hairStyle: 'cap',
  shirt: '#9aa0b4',
  pants: '#4a4e69',
  accessory: 'none',
} as const;

function agent(id: string, deskId: string | null = 'desk-1', name = 'Ada'): WorldAvatarInput {
  return { id, name, avatar: AVATAR, deskId };
}

const INTERN: WorldAvatarInput = {
  id: 'intern:1',
  name: 'Explore',
  avatar: AVATAR,
  deskId: null,
  isIntern: true,
  parentId: 'a1',
};

const noInput: InputBinder = () => () => {};
const container = {} as HTMLElement;

interface Rig {
  core: WorldCore;
  scene: FakeScene;
  scenes: FakeScene[];
  /** Resolves the factory promise of the most recent `mount`. */
  release: () => void;
}

function build(): {
  core: WorldCore;
  scenes: FakeScene[];
  /** Resolves the factory promise of the most recent `mount` (or of scene `i`). */
  release: (i?: number) => void;
} {
  const scenes: FakeScene[] = [];
  const releases: (() => void)[] = [];
  const core = new WorldCore(
    () =>
      new Promise<FakeScene>((resolve) => {
        const s = new FakeScene();
        scenes.push(s);
        releases.push(() => resolve(s));
      }),
    noInput,
  );
  return { core, scenes, release: (i = releases.length - 1) => releases[i]?.() };
}

/** A mounted core over a fresh fake scene, with the default room. */
async function mounted(): Promise<Rig> {
  const { core, scenes, release } = build();
  const p = core.mount(container);
  await settle();
  release();
  await p;
  const scene = scenes[0];
  if (!scene) throw new Error('no scene');
  return { core, scene, scenes, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Canvas-local pixel at the centre of a tile, through the transform the camera pushed. */
function canvasPoint(scene: FakeScene, tile: TilePoint): { x: number; y: number } {
  const { sx, sy } = tileToScreen(tile.x, tile.y);
  const t = scene.transform;
  return { x: sx * t.zoom + t.x, y: sy * t.zoom + t.y };
}

function pose(scene: FakeScene, id: string): string | undefined {
  return scene.lastFor('setAvatarPose', id)?.[1] as string | undefined;
}

function position(scene: FakeScene, id: string): TilePoint {
  const p = scene.lastFor('setAvatarPosition', id);
  if (!p) throw new Error(`no position for ${id}`);
  return { x: p[1] as number, y: p[2] as number };
}

function facing(scene: FakeScene, id: string): number {
  return (scene.lastFor('setAvatarFacing', id)?.[1] as number | undefined) ?? 2;
}

/** Step 16 ms frames until the avatar shows `want`, or fail after `max` frames. */
function runUntilPose(rig: Rig, id: string, want: string, max = 2000): number {
  for (let i = 0; i < max; i++) {
    rig.core.step(16);
    if (pose(rig.scene, id) === want) return i + 1;
  }
  throw new Error(`avatar ${id} never reached pose ${want}`);
}

function withFurniture(room: Room, mutate: (f: Furniture[]) => void): Room {
  const furniture = room.furniture.map((f) => ({ ...f }));
  mutate(furniture);
  return { ...room, furniture };
}

describe('WorldCore: avatars', () => {
  it('seats a new avatar at its desk and answers getAvatarAt', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    expect(scene.last('addAvatar')?.args[0]).toEqual({
      id: 'a1',
      name: 'Ada',
      avatar: AVATAR,
      isIntern: false,
    });
    // desk-1 at (2,1): its seat is (2,2), facing north.
    expect(scene.lastFor('setAvatarPosition', 'a1')).toEqual(['a1', 2, 2]);
    expect(scene.lastFor('setAvatarFacing', 'a1')).toEqual(['a1', 0]);
    expect(scene.lastFor('setAvatarSeated', 'a1')).toEqual(['a1', true]);
    expect(scene.lastFor('setAvatarPose', 'a1')).toEqual(['a1', 'idle']);
    expect(core.getAvatarAt({ x: 2, y: 2 })).toBe('a1');
    expect(core.getAvatarAt({ x: 3, y: 2 })).toBeNull();

    // Upserting again only refreshes name and appearance.
    scene.clear();
    core.upsertAvatar(agent('a1', 'desk-1', 'Ada Lovelace'));
    expect(scene.calls.map((c) => c.method)).toEqual(['setAvatarName', 'setAvatarAppearance']);
    expect(scene.last('setAvatarName')?.args).toEqual(['a1', 'Ada Lovelace']);
  });

  it('runs one frame as advance → positions → update → finished checks', async () => {
    const rig = await mounted();
    rig.core.upsertAvatar(agent('a1'));
    rig.core.upsertAvatar(agent('a2', 'desk-2'));
    rig.scene.clear();
    rig.core.step(250);
    expect(rig.scene.calls.map((c) => c.method)).toEqual([
      'setAvatarPosition',
      'setAvatarPosition',
      'update',
    ]);
    // The frame time is clamped to 100 ms before it reaches the scene.
    expect(rig.scene.last('update')?.args).toEqual([100]);
  });

  it('walks to the bookshelf for reading and shows the label as a thought', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    scene.clear();
    core.applyBehavior('a1', { kind: 'reading', label: 'README.md' });
    expect(pose(scene, 'a1')).toBe('walk');
    expect(scene.lastFor('setAvatarSeated', 'a1')).toEqual(['a1', false]);
    expect(scene.of('showBubble')).toHaveLength(0);

    const seen = new Set<string>();
    const frames = runUntilPose(rig, 'a1', 'reading');
    for (const c of scene.of('setAvatarPosition')) seen.add(`${c.args[1]},${c.args[2]}`);
    expect(frames).toBeGreaterThan(50);
    expect(seen.size).toBeGreaterThan(10);
    expect([
      { x: 11, y: 1 },
      { x: 12, y: 1 },
    ]).toContainEqual(position(scene, 'a1'));
    expect(facing(scene, 'a1')).toBe(0);
    expect(scene.of('showBubble').map((c) => c.args)).toEqual([
      ['a1', 'README.md', 'thought', 4000],
    ]);
    expect(core.getAvatarAt(position(scene, 'a1'))).toBe('a1');
  });

  it('removeAvatar walks to the door, fades, and is forgotten once the scene reports it finished', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    core.setHighlight({ avatarId: 'a1' });
    expect(scene.last('setAvatarHighlighted')?.args).toEqual(['a1', true]);
    scene.clear();
    core.removeAvatar('a1');
    expect(scene.of('hideBubble').map((c) => c.args)).toEqual([['a1']]);
    expect(pose(scene, 'a1')).toBe('walk');
    runUntilPose(rig, 'a1', 'leave');
    expect(position(scene, 'a1')).toEqual({ x: 0, y: 9 });
    expect(scene.of('removeAvatar')).toHaveLength(0);
    // While leaving, behaviours, speech and a second removal are ignored.
    core.applyBehavior('a1', { kind: 'thinking' });
    core.say('a1', 'hi');
    core.removeAvatar('a1');
    expect(scene.of('showBubble')).toHaveLength(0);
    expect(pose(scene, 'a1')).toBe('leave');

    scene.finished.add('a1');
    core.step(16);
    expect(scene.of('removeAvatar').map((c) => c.args)).toEqual([['a1']]);
    expect(core.getAvatarAt({ x: 0, y: 9 })).toBeNull();
    // The highlight was cleared with it: nothing to un-highlight.
    scene.clear();
    core.setHighlight(null);
    expect(scene.of('setAvatarHighlighted')).toHaveLength(0);
    // A fresh upsert creates a new sprite.
    core.upsertAvatar(agent('a1'));
    expect(scene.of('addAvatar')).toHaveLength(1);
  });

  it('upsert of a leaving avatar replaces it', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    core.removeAvatar('a1');
    scene.clear();
    core.upsertAvatar(agent('a1'));
    expect(scene.calls.slice(0, 2).map((c) => c.method)).toEqual(['removeAvatar', 'addAvatar']);
    expect(pose(scene, 'a1')).toBe('idle');
    expect(position(scene, 'a1')).toEqual({ x: 2, y: 2 });
  });

  it('interns poof in at the door, stand beside their parent facing it, and poof out', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    scene.clear();
    core.upsertAvatar(INTERN);
    expect(scene.last('addAvatar')?.args[0]).toMatchObject({ id: 'intern:1', isIntern: true });
    expect(position(scene, 'intern:1')).toEqual({ x: 0, y: 9 });
    expect(scene.of('poofAvatar').map((c) => c.args)).toEqual([['intern:1']]);
    expect(pose(scene, 'intern:1')).toBe('walk');
    runUntilPose(rig, 'intern:1', 'idle');
    const p = position(scene, 'intern:1');
    expect(chebyshev(p, { x: 2, y: 2 })).toBe(1);
    expect(facing(scene, 'intern:1')).toBe(facingFromDelta(2 - p.x, 2 - p.y));
    expect(core.getAvatarAt(p)).toBe('intern:1');
    // The parent never moved.
    expect(position(scene, 'a1')).toEqual({ x: 2, y: 2 });

    scene.clear();
    core.removeAvatar('intern:1');
    runUntilPose(rig, 'intern:1', 'leave');
    expect(scene.of('poofAvatar').map((c) => c.args)).toEqual([['intern:1']]);
    // Only once: further leave frames do not poof again.
    core.step(16);
    core.step(16);
    expect(scene.of('poofAvatar')).toHaveLength(1);
  });

  it('say shows a speech bubble with defaults and drops unknown ids', async () => {
    const rig = await mounted();
    rig.core.upsertAvatar(agent('a1'));
    rig.core.say('a1', 'hello');
    rig.core.say('a1', 'code', { kind: 'code', durationMs: 1000 });
    rig.core.say('nobody', 'x');
    expect(rig.scene.of('showBubble').map((c) => c.args)).toEqual([
      ['a1', 'hello', 'speech', 4000],
      ['a1', 'code', 'code', 1000],
    ]);
  });

  it('wanders after 6–12 s, deterministically per id', async () => {
    const run = async (id: string): Promise<{ firstWalkS: number; trace: string }> => {
      const rig = await mounted();
      rig.core.upsertAvatar(agent(id));
      rig.scene.clear();
      let firstWalkS = -1;
      for (let i = 1; i <= 150; i++) {
        rig.core.step(100);
        if (firstWalkS < 0 && pose(rig.scene, id) === 'walk') firstWalkS = i * 0.1;
      }
      const trace = rig.scene
        .of('setAvatarPosition')
        .map((c) => `${c.args[1]},${c.args[2]}`)
        .join('|');
      return { firstWalkS, trace };
    };
    const a = await run('a1');
    const b = await run('a1');
    expect(a.firstWalkS).toBeGreaterThan(6);
    expect(a.firstWalkS).toBeLessThanOrEqual(12.1);
    expect(b).toEqual(a);
  });
});

describe('WorldCore: room changes', () => {
  it('hops an avatar off a tile that new furniture covers', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    scene.clear();
    const room = withFurniture(defaultRoom(), (f) => {
      f.push({ id: 'plant-x', roomId: 'lobby', kind: 'plant', x: 2, y: 2, rotation: 0, meta: {} });
    });
    core.setRoom(room);
    expect(scene.of('setRoom')).toHaveLength(1);
    const p = position(scene, 'a1');
    expect(p).not.toEqual({ x: 2, y: 2 });
    expect(chebyshev(p, { x: 2, y: 2 })).toBe(1);
    expect(isWalkable(buildGrid(room), p.x, p.y)).toBe(true);
    expect(scene.lastFor('setAvatarSeated', 'a1')).toEqual(['a1', false]);
    expect(pose(scene, 'a1')).toBe('idle');
    expect(core.getAvatarAt(p)).toBe('a1');
  });

  it('re-walks to a desk that moved', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    core.applyBehavior('a1', { kind: 'typing', label: 'main.ts' });
    expect(pose(scene, 'a1')).toBe('typing');
    scene.clear();
    const room = withFurniture(defaultRoom(), (f) => {
      const desk = f.find((p) => p.id === 'desk-1');
      if (desk) {
        desk.x = 4;
        desk.y = 6;
      }
    });
    core.setRoom(room);
    expect(pose(scene, 'a1')).toBe('walk');
    runUntilPose(rig, 'a1', 'typing');
    expect(position(scene, 'a1')).toEqual({ x: 4, y: 7 });
    expect(scene.lastFor('setAvatarSeated', 'a1')).toEqual(['a1', true]);
  });

  it('only turns an avatar whose seat was rotated in place', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    core.upsertAvatar(agent('a1'));
    core.applyBehavior('a1', { kind: 'typing', label: 'main.ts' });
    scene.clear();
    // A desk at (1,3) rotated twice has its seat on (2,2) facing south.
    const room = withFurniture(defaultRoom(), (f) => {
      const desk = f.find((p) => p.id === 'desk-1');
      if (desk) {
        desk.x = 1;
        desk.y = 3;
        desk.rotation = 2;
      }
    });
    core.setRoom(room);
    expect(scene.of('setAvatarFacing').map((c) => c.args)).toEqual([['a1', 2]]);
    expect(scene.of('setAvatarSeated').map((c) => c.args)).toEqual([['a1', true]]);
    expect(scene.of('setAvatarPose')).toHaveLength(0);
    expect(scene.of('setAvatarPosition')).toHaveLength(0);
    core.step(16);
    expect(position(scene, 'a1')).toEqual({ x: 2, y: 2 });
  });

  it('cancels a furniture drag when the room changes under it', async () => {
    const rig = await mounted();
    const { core, scene } = rig;
    const ended: unknown[] = [];
    core.setEvents({ onFurnitureDragEnd: (...a) => ended.push(a) });
    core.setEditorMode(true);
    scene.hit = { kind: 'furniture', id: 'desk-1' };
    core.pointerDown({ ...canvasPoint(scene, { x: 2, y: 1 }), button: 0 });
    core.pointerMove({ ...canvasPoint(scene, { x: 3, y: 1 }), buttons: 1 });
    scene.clear();
    core.setRoom(defaultRoom());
    expect(scene.calls.slice(0, 2).map((c) => c.method)).toEqual([
      'setFurniturePreview',
      'setRoom',
    ]);
    expect(scene.last('setFurniturePreview')?.args).toEqual(['desk-1', null]);
    core.pointerUp(canvasPoint(scene, { x: 3, y: 1 }));
    expect(ended).toEqual([]);
  });
});

describe('WorldCore: pointer', () => {
  it('converts client coordinates through the canvas rect', async () => {
    const { core, scene } = await mounted();
    const p = canvasPoint(scene, { x: 5, y: 6 });
    expect(core.screenToTile(p.x + 10, p.y + 20)).toEqual({ x: 5, y: 6 });
    expect(core.screenToTile(-1000, -1000)).toBeNull();
  });

  it('classifies clicks from the hit stored at press time', async () => {
    const { core, scene } = await mounted();
    const got: string[] = [];
    core.setEvents({
      onAvatarClick: (id) => got.push(`avatar:${id}`),
      onFurnitureClick: (id) => got.push(`furniture:${id}`),
      onTileClick: (t) => got.push(`tile:${t.x},${t.y}`),
    });
    const p = canvasPoint(scene, { x: 6, y: 6 });
    scene.hit = { kind: 'avatar', id: 'a1' };
    core.pointerDown({ ...p, button: 0 });
    // The hit is picked once at press; whatever is under the pointer at release does not matter.
    scene.hit = { kind: 'furniture', id: 'desk-1' };
    core.pointerUp(p);
    expect(scene.of('pick')).toHaveLength(1);
    scene.hit = { kind: 'furniture', id: 'desk-1' };
    core.pointerDown({ ...p, button: 0 });
    core.pointerUp({ x: p.x + 2, y: p.y + 2 });
    scene.hit = null;
    core.pointerDown({ ...p, button: 0 });
    core.pointerUp(p);
    // Beyond the click slop: nothing.
    core.pointerDown({ ...p, button: 0 });
    core.pointerUp({ x: p.x + 6, y: p.y });
    // Secondary buttons never click.
    core.pointerDown({ ...p, button: 2 });
    core.pointerUp(p);
    // Up without a press: nothing.
    core.pointerUp(p);
    expect(got).toEqual(['avatar:a1', 'furniture:desk-1', 'tile:6,6']);
    // Outside editor mode nothing takes focus.
    expect(scene.focusCalls).toHaveLength(0);
  });

  it('drags furniture in editor mode and reports the clamped origin once on release', async () => {
    const { core, scene } = await mounted();
    const ended: unknown[] = [];
    const clicked: string[] = [];
    core.setEvents({
      onFurnitureDragEnd: (id, t) => ended.push([id, t]),
      onFurnitureClick: (id) => clicked.push(id),
    });
    core.setEditorMode(true);
    scene.hit = { kind: 'furniture', id: 'desk-1' };
    core.pointerDown({ ...canvasPoint(scene, { x: 2, y: 1 }), button: 0 });
    expect(scene.focusCalls).toHaveLength(1);
    expect(scene.of('setFurniturePreview')).toHaveLength(0);
    core.pointerMove({ ...canvasPoint(scene, { x: 2, y: 1 }), buttons: 1 });
    expect(scene.of('setFurniturePreview')).toHaveLength(0);
    core.pointerMove({ ...canvasPoint(scene, { x: 3, y: 1 }), buttons: 1 });
    expect(scene.last('setFurniturePreview')?.args).toEqual(['desk-1', { x: 3, y: 1 }]);
    // A 2×1 desk grabbed at its origin cell clamps to x ≤ 12.
    core.pointerMove({ ...canvasPoint(scene, { x: 13, y: 9 }), buttons: 1 });
    expect(scene.last('setFurniturePreview')?.args).toEqual(['desk-1', { x: 12, y: 9 }]);
    core.pointerMove({ ...canvasPoint(scene, { x: 13, y: 9 }), buttons: 1 });
    expect(scene.of('setFurniturePreview')).toHaveLength(2);
    // Outside the room the preview stays put.
    core.pointerMove({ x: -500, y: -500, buttons: 1 });
    expect(scene.of('setFurniturePreview')).toHaveLength(2);
    core.pointerUp(canvasPoint(scene, { x: 13, y: 9 }));
    expect(scene.last('setFurniturePreview')?.args).toEqual(['desk-1', null]);
    expect(ended).toEqual([['desk-1', { x: 12, y: 9 }]]);
    expect(clicked).toEqual([]);

    // A press and release without moving is a click.
    core.pointerDown({ ...canvasPoint(scene, { x: 2, y: 1 }), button: 0 });
    core.pointerUp(canvasPoint(scene, { x: 2, y: 1 }));
    expect(clicked).toEqual(['desk-1']);
    expect(ended).toHaveLength(1);

    // A cancelled drag snaps back silently.
    scene.clear();
    core.pointerDown({ ...canvasPoint(scene, { x: 2, y: 1 }), button: 0 });
    core.pointerMove({ ...canvasPoint(scene, { x: 4, y: 3 }), buttons: 1 });
    core.pointerCancel();
    expect(scene.last('setFurniturePreview')?.args).toEqual(['desk-1', null]);
    expect(ended).toHaveLength(1);
    expect(clicked).toHaveLength(1);
  });

  it('paints one tile per newly entered tile and clicks when released on the press tile', async () => {
    const { core, scene } = await mounted();
    const drags: string[] = [];
    const clicks: string[] = [];
    core.setEvents({
      onTileDrag: (t) => drags.push(`${t.x},${t.y}`),
      onTileClick: (t) => clicks.push(`${t.x},${t.y}`),
    });
    core.setEditorMode(true);
    scene.hit = null;
    const at = (x: number, y: number) => canvasPoint(scene, { x, y });
    core.pointerDown({ ...at(5, 5), button: 0 });
    core.pointerMove({ x: at(5, 5).x + 3, y: at(5, 5).y, buttons: 1 });
    expect(drags).toEqual([]);
    core.pointerMove({ ...at(6, 5), buttons: 1 });
    expect(drags).toEqual(['5,5', '6,5']);
    core.pointerMove({ x: at(6, 5).x - 2, y: at(6, 5).y + 1, buttons: 1 });
    core.pointerMove({ ...at(7, 5), buttons: 1 });
    core.pointerMove({ x: -500, y: -500, buttons: 1 });
    expect(drags).toEqual(['5,5', '6,5', '7,5']);
    core.pointerUp(at(7, 6));
    expect(drags).toEqual(['5,5', '6,5', '7,5', '7,6']);
    expect(clicks).toEqual([]);

    // Jitter within the press tile is a click, not a stroke.
    core.pointerDown({ ...at(3, 7), button: 0 });
    core.pointerMove({ x: at(3, 7).x + 10, y: at(3, 7).y + 3, buttons: 1 });
    core.pointerUp({ x: at(3, 7).x + 10, y: at(3, 7).y + 3 });
    expect(clicks).toEqual(['3,7']);
    expect(drags).toHaveLength(4);

    // A cancelled press emits nothing; a stroke whose button was released outside ends silently.
    core.pointerDown({ ...at(3, 7), button: 0 });
    core.pointerMove({ ...at(4, 7), buttons: 1 });
    core.pointerCancel();
    expect(drags).toEqual(['5,5', '6,5', '7,5', '7,6', '3,7', '4,7']);
    core.pointerDown({ ...at(8, 8), button: 0 });
    core.pointerMove({ ...at(9, 8), buttons: 0 });
    core.pointerUp(at(9, 8));
    expect(drags).toHaveLength(6);
    expect(clicks).toEqual(['3,7']);
  });

  it('dedupes hover per tile, reports null on leave, and only in editor mode', async () => {
    const { core, scene } = await mounted();
    const hovers: (string | null)[] = [];
    core.setEvents({ onTileHover: (t) => hovers.push(t ? `${t.x},${t.y}` : null) });
    const at = (x: number, y: number) => canvasPoint(scene, { x, y });
    core.pointerMove({ ...at(4, 4), buttons: 0 });
    expect(hovers).toEqual([]);
    expect(scene.last('setHoverTile')?.args).toEqual([{ x: 4, y: 4 }]);
    core.pointerLeave();
    expect(scene.last('setHoverTile')?.args).toEqual([null]);
    expect(hovers).toEqual([]);

    core.setEditorMode(true);
    core.pointerMove({ ...at(4, 4), buttons: 0 });
    core.pointerMove({ x: at(4, 4).x + 1, y: at(4, 4).y + 1, buttons: 0 });
    core.pointerMove({ ...at(4, 5), buttons: 0 });
    core.pointerMove({ x: -500, y: -500, buttons: 0 });
    core.pointerMove({ ...at(4, 5), buttons: 0 });
    core.pointerLeave();
    core.pointerLeave();
    expect(hovers).toEqual(['4,4', '4,5', null, '4,5', null]);
    expect(scene.of('setHoverTile')).toHaveLength(9);

    // Leaving editor mode clears the editor state and its overlays.
    scene.clear();
    core.setGhost({ kind: 'plant', x: 1, y: 1, rotation: 0, valid: true });
    core.setEditorMode(false);
    expect(scene.calls.map((c) => c.method)).toEqual([
      'setGhost',
      'setGridVisible',
      'setEditorMode',
      'setGhost',
      'setHighlightFurniture',
    ]);
    expect(scene.last('setGhost')?.args).toEqual([null]);
  });

  it('maps editor shortcuts only in editor mode and never from text fields', async () => {
    const { core } = await mounted();
    const keys: string[] = [];
    core.setEvents({ onEditorKey: (k) => keys.push(k) });
    expect(core.keyDown('r', false)).toBe(false);
    core.setEditorMode(true);
    expect(core.keyDown('r', false)).toBe(true);
    expect(core.keyDown('Delete', true)).toBe(false);
    expect(core.keyDown('x', false)).toBe(false);
    expect(core.keyDown('Escape', false)).toBe(true);
    expect(keys).toEqual(['r', 'Escape']);
  });
});

describe('WorldCore: lifecycle', () => {
  it('replays pre-mount calls FIFO after pushing room, grid, editor mode and ghost', async () => {
    const { core, scenes, release } = build();
    const room = defaultRoom();
    const ghost: Ghost = { kind: 'sofa', x: 3, y: 3, rotation: 1, valid: false };
    const thinking: Behavior = { kind: 'thinking' };
    core.setRoom(room);
    core.setGridVisible(false);
    core.setEditorMode(true);
    core.setGhost(ghost);
    core.upsertAvatar(agent('a1'));
    core.applyBehavior('a1', thinking);
    core.upsertAvatar(agent('a2', 'desk-2'));
    expect(core.gridVisible).toBe(false);
    expect(core.getAvatarAt({ x: 2, y: 2 })).toBeNull();
    expect(core.screenToTile(0, 0)).toBeNull();
    expect(scenes).toHaveLength(0);

    const p = core.mount(container);
    await settle();
    release();
    await p;
    const scene = scenes[0];
    expect(scene).toBeDefined();
    if (!scene) return;
    expect(scene.calls.slice(0, 5).map((c) => c.method)).toEqual([
      'mount',
      'setRoom',
      'setGridVisible',
      'setEditorMode',
      'setGhost',
    ]);
    expect(scene.calls[1]?.args[0]).toBe(room);
    // The grid is forced on in editor mode even though the user toggled it off.
    expect(scene.calls[2]?.args).toEqual([true]);
    expect(scene.calls[3]?.args).toEqual([true]);
    expect(scene.calls[4]?.args).toEqual([ghost]);
    expect(core.gridVisible).toBe(false);
    const adds = scene.of('addAvatar').map((c) => (c.args[0] as { id: string }).id);
    expect(adds).toEqual(['a1', 'a2']);
    expect(scene.of('showBubble').map((c) => c.args)).toEqual([['a1', '…', 'thought', 3000]]);
    expect(core.getAvatarAt({ x: 2, y: 2 })).toBe('a1');
    expect(scene.canvas.tabIndex).toBe(0);
    expect(scene.canvas.style.display).toBe('block');
    expect(scene.canvas.style.outline).toBe('none');
    expect(scene.transform.zoom).toBe(0.75);
  });

  it('destroy is idempotent, keeps the events, and frames stop reaching the core', async () => {
    const { core, scene } = await mounted();
    const clicks: TilePoint[] = [];
    core.setEvents({ onTileClick: (t) => clicks.push(t) });
    core.upsertAvatar(agent('a1'));
    const host = scene.host;
    core.destroy();
    core.destroy();
    expect(scene.destroyed).toBe(1);
    expect(core.getAvatarAt({ x: 2, y: 2 })).toBeNull();
    scene.clear();
    host?.onFrame(16);
    core.step(16);
    expect(scene.calls).toEqual([]);
    // Calls after destroy and before the next mount are queued for it.
    core.upsertAvatar(agent('a1'));
    expect(scene.of('addAvatar')).toHaveLength(0);
  });

  it('destroy during a pending mount destroys that scene and clears the queue', async () => {
    const { core, scenes, release } = build();
    core.setRoom(defaultRoom());
    core.upsertAvatar(agent('a1'));
    const p = core.mount(container);
    core.destroy();
    await settle();
    release();
    await p;
    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.calls.map((c) => c.method)).toEqual(['mount', 'destroy']);
    expect(core.screenToTile(0, 0)).toBeNull();
    // The queued upsert was dropped with the destroy; a later mount starts clean.
    const p2 = core.mount(container);
    await settle();
    release();
    await p2;
    expect(scenes).toHaveLength(2);
    expect(scenes[1]?.of('addAvatar')).toHaveLength(0);
    expect(scenes[1]?.of('setRoom')).toHaveLength(1);
  });

  it('a re-mount that overtakes a pending mount tears the stale scene down', async () => {
    const { core, scenes, release } = build();
    const p1 = core.mount(container);
    await settle();
    const p2 = core.mount(container);
    await settle();
    release(0);
    release(1);
    await Promise.all([p1, p2]);
    expect(scenes).toHaveLength(2);
    expect(scenes[0]?.destroyed).toBe(1);
    expect(scenes[1]?.destroyed).toBe(0);
    core.upsertAvatar(agent('a1'));
    expect(scenes[1]?.of('addAvatar')).toHaveLength(1);
    expect(scenes[0]?.of('addAvatar')).toHaveLength(0);
  });

  it('re-mount after destroy creates a second scene with the same room and events', async () => {
    const { core, scene, scenes, release } = await mounted();
    const clicks: TilePoint[] = [];
    core.setEvents({ onTileClick: (t) => clicks.push(t) });
    const room = defaultRoom();
    core.setRoom(room);
    core.setGridVisible(false);
    core.destroy();
    const p = core.mount(container);
    await settle();
    release();
    await p;
    const second = scenes[1];
    expect(second).toBeDefined();
    if (!second) return;
    expect(scene.destroyed).toBe(1);
    expect(second.calls.slice(0, 3).map((c) => c.method)).toEqual([
      'mount',
      'setRoom',
      'setGridVisible',
    ]);
    expect(second.calls[1]?.args[0]).toBe(room);
    expect(second.calls[2]?.args).toEqual([false]);
    second.hit = null;
    const pt = canvasPoint(second, { x: 5, y: 5 });
    core.pointerDown({ ...pt, button: 0 });
    core.pointerUp(pt);
    expect(clicks).toEqual([{ x: 5, y: 5 }]);
  });

  it('camera resizes come from the scene host', async () => {
    const { core, scene } = await mounted();
    const before = scene.transform;
    scene.host?.onResize(1600, 1200);
    expect(scene.transform).not.toEqual(before);
    const p = canvasPoint(scene, { x: 5, y: 6 });
    expect(core.screenToTile(p.x + 10, p.y + 20)).toEqual({ x: 5, y: 6 });
  });
});
