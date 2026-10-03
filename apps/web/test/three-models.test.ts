import {
  FURNITURE_CATALOG,
  type FurnitureKind,
  interactionTiles,
  rotatedSize,
} from '@agenthotel/shared';
import { Box3, InstancedMesh, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';
import {
  FIT_MARGIN,
  fillFootprint,
  fitToFootprint,
  frontVector,
  MODEL_MANIFEST,
  orientedSize,
  partScale,
  partsFor,
  placement,
  rotationYaw,
  variantIndex,
} from '../src/game/three/models.js';
import {
  BOARD_STROKE_COUNT,
  buildCounter,
  buildFallbackBox,
  buildServerRack,
  buildTable,
  buildWhiteboard,
  RACK_LED_COUNT,
  Resources,
} from '../src/game/three/procedural.js';

const KINDS = Object.keys(FURNITURE_CATALOG) as FurnitureKind[];

function boxOf(object: Object3D): Box3 {
  object.updateMatrixWorld(true);
  return new Box3().setFromObject(object, true);
}

function instanceCount(object: Object3D, name: string): number {
  let count = 0;
  object.traverse((o) => {
    if (o instanceof InstancedMesh && o.name === name) count += o.count;
  });
  return count;
}

describe('MODEL_MANIFEST', () => {
  it('covers every furniture kind with at least one part', () => {
    for (const kind of KINDS) {
      const spec = MODEL_MANIFEST[kind];
      expect(spec, kind).toBeDefined();
      expect(spec.parts.length, kind).toBeGreaterThan(0);
      for (const variant of spec.variants ?? []) expect(variant.length).toBeGreaterThan(0);
    }
  });

  it('picks a stable plant variety per id and alternates across ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const parts = partsFor('plant', `plant-${i}`);
      const first = parts[0];
      if (first?.kind === 'gltf') seen.add(first.model);
      expect(partsFor('plant', `plant-${i}`)).toEqual(parts);
    }
    expect(seen).toEqual(new Set(['pottedPlant', 'plantSmall1']));
    expect(variantIndex('x', 1)).toBe(0);
  });

  it('uses the GLB catalogue only (no stray model names)', () => {
    const names = new Set<string>();
    for (const kind of KINDS)
      for (const part of [
        ...MODEL_MANIFEST[kind].parts,
        ...(MODEL_MANIFEST[kind].variants ?? []).flat(),
      ])
        if (part.kind === 'gltf') names.add(part.model);
    expect(names.has('desk')).toBe(true);
    expect(names.has('rugRectangle')).toBe(true);
    expect(names.has('doorway')).toBe(true);
  });
});

