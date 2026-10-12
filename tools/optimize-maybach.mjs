// Оптимизация исходной модели Sketchfab «Mercedes-Benz Maybach 2022» для сайта.
// Запуск (нужны dev-пакеты, в рабочий сайт они не входят):
//   npm i --no-save @gltf-transform/core@4 @gltf-transform/functions@4 @gltf-transform/extensions@4 meshoptimizer
//   node tools/optimize-maybach.mjs исходник.glb public/models/mercedes-maybach-2022.glb [ratio]
// Что делает: удаляет невидимые/лишние детали и салон, даёт деталям понятные имена
// (body_paint, glass_window, tire, rim, headlight_lens, tail_light, chrome, plastic_dark),
// разворачивает носом по +X, упрощает сетку (meshoptimizer), квантует и сжимает (EXT_meshopt_compression).
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { weld, simplifyPrimitive, dedup, prune, quantize, meshopt, join, flatten } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';

const [src, dst, ratioArg] = process.argv.slice(2);
const RATIO = Number(ratioArg || 0.1);
const BODY_RATIO = Number(process.env.BODY_RATIO || 0.3);
const BODY_ERR = Number(process.env.BODY_ERR || 0.0002), ERR = Number(process.env.ERR || 0.001);

// Роли деталей по именам узлов исходника (Object_N) — подобраны по габаритам и материалам
const ROLE = {
  body_paint: [2, 4, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27],
  headlight_lens: [3, 9, 10],
  tail_light: [5, 12, 13, 52],
  chrome: [28, 30, 31, 32, 33],
  rim: [29, 34, 56, 57, 58, 59],
  tire: [37, 38],
  plastic_dark: [8, 11, 35, 36, 39, 40, 41, 42, 43, 44, 45, 46, 50, 51, 54, 55],
  glass_window: [49],
  remove: [6, 7, 47, 48, 53] // пустые кубы, колпаки фар (перекрывают оптику), салон
};
const SMOOTH = ['body_paint', 'glass_window'];
const roleOf = {};
for (const [r, ids] of Object.entries(ROLE)) ids.forEach((i) => (roleOf['Object_' + i] = r));

// Гладкие нормали (взвешенные по площади) для примитивов без NORMAL
function smoothNormals(d) {
  for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    if (p.getAttribute('NORMAL')) continue;
    const pos = p.getAttribute('POSITION').getArray(), idx = p.getIndices().getArray();
    const n = new Float32Array(pos.length);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
    p.setAttribute('NORMAL', d.createAccessor().setType('VEC3').setArray(n).setBuffer(p.getAttribute('POSITION').getBuffer()));
  }
}

await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptEncoder });
const doc = await io.read(src);
const root = doc.getRoot();
const mats = {};
const matFor = (r) => mats[r] || (mats[r] = doc.createMaterial(r).setBaseColorFactor([0.1, 0.1, 0.1, 1]).setExtras({ role: r }));

for (const node of root.listNodes()) {
  const n = node.getName();
  if (n === 'Sketchfab_model') node.setMatrix([-1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1]); // Z-up → Y-up, нос по +X
  const mesh = node.getMesh(); if (!mesh) continue;
  const r = roleOf[n];
  if (!r) console.warn('нет роли для', n);
  if (r === 'remove' || !r) { node.dispose(); continue; }
  node.setName(r + '_' + n.replace('Object_', ''));
  mesh.setName(r);
  for (const p of mesh.listPrimitives()) {
    p.setMaterial(matFor(r));
    for (const s of p.listSemantics()) if (s !== 'POSITION' && s !== 'NORMAL') p.setAttribute(s, null);
  }
}
for (const m of root.listMaterials()) if (!Object.values(mats).includes(m)) m.dispose();

await doc.transform(
  prune(), dedup({ propertyTypes: ['Accessor', 'Mesh'] }), flatten(), join({ keepNamed: false }),
  // кузов и стёкла: пересчёт гладких нормалей (у исходника «рябь» на панелях)
  (d) => { for (const m of d.getRoot().listMaterials()) if (SMOOTH.includes(m.getName())) for (const p of m.listParents()) if (p.propertyType === 'Primitive') p.setAttribute('NORMAL', null); },
  weld(),
  smoothNormals,
  // кузов упрощаем бережнее (иначе «волны» на отражениях), остальное — сильнее
  (d) => { for (const m of d.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
    const r = p.getMaterial().getName();
    if (r === 'glass_window' || r === 'headlight_lens') continue;
    const o = r === 'body_paint' ? { ratio: BODY_RATIO, error: BODY_ERR } : { ratio: RATIO, error: ERR };
    simplifyPrimitive(p, { simplifier: MeshoptSimplifier, ...o });
  } },
  prune(), quantize({ quantizePosition: 14, quantizeNormal: 10 }),
  meshopt({ encoder: MeshoptEncoder, level: 'high' })
);
let tris = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) console.log('  ', p.getMaterial().getName(), p.getIndices().getCount() / 3);
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3;
await io.write(dst, doc);
console.log('meshes', root.listMeshes().length, 'triangles', tris);
