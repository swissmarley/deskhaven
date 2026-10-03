import { describe, expect, it } from 'vitest';
import {
  countNearDoor,
  DOOR_CLOSE_DELAY_S,
  DOOR_CLOSED,
  DOOR_NEAR_TILES,
  DOOR_OPEN_RAD,
  DOOR_SWING_S,
  type DoorState,
  doorAngle,
  doorHinge,
  doorState,
  doorTiles,
  isDoorLeafName,
  nearDoor,
} from '../src/game/three/door-math.js';

/** Run the door for `seconds` in `step`-second frames. */
function run(state: DoorState, near: number, seconds: number, step = 1 / 60): DoorState {
  let s = state;
  for (let t = 0; t < seconds - 1e-9; t += step) s = doorState(s, near, step);
  return s;
}

describe('doorState', () => {
  it('stays shut while nobody is near', () => {
    expect(run(DOOR_CLOSED, 0, 2)).toEqual(DOOR_CLOSED);
  });

  it('opens over DOOR_SWING_S as soon as someone is near, then holds', () => {
    const half = run(DOOR_CLOSED, 1, DOOR_SWING_S / 2);
    expect(half.target).toBe(1);
    expect(half.openness).toBeGreaterThan(0.4);
    expect(half.openness).toBeLessThan(0.6);
    const open = run(DOOR_CLOSED, 1, DOOR_SWING_S + 0.05);
    expect(open.openness).toBe(1);
    expect(run(open, 2, 5).openness).toBe(1);
  });

  it('closes DOOR_CLOSE_DELAY_S after the last avatar left, over DOOR_SWING_S', () => {
    const open = run(DOOR_CLOSED, 1, 1);
    const waiting = run(open, 0, DOOR_CLOSE_DELAY_S - 0.05);
    expect(waiting.target).toBe(1);
    expect(waiting.openness).toBe(1);
    const closing = run(open, 0, DOOR_CLOSE_DELAY_S + DOOR_SWING_S / 2);
    expect(closing.target).toBe(0);
    expect(closing.openness).toBeGreaterThan(0.3);
    expect(closing.openness).toBeLessThan(0.7);
    const shut = run(open, 0, DOOR_CLOSE_DELAY_S + DOOR_SWING_S + 0.1);
    expect(shut.openness).toBe(0);
    expect(shut.target).toBe(0);
  });

  it('someone coming back during the delay cancels the close', () => {
    const open = run(DOOR_CLOSED, 1, 1);
    const almost = run(open, 0, DOOR_CLOSE_DELAY_S - 0.1);
    const back = doorState(almost, 1, 1 / 60);
    expect(back.target).toBe(1);
    expect(back.idle).toBe(0);
    expect(back.openness).toBe(1);
  });

  it('never jumps: a passer-by opens it fully, then it closes continuously', () => {
    const frame = 1 / 60;
    const maxStep = frame / DOOR_SWING_S + 1e-9;
    let s = DOOR_CLOSED;
    let maxDelta = 0;
    const tick = (near: number): void => {
      const next = doorState(s, near, frame);
      maxDelta = Math.max(maxDelta, Math.abs(next.openness - s.openness));
      s = next;
    };
    // Half a swing with someone near, then they leave: the door still finishes opening.
    for (let t = 0; t < DOOR_SWING_S / 2; t += frame) tick(1);
    for (let t = 0; t < DOOR_CLOSE_DELAY_S - frame; t += frame) tick(0);
    expect(s.target).toBe(1);
    expect(s.openness).toBe(1);
    // The delay elapses, the door starts closing, and someone comes back mid-swing.
    for (let t = 0; t < DOOR_SWING_S / 2 + frame; t += frame) tick(0);
    expect(s.target).toBe(0);
    expect(s.openness).toBeLessThan(1);
    expect(s.openness).toBeGreaterThan(0);
    const mid = s.openness;
    tick(1);
    expect(s.target).toBe(1);
    expect(s.openness).toBeGreaterThanOrEqual(mid);
    for (let t = 0; t < 1; t += frame) tick(1);
    expect(s.openness).toBe(1);
    expect(maxDelta).toBeLessThanOrEqual(maxStep);
  });
});