describe('placement', () => {
  it('centres the rotated footprint and yaws by rotation × −90°', () => {
    const p0 = placement('desk', 2, 1, 0);
    expect(p0).toMatchObject({ x: 2.5, z: 1, w: 2, h: 1, yaw: 0 });
    const p1 = placement('desk', 2, 1, 1);
    expect(p1).toMatchObject({ x: 2, z: 1.5, w: 1, h: 2 });
    expect(p1.yaw).toBeCloseTo(-Math.PI / 2, 9);
    expect(placement('desk', 2, 1, 2).yaw).toBeCloseTo(-Math.PI, 9);
    expect(placement('desk', 2, 1, 3).yaw).toBeCloseTo((-3 * Math.PI) / 2, 9);
    expect(rotationYaw(-1)).toBeCloseTo(rotationYaw(3), 9);
    expect(placement('rug', 6, 7, 1)).toMatchObject({ x: 6.5, z: 7.5, w: 2, h: 2 });
  });

  it("turns the desk's front (local +Z) towards its seat tile for every rotation", () => {
    for (const rotation of [0, 1, 2, 3]) {
      const p = placement('desk', 4, 3, rotation);
      const seat = interactionTiles('desk', 4, 3, rotation).find((t) => t.type === 'seat');
      expect(seat).toBeDefined();
      if (!seat) return;
      const front = frontVector(p.yaw);
      const dx = seat.x - p.x;
      const dz = seat.y - p.z;
      // The seat is the tile just outside the footprint on the front side: its centre lies half the
      // footprint depth plus half a tile along the front vector, with no sideways overshoot.
      const along = dx * front.x + dz * front.z;
      const depth = Math.abs(front.z) > 0.5 ? p.h : p.w;
      expect(along, `rotation ${rotation}`).toBeCloseTo(depth / 2 + 0.5, 6);
      const across = Math.abs(dx * front.z - dz * front.x);
      const width = Math.abs(front.z) > 0.5 ? p.w : p.h;
      expect(across, `rotation ${rotation}`).toBeLessThanOrEqual(width / 2);
      // And the sitter faces back at the desk: the seat's facing is opposite the front vector.
      const facingDir = [
        { x: 0, z: -1 },
        { x: 1, z: 0 },
        { x: 0, z: 1 },
        { x: -1, z: 0 },
      ][seat.facing];
      expect(facingDir).toBeDefined();
      if (!facingDir) return;
      expect(facingDir.x * front.x + facingDir.z * front.z).toBeCloseTo(-1, 6);
    }
  });

  it('agrees with the interaction side of the other station kinds', () => {
    const DIRS = [
      { x: 0, z: -1 },
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      { x: -1, z: 0 },
    ] as const;
    for (const kind of [
      'sofa',
      'whiteboard',
      'bookshelf',
      'coffee_machine',
      'library_pc',
    ] as const) {
      for (const rotation of [0, 1, 2, 3]) {
        const p = placement(kind, 5, 5, rotation);
        const front = frontVector(p.yaw);
        const first = interactionTiles(kind, 5, 5, rotation)[0];
        expect(first).toBeDefined();
        if (!first) return;
        const facing = DIRS[first.facing];
        const along = (first.x - p.x) * front.x + (first.y - p.z) * front.z;
        if (kind === 'sofa') {
          // Seats on the footprint: the sitter looks the way the sofa faces.
          expect(along, `${kind} r${rotation}`).toBeCloseTo(0, 6);
          expect(facing.x * front.x + facing.z * front.z, `${kind} r${rotation}`).toBeCloseTo(1, 6);
        } else {
          // Stand/seat tiles outside the footprint: in front of the piece, looking back at it.
          expect(along, `${kind} r${rotation}`).toBeGreaterThan(0);
          expect(facing.x * front.x + facing.z * front.z, `${kind} r${rotation}`).toBeCloseTo(
            -1,
            6,
          );
        }
      }
    }
  });
});

describe('fit rules', () => {
  it('fits a 2×0.8×1 box into a 2×1 footprint with the margin on the tighter axis', () => {
    const s = fitToFootprint({ x: 2, y: 0.8, z: 1 }, 2, 1);
    expect(s).toBeCloseTo(Math.min((2 - FIT_MARGIN) / 2, (1 - FIT_MARGIN) / 1), 9);
    expect(s).toBeCloseTo(0.9, 9);
    expect(0.8 * s).toBeCloseTo(0.72, 9);
    // A deep model is limited by the footprint depth, not its width.
    expect(fitToFootprint({ x: 7.345, y: 3.844, z: 3.9 }, 2, 1)).toBeCloseTo(0.9 / 3.9, 9);
  });

  it('fills the rug footprint on X and Z independently and keeps it thin', () => {
    const s = fillFootprint({ x: 15.7, y: 0.1, z: 9.2 }, 2, 2);
    expect(s.x).toBeCloseTo(1.9 / 15.7, 9);
    expect(s.z).toBeCloseTo(1.9 / 9.2, 9);
    expect(s.y).toBeCloseTo(Math.min(s.x, s.z), 9);
    expect(0.1 * s.y).toBeLessThan(0.02);
    const rugPart = MODEL_MANIFEST.rug.parts[0];
    expect(rugPart?.kind).toBe('gltf');
    if (rugPart?.kind !== 'gltf') return;
    const scaled = partScale(rugPart, { x: 15.7, y: 0.1, z: 9.2 }, 2, 2);
    expect(scaled.x * 15.7).toBeCloseTo(1.9, 9);
    expect(scaled.z * 9.2).toBeCloseTo(1.9, 9);
    expect(rugPart.castShadow).toBe(false);
    expect(rugPart.lift).toBeGreaterThan(0);
  });

  it('swaps X and Z for a 90° yaw offset before fitting', () => {
    expect(orientedSize({ x: 4, y: 1, z: 2 }, Math.PI / 2)).toEqual({ x: 2, y: 1, z: 4 });
    expect(orientedSize({ x: 4, y: 1, z: 2 }, Math.PI)).toEqual({ x: 4, y: 1, z: 2 });
    const door = MODEL_MANIFEST.door.parts[0];
    if (door?.kind !== 'gltf') throw new Error('door part');
    // The doorway (4.86 wide along model X) lands along local Z at a fixed metric scale.
    const s = partScale(door, { x: 4.86, y: 10.1, z: 0.89 }, 1, 1);
    expect(s.x).toBeCloseTo(0.2, 9);
    expect(4.86 * s.x).toBeLessThan(1);
  });

  it('uses the fixed scale for `none` and the footprint ratio for `footprint`', () => {
    const chair = MODEL_MANIFEST.chair.parts[0];
    const desk = MODEL_MANIFEST.desk.parts[0];
    if (chair?.kind !== 'gltf' || desk?.kind !== 'gltf') throw new Error('parts');
    expect(partScale(chair, { x: 3.35, y: 6.08, z: 3.14 }, 1, 1)).toEqual({
      x: 0.2,
      y: 0.2,
      z: 0.2,
    });
    const d = partScale(desk, { x: 7.345, y: 3.844, z: 3.9 }, 2, 1);
    expect(d.x).toBeCloseTo(0.9 / 3.9, 9);
    expect(d.y).toBe(d.x);
    // The desk top then sits below an avatar's shoulders.
    expect(3.844 * d.y).toBeLessThan(1);
  });
});

