// Prints scene summary for .glb/.gltf: nodes (bones), meshes, materials, animations.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
let json;
const buf = readFileSync(file);
if (buf.readUInt32LE(0) === 0x46546c67) {
  // 'glTF' magic
  const len = buf.readUInt32LE(12);
  json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
} else json = JSON.parse(buf.toString('utf8'));
const names = (a) => (a ?? []).map((x) => x.name ?? '?');
const meshes = json.meshes ?? [];
console.log(`# ${file}`);
console.log(`nodes(${(json.nodes ?? []).length}): ${names(json.nodes).slice(0, 80).join(', ')}`);
console.log(
  `meshes(${meshes.length}): ${meshes.map((m) => `${m.name ?? '?'}[prims=${m.primitives.length} mats=${m.primitives.map((p) => p.material).join('/')} ${m.primitives[0]?.attributes?.COLOR_0 !== undefined ? 'vcol' : ''}${m.primitives[0]?.attributes?.JOINTS_0 !== undefined ? ' skinned' : ''}]`).join(', ')}`,
);
console.log(
  `materials(${(json.materials ?? []).length}): ${(json.materials ?? [])
    .map(
      (m) =>
        `${m.name ?? '?'}${m.pbrMetallicRoughness?.baseColorTexture ? '(tex)' : ''}${
          m.pbrMetallicRoughness?.baseColorFactor
            ? '(' +
              m.pbrMetallicRoughness.baseColorFactor
                .slice(0, 3)
                .map((v) => v.toFixed(2))
                .join(',') +
              ')'
            : ''
        }`,
    )
    .join(', ')}`,
);
console.log(
  `textures: ${(json.images ?? []).map((i) => i.uri ?? i.name ?? 'embedded').join(', ')}`,
);
console.log(
  `skins: ${(json.skins ?? []).map((s) => `${s.name ?? '?'}[${s.joints.length} joints]`).join(', ')}`,
);
console.log(`animations(${(json.animations ?? []).length}): ${names(json.animations).join(', ')}`);
console.log('');
