import { type BufferGeometry, Group, type Material, Matrix4, Mesh, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { OutfitResources } from './outfit.js';

/**
 * Draw-call trim for the procedural attachments (`outfit.ts` builds hair and accessories from
 * several primitives that share one material): bake each mesh's local transform into a clone of
 * its geometry and merge everything that shares a material into one mesh, so a hair style or an
 * accessory costs one draw call. The merged geometry depends only on the shape (not on the
 * avatar's colours), so it is cached in the scene's `OutfitResources` under `key`; the materials
 * stay per avatar. Imports `three/addons`, so tests never import this module.
 */

interface Collected {
  geometry: BufferGeometry;
  material: Material;
  /** Transform of the mesh relative to the group root. */
  matrix: Matrix4;
}

function collect(node: Object3D, parent: Matrix4, out: Collected[]): void {
  for (const child of node.children) {
    child.updateMatrix();
    const matrix = parent.clone().multiply(child.matrix);
    if (child instanceof Mesh && !Array.isArray(child.material))
      out.push({ geometry: child.geometry, material: child.material, matrix });
    collect(child, matrix, out);
  }
}

/**
 * Returns a group with one mesh per material, or the original group when there is nothing to
 * merge (0–1 meshes, multi-material meshes, or incompatible attribute layouts). The original
 * group is left untouched when it is returned; otherwise its meshes are dropped (geometries were
 * shared through the resources, so nothing is disposed here).
 */
export function mergeAttachment(group: Group, res: OutfitResources, key: string): Group {
  const meshes: Collected[] = [];
  collect(group, new Matrix4(), meshes);
  if (meshes.length <= 1) return group;
  const byMaterial = new Map<Material, Collected[]>();
  for (const m of meshes) {
    const list = byMaterial.get(m.material);
    if (list) list.push(m);
    else byMaterial.set(m.material, [m]);
  }
  if (byMaterial.size === meshes.length) return group;
  const out = new Group();
  out.name = group.name;
  let index = 0;
  for (const [material, list] of byMaterial) {
    const cacheKey = `merged:${key}:${index++}`;
    let failed = false;
    const geometry = res.get(cacheKey, () => {
      const baked = list.map((c) => c.geometry.clone().applyMatrix4(c.matrix));
      const merged = mergeGeometries(baked, false);
      for (const b of baked) b.dispose();
      if (!merged) {
        failed = true;
        return baked[0] ?? list[0]?.geometry ?? new Mesh().geometry;
      }
      return merged;
    });
    if (failed) return group;
    const mesh = new Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    out.add(mesh);
  }
  return out;
}