describe('procedural builders', () => {
  it('build a server rack that fits its 1×1 footprint, sits on the floor and has its LEDs', () => {
    const res = new Resources();
    const { group, top } = buildServerRack(res);
    const box = boxOf(group);
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(1 - FIT_MARGIN);
    expect(box.max.z - box.min.z).toBeLessThanOrEqual(1 - FIT_MARGIN);
    expect(box.max.y).toBeCloseTo(top, 6);
    expect(top).toBeGreaterThan(1.5);
    expect(instanceCount(group, 'leds')).toBe(RACK_LED_COUNT);
    expect(RACK_LED_COUNT).toBeGreaterThanOrEqual(6);
    expect(RACK_LED_COUNT).toBeLessThanOrEqual(8);
    res.dispose();
  });

  it('build a whiteboard that fits its 2×1 footprint with strokes on the front (+Z) face', () => {
    const { group } = buildWhiteboard();
    const box = boxOf(group);
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(2 - FIT_MARGIN);
    expect(box.max.z - box.min.z).toBeLessThanOrEqual(1 - FIT_MARGIN);
    expect(box.max.y).toBeLessThan(2.5);
    expect(instanceCount(group, 'strokes')).toBe(BOARD_STROKE_COUNT);
    let strokes: InstancedMesh | null = null;
    group.traverse((o) => {
      if (o instanceof InstancedMesh && o.name === 'strokes') strokes = o;
    });
    expect(strokes).not.toBeNull();
    if (!strokes) return;
    const strokeBox = boxOf(strokes);
    // Strokes are in front of the board centre (board is centred on z = 0).
    expect(strokeBox.min.z).toBeGreaterThan(0);
  });

  it('build bases whose top matches their bounding box', () => {
    for (const build of [buildCounter, buildTable]) {
      const { group, top } = build();
      const box = boxOf(group);
      expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.y).toBeCloseTo(top, 6);
      expect(box.max.x - box.min.x).toBeLessThanOrEqual(1 - FIT_MARGIN + 0.05);
    }
  });

  it('build a fallback box per kind at the Pixi placeholder height', () => {
    for (const kind of KINDS) {
      const { group, top } = buildFallbackBox(kind);
      const box = boxOf(group);
      const { w, h } = rotatedSize(kind, 0);
      expect(box.min.y, kind).toBeGreaterThanOrEqual(-1e-6);
      expect(box.max.x - box.min.x, kind).toBeCloseTo(w - FIT_MARGIN, 6);
      expect(box.max.z - box.min.z, kind).toBeCloseTo(h - FIT_MARGIN, 6);
      expect(box.max.y, kind).toBeCloseTo(top, 6);
      expect(top, kind).toBeCloseTo(Math.max(0.02, FURNITURE_CATALOG[kind].height / 39.19), 2);
    }
  });

  it('dispose what they allocate through Resources', () => {
    const res = new Resources();
    const { group } = buildServerRack(res);
    let disposed = 0;
    group.traverse((o) => {
      if ('geometry' in o && o.geometry && typeof o.geometry === 'object')
        (o.geometry as { addEventListener: (t: string, f: () => void) => void }).addEventListener(
          'dispose',
          () => disposed++,
        );
    });
    res.dispose();
    expect(disposed).toBeGreaterThan(0);
  });
});
