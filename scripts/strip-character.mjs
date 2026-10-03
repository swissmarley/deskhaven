// Usage: node strip-character.mjs <in.glb> <out.glb> <clipA,clipB,...> <keepNodeRegex>
// Needs @gltf-transform/{core,functions,extensions}@4 resolvable from the working directory (they are
// not repo dependencies): run it from a scratch folder after `pnpm add @gltf-transform/core@4
// @gltf-transform/functions@4 @gltf-transform/extensions@4`, or install them globally.
// Example (the committed character): node strip-character.mjs Rogue.glb rogue.glb \
//   Idle,Walking_A,Running_A,Sit_Chair_Idle,Interact,Cheer '^Rogue_(Body|Head|ArmLeft|ArmRight|LegLeft|LegRight)$'
// Keeps only the listed animation clips and the nodes matching the regex (plus their bones),
// drops textures/materials that end up unused, then dedups and prunes.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, resample } from '@gltf-transform/functions';

const [, , input, output, clipList, keepRegex] = process.argv;
const keepClips = new Set(clipList.split(','));
const keepNode = new RegExp(keepRegex);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(input);
const root = doc.getRoot();
for (const anim of root.listAnimations()) if (!keepClips.has(anim.getName())) anim.dispose();
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (mesh && !keepNode.test(node.getName())) {
    node.setMesh(null);
  }
}
for (const mat of root.listMaterials()) {
  // Body parts get flat colours at runtime; the atlas is dead weight.
  mat.setBaseColorTexture(null);
}
await doc.transform(
  dedup(),
  prune(),
  resample(),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }),
  prune(),
);
await io.write(output, doc);
const sizes = {
  in: (await import('node:fs')).statSync(input).size,
  out: (await import('node:fs')).statSync(output).size,
};
console.log(
  JSON.stringify({
    sizes,
    clips: root.listAnimations().map((a) => a.getName()),
    meshNodes: root
      .listNodes()
      .filter((n) => n.getMesh())
      .map((n) => n.getName()),
    textures: root.listTextures().length,
  }),
);