describe('doorAngle', () => {
  it('eases from 0 to DOOR_OPEN_RAD and clamps', () => {
    expect(doorAngle(0)).toBe(0);
    expect(doorAngle(1)).toBeCloseTo(DOOR_OPEN_RAD, 12);
    expect(doorAngle(0.5)).toBeCloseTo(DOOR_OPEN_RAD / 2, 12);
    expect(doorAngle(-1)).toBe(0);
    expect(doorAngle(2)).toBeCloseTo(DOOR_OPEN_RAD, 12);
    // Smooth: slow at both ends.
    expect(doorAngle(0.05)).toBeLessThan(DOOR_OPEN_RAD * 0.05);
    expect(doorAngle(0.95)).toBeGreaterThan(DOOR_OPEN_RAD * 0.95);
    expect(DOOR_OPEN_RAD).toBeCloseTo((80 * Math.PI) / 180, 12);
  });
});

describe('doorHinge / isDoorLeafName', () => {
  it('puts the hinge on the leaf edge beside the frame post, mid-thickness', () => {
    // The measured `door 3` leaf of doorway.glb (handle at the −X end).
    const leaf = { minX: -4.576, minY: 0, minZ: 0.243, maxX: -0.283, maxY: 9.812, maxZ: 0.648 };
    const h = doorHinge(leaf);
    expect(h.x).toBe(-0.283);
    expect(h.y).toBe(0);
    expect(h.z).toBeCloseTo(0.4455, 9);
  });

  it('recognises the leaf node and not the frame', () => {
    expect(isDoorLeafName('door 3')).toBe(true);
    expect(isDoorLeafName('door_3')).toBe(true);
    expect(isDoorLeafName('door_3_1')).toBe(true);
    expect(isDoorLeafName('doorway')).toBe(false);
    expect(isDoorLeafName('doorway_1')).toBe(false);
    expect(isDoorLeafName('')).toBe(false);
  });
});

describe('nearDoor / countNearDoor', () => {
  const tiles = [
    { x: 0, y: 9 },
    { x: 1, y: 9 },
  ];

  it('counts avatars within one tile of any door tile, Euclidean', () => {
    expect(DOOR_NEAR_TILES).toBe(1);
    expect(nearDoor(1, 9, tiles)).toBe(true);
    expect(nearDoor(2, 9, tiles)).toBe(true);
    expect(nearDoor(1.5, 9.5, tiles)).toBe(true);
    expect(nearDoor(2, 10, tiles)).toBe(false); // √2 away from (1, 9)
    expect(nearDoor(1, 7.9, tiles)).toBe(false);
    expect(
      countNearDoor(
        [
          { x: 1, y: 9 },
          { x: 5, y: 5 },
          { x: 0.2, y: 8.4 },
        ],
        tiles,
      ),
    ).toBe(2);
    expect(countNearDoor([], tiles)).toBe(0);
    expect(countNearDoor([{ x: 1, y: 9 }], [])).toBe(0);
  });
});

describe('doorTiles', () => {
  it("yields the door's own tiles, deduplicated, for its current position", () => {
    // The saved room's door: (2, 8) rotation 0. Its stand tile is its own tile → one entry.
    expect(doorTiles({ kind: 'door', x: 2, y: 8, rotation: 0 })).toEqual([{ x: 2, y: 8 }]);
    expect(doorTiles({ kind: 'door', x: 0, y: 9, rotation: 0 })).toEqual([{ x: 0, y: 9 }]);
    expect(doorTiles({ kind: 'door', x: 5, y: 0, rotation: 1 })).toEqual([{ x: 5, y: 0 }]);
    // Multi-tile kinds list the whole footprint plus the interaction tiles, each once.
    const desk = doorTiles({ kind: 'desk', x: 4, y: 4, rotation: 0 });
    expect(desk.length).toBe(new Set(desk.map((t) => `${t.x},${t.y}`)).size);
    expect(desk).toEqual(
      expect.arrayContaining([
        { x: 4, y: 4 },
        { x: 5, y: 4 },
      ]),
    );
  });

  it('sees an avatar standing beside the moved door', () => {
    const tiles = doorTiles({ kind: 'door', x: 2, y: 8, rotation: 0 });
    expect(countNearDoor([{ x: 3, y: 8 }], tiles)).toBe(1);
    expect(nearDoor(3, 8, tiles, DOOR_NEAR_TILES)).toBe(true);
    // The default room's stale tiles would not have.
    expect(
      countNearDoor([{ x: 3, y: 8 }], doorTiles({ kind: 'door', x: 0, y: 9, rotation: 0 })),
    ).toBe(0);
  });
});
