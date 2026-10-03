import type { Avatar } from '@deskhaven/shared';
import { Box3, Mesh, MeshStandardMaterial, type Object3D, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { contrastColor, internTint, parseHex } from '../src/game/color.js';
import {
  accessoryBone,
  accessoryMesh,
  applyOutfitColors,
  collectMaterials,
  disposeMaterials,
  EXTRA_NODES,
  hairStyleMesh,
  materialsFor,
  OutfitResources,
  PART_NODES,
  propMesh,
  slotColor,
  slotForNode,
} from '../src/game/three/outfit.js';

const AVATAR: Avatar = {
  skin: '#f1c27d',
  hair: '#4a2c17',
  hairStyle: 'short',
  shirt: '#3a86ff',
  pants: '#3d405b',
  accessory: 'none',
};

const HAIR_STYLES: Avatar['hairStyle'][] = ['short', 'long', 'cap', 'bald', 'bun'];
const ACCESSORIES: Avatar['accessory'][] = ['none', 'glasses', 'headset', 'tie', 'scarf'];

function bounds(group: Object3D): Box3 {
  group.updateMatrixWorld(true);
  return new Box3().setFromObject(group);
}

function countMeshes(group: Object3D): number {
  let n = 0;
  group.traverse((o) => {
    if (o instanceof Mesh) n++;
  });
  return n;
}

describe('slotForNode', () => {
  it('maps the six body-part nodes and rejects anything else', () => {
    expect(slotForNode('Rogue_Head')).toBe('skin');
    expect(slotForNode('Rogue_Body')).toBe('shirt');
    expect(slotForNode('Rogue_ArmLeft')).toBe('shirt');
    expect(slotForNode('Rogue_ArmRight')).toBe('shirt');
    expect(slotForNode('Rogue_LegLeft')).toBe('pants');
    expect(slotForNode('Rogue_LegRight')).toBe('pants');
    for (const name of ['Cube.199', 'Rogue_Cape', 'Knife', 'head', '', 'rogue_body'])
      expect(slotForNode(name), name).toBeNull();
    for (const name of PART_NODES) expect(slotForNode(name)).not.toBeNull();
    for (const name of EXTRA_NODES) expect(slotForNode(name)).toBeNull();
  });
});

describe('materialsFor', () => {
  it('builds matte standard materials from the DTO colours', () => {
    const mats = materialsFor(AVATAR, false);
    expect(mats.skin.color.getHex()).toBe(parseHex(AVATAR.skin, 0));
    expect(mats.shirt.color.getHex()).toBe(parseHex(AVATAR.shirt, 0));
    expect(mats.pants.color.getHex()).toBe(parseHex(AVATAR.pants, 0));
    for (const m of [mats.skin, mats.shirt, mats.pants]) {
      expect(m).toBeInstanceOf(MeshStandardMaterial);
      expect(m.roughness).toBeCloseTo(0.85, 6);
      expect(m.metalness).toBe(0);
    }
  });

  it('tints interns and falls back on bad hex strings', () => {
    const mats = materialsFor({ ...AVATAR, shirt: 'not a colour' }, true);
    expect(mats.skin.color.getHex()).toBe(internTint(parseHex(AVATAR.skin, 0)));
    expect(mats.shirt.color.getHex()).toBe(slotColor({ ...AVATAR, shirt: '??' }, 'shirt', true));
    applyOutfitColors(mats, { ...AVATAR, shirt: '#ff0000' }, false);
    expect(mats.shirt.color.getHex()).toBe(0xff0000);
  });
});

describe('hairStyleMesh', () => {
  it('builds every style on the skull (within the measured head box) and bald is empty', () => {
    const res = new OutfitResources();
    for (const style of HAIR_STYLES) {
      const group = hairStyleMesh(style, 0x4a2c17, res);
      if (style === 'bald') {
        expect(countMeshes(group)).toBe(0);
        continue;
      }
      expect(countMeshes(group)).toBeGreaterThan(0);
      const box = bounds(group);
      // Head bone frame, model units: the skull is ±0.56 wide and reaches +0.95; long hair falls to
      // the shoulders (−0.14) and the cap's visor sticks out in front of the face (+0.52).
      expect(box.min.x, style).toBeGreaterThan(-0.8);
      expect(box.max.x, style).toBeLessThan(0.8);
      expect(box.min.z, style).toBeGreaterThan(-0.8);
      expect(box.max.z, style).toBeLessThan(0.8);
      expect(box.min.y, style).toBeGreaterThan(-0.35);
      expect(box.max.y, style).toBeLessThan(1.3);
      // Hair sits on top of the skull, never below the eye line.
      expect(box.max.y, style).toBeGreaterThan(0.9);
      group.traverse((o) => {
        if (o instanceof Mesh) expect(o.castShadow).toBe(true);
      });
    }
    res.dispose();
  });

  it('darkens the cap and keeps the hair colour otherwise', () => {
    const res = new OutfitResources();
    const cap = hairStyleMesh('cap', 0x808080, res);
    const short = hairStyleMesh('short', 0x808080, res);
    const capColor = [...collectMaterials(cap)][0] as MeshStandardMaterial;
    const shortColor = [...collectMaterials(short)][0] as MeshStandardMaterial;
    expect(shortColor.color.getHex()).toBe(0x808080);
    expect(capColor.color.getHex()).toBeLessThan(0x808080);
    res.dispose();
  });
});

describe('accessoryMesh', () => {
  it('builds every accessory near its bone and none is empty', () => {
    const res = new OutfitResources();
    for (const kind of ACCESSORIES) {
      const group = accessoryMesh(kind, { ...AVATAR, accessory: kind }, false, res);
      if (kind === 'none') {
        expect(countMeshes(group)).toBe(0);
        expect(accessoryBone(kind)).toBeNull();
        continue;
      }
      expect(countMeshes(group)).toBeGreaterThan(0);
      const box = bounds(group);
      const size = box.getSize(new Vector3());
      expect(size.length(), kind).toBeGreaterThan(0.1);
      if (accessoryBone(kind) === 'head') {
        expect(box.min.x, kind).toBeGreaterThan(-0.8);
        expect(box.max.x, kind).toBeLessThan(0.8);
        expect(box.min.y, kind).toBeGreaterThan(0);
        expect(box.max.y, kind).toBeLessThan(1.3);
        expect(box.max.z, kind).toBeLessThan(0.8);
      } else {
        expect(accessoryBone(kind)).toBe('chest');
        expect(box.min.x, kind).toBeGreaterThan(-0.5);
        expect(box.max.x, kind).toBeLessThan(0.5);
        expect(box.min.y, kind).toBeGreaterThan(-0.5);
        expect(box.max.y, kind).toBeLessThan(0.4);
        expect(box.max.z, kind).toBeLessThan(0.6);
      }
    }
    res.dispose();
  });

  it('colours the tie against the shirt and the scarf like the pants', () => {
    const res = new OutfitResources();
    const tie = accessoryMesh('tie', AVATAR, false, res);
    const scarf = accessoryMesh('scarf', AVATAR, false, res);
    const tieMat = [...collectMaterials(tie)][0] as MeshStandardMaterial;
    const scarfMat = [...collectMaterials(scarf)][0] as MeshStandardMaterial;
    expect(tieMat.color.getHex()).toBe(contrastColor(parseHex(AVATAR.shirt, 0)));
    expect(scarfMat.color.getHex()).toBe(parseHex(AVATAR.pants, 0));
    res.dispose();
  });

  it('glasses sit at eye height in front of the face', () => {
    const res = new OutfitResources();
    const box = bounds(accessoryMesh('glasses', AVATAR, false, res));
    expect(box.min.y).toBeGreaterThan(0.2);
    expect(box.max.y).toBeLessThan(0.6);
    expect(box.min.z).toBeGreaterThan(0.4);
    res.dispose();
  });
});

describe('propMesh', () => {
  it('builds a flat book and an upright mug around their origin', () => {
    const res = new OutfitResources();
    const book = bounds(propMesh('book', res));
    expect(book.getSize(new Vector3()).y).toBeLessThan(0.1);
    expect(book.getSize(new Vector3()).x).toBeGreaterThan(0.3);
    const mug = bounds(propMesh('mug', res));
    expect(mug.getSize(new Vector3()).y).toBeGreaterThan(0.2);
    expect(mug.min.x).toBeLessThan(-0.15);
    res.dispose();
  });

  it('shares geometries and disposes materials per instance', () => {
    const res = new OutfitResources();
    const a = propMesh('mug', res);
    const b = propMesh('mug', res);
    const geoA = new Set<unknown>();
    const geoB = new Set<unknown>();
    a.traverse((o) => {
      if (o instanceof Mesh) geoA.add(o.geometry);
    });
    b.traverse((o) => {
      if (o instanceof Mesh) geoB.add(o.geometry);
    });
    for (const g of geoA) expect(geoB.has(g)).toBe(true);
    const mats = collectMaterials(a);
    expect(mats.size).toBeGreaterThan(0);
    let disposed = 0;
    for (const m of mats) m.addEventListener('dispose', () => disposed++);
    disposeMaterials(a);
    expect(disposed).toBe(mats.size);
    res.dispose();
  });
});
