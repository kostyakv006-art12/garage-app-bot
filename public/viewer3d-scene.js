/* =====================================================================
   Garage Detailing — 3D-сцена «До / После» (Three.js, загружается лениво)
   Экспортирует createViewer(container, options) → API для viewer3d.js
   ===================================================================== */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const lerp = (a, b, t) => a + (b - a) * t;
const TARGET = new THREE.Vector3(0, 0.62, 0);

/* Ракурсы камеры (позиция относительно центра машины) */
export const VIEWS = {
  three: new THREE.Vector3(5.3, 1.9, 4.9),
  front: new THREE.Vector3(6.2, 1.05, 0.001),
  rear: new THREE.Vector3(-6.2, 1.2, 0.001),
  side: new THREE.Vector3(0.001, 1.0, 6.5),
  top: new THREE.Vector3(0.3, 7.6, 0.001),
  low: new THREE.Vector3(3.5, 0.34, 3.3)
};

/* ---------------------------------------------------------------------
   Шейдерный «слой грязи»: процедурный шум в мировых координатах.
   Ничего не требует от UV-развёртки → подходит и для своей модели, и для GLB.
   uDirt — степень загрязнения детали (0..1), uScratch — паутинка/царапины.
   --------------------------------------------------------------------- */
const NOISE = /* glsl */`
uniform float uDirt; uniform float uScratch; uniform vec3 uDirtColor; uniform float uScale;
varying vec3 vWPos;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x){ vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1,0,0)), f.x), mix(h3(i + vec3(0,1,0)), h3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h3(i + vec3(0,0,1)), h3(i + vec3(1,0,1)), f.x), mix(h3(i + vec3(0,1,1)), h3(i + vec3(1,1,1)), f.x), f.y), f.z); }
float fbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n3(p); p *= 2.03; a *= 0.5; } return s; }
`;

function addDirt(material, { color = '#7a6d5c', scale = 1 } = {}) {
  const u = { uDirt: { value: 0 }, uScratch: { value: 0 }, uDirtColor: { value: new THREE.Color(color) }, uScale: { value: scale } };
  material.userData.u = u;
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float gDirt = 0.0, gScr = 0.0;
        {
          vec3 p = vWPos * uScale;
          float n = fbm(p * 2.2);
          float streak = n3(vec3(vWPos.x * 14.0, vWPos.y * 1.2, vWPos.z * 14.0));   // потёки сверху вниз
          float low = 1.0 - smoothstep(0.1, 1.15, vWPos.y);                       // низ грязнее
          float cover = clamp(uDirt * (0.3 + low * 0.95), 0.0, 1.0);
          float t = n * 0.8 + streak * 0.2 + low * 0.2;
          float m = smoothstep(1.0 - cover, 1.45 - cover, t) * 0.85;
          gDirt = clamp(max(m, uDirt * 0.42), 0.0, 1.0);                           // пятна + равномерная пыль
          gScr = uScratch * smoothstep(0.84, 0.99, n3(vWPos * 90.0));               // микроцарапины
        }
        diffuseColor.rgb = mix(diffuseColor.rgb, uDirtColor, gDirt * 0.85) + gScr * 0.012;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        roughnessFactor = min(1.0, mix(roughnessFactor, 0.92, gDirt) + gScr * 0.35);
        metalnessFactor *= 1.0 - gDirt * 0.85;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - gDirt;
          material.clearcoatRoughness = clamp(material.clearcoatRoughness + gScr * 0.4 + gDirt * 0.5, 0.0, 1.0);
        #endif`);
  };
  return material;
}

/* ---------------------------------------------------------------------
   Материалы
   --------------------------------------------------------------------- */
function makeMaterials() {
  return {
    // чёрный металлик Obsidian — на нём лучше всего видны и грязь, и глянец
    body: addDirt(new THREE.MeshPhysicalMaterial({ color: '#0d0f13', metalness: 0.55, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.03 }), { color: '#5c5248' }),
    glass: addDirt(new THREE.MeshPhysicalMaterial({ color: '#07090d', metalness: 0, roughness: 0.02, clearcoat: 1, clearcoatRoughness: 0.0, envMapIntensity: 1.2 }), { color: '#6e665c', scale: 1.4 }),
    rim: addDirt(new THREE.MeshPhysicalMaterial({ color: '#c9ccd2', metalness: 1, roughness: 0.25, clearcoat: 0.6 }), { color: '#3b3229', scale: 3 }),
    tire: addDirt(new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.85, metalness: 0 }), { color: '#6b645b', scale: 3 }),
    trim: new THREE.MeshStandardMaterial({ color: '#0a0a0b', roughness: 0.6 }),
    chrome: new THREE.MeshStandardMaterial({ color: '#e6e8ec', metalness: 1, roughness: 0.08 }),
    lens: addDirt(new THREE.MeshPhysicalMaterial({ color: '#cfd8e0', metalness: 0.2, roughness: 0.05, clearcoat: 1 }), { color: '#a08a55', scale: 2 }),
    drl: new THREE.MeshBasicMaterial({ color: new THREE.Color('#e9f3ff').multiplyScalar(2.2) }),
    tail: new THREE.MeshPhysicalMaterial({ color: '#4a0006', emissive: '#c4001a', emissiveIntensity: 0.9, roughness: 0.15, clearcoat: 1 }),
    brake: new THREE.MeshStandardMaterial({ color: '#5d5f63', metalness: 0.8, roughness: 0.45 }),
    caliper: new THREE.MeshStandardMaterial({ color: '#8a8d92', metalness: 0.6, roughness: 0.4 }),
    under: new THREE.MeshBasicMaterial({ color: '#050506' })
  };
}

/* ---------------------------------------------------------------------
   Встроенная упрощённая модель-заглушка (показывается, пока нет файла
   models/mercedes-maybach-2022.glb). Основная модель — Mercedes-Maybach 2022.
   Длина 4.99 м, ширина 1.89 м, высота 1.43 м, база 2.94 м.
   Салон и двигатель не моделируются (стёкла тонированные, непрозрачные).
   --------------------------------------------------------------------- */
const AX_F = 1.545, AX_R = -1.395, WR = 0.34, TRACK = 0.80;

// Боковой профиль → выдавливание по ширине → сужение к крыше и к бамперам (плавный кузов)
function extrudeProfile(shape, width, bevel, taper) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: width - bevel.t * 2, bevelEnabled: true, bevelThickness: bevel.t, bevelSize: bevel.s, bevelSegments: 5, curveSegments: 28 });
  g.translate(0, 0, -(width - bevel.t * 2) / 2);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, p.getZ(i) * taper(x, y)); }
  const m = mergeVertices(g, 1e-4); m.computeVertexNormals(); return m;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function buildProceduralCar(M) {
  const car = new THREE.Group(); car.name = 'placeholder-car';

  // --- кузов (нижняя часть до линии окон)
  const s = new THREE.Shape();
  s.moveTo(2.36, 0.24);
  s.quadraticCurveTo(2.47, 0.26, 2.47, 0.40);
  s.lineTo(2.46, 0.55);
  s.quadraticCurveTo(2.44, 0.66, 2.30, 0.70);                 // нос
  s.bezierCurveTo(1.80, 0.80, 1.20, 0.88, 0.80, 0.93);        // длинный капот
  s.bezierCurveTo(-0.20, 0.96, -1.40, 0.99, -1.95, 1.00);     // линия окон
  s.quadraticCurveTo(-2.32, 1.01, -2.44, 0.97);               // короткий багажник с утиным хвостом
  s.quadraticCurveTo(-2.49, 0.86, -2.47, 0.62);
  s.lineTo(-2.43, 0.38);
  s.quadraticCurveTo(-2.40, 0.25, -2.30, 0.24);
  const ar = 0.405; // радиус арки
  s.lineTo(AX_R - ar, 0.24); s.absarc(AX_R, 0.34, ar, Math.PI + 0.25, -0.25, true);
  s.lineTo(AX_F - ar, 0.24); s.absarc(AX_F, 0.34, ar, Math.PI + 0.25, -0.25, true);
  s.lineTo(2.36, 0.24);
  const body = new THREE.Mesh(extrudeProfile(s, 1.89, { t: 0.2, s: 0.035 }, (x, y) =>
    (1 - 0.13 * Math.pow(sstep(1.2, 2.5, Math.abs(x)), 1.6)) * (1 - 0.07 * sstep(0.62, 1.0, y))), M.body);
  body.name = 'body'; car.add(body);

  // --- остекление (тонированное, непрозрачное: салон не виден и не рендерится)
  const g = new THREE.Shape();
  g.moveTo(0.86, 0.90);
  g.bezierCurveTo(0.55, 1.06, 0.25, 1.30, -0.05, 1.39);       // лобовое
  g.bezierCurveTo(-0.45, 1.44, -0.95, 1.44, -1.20, 1.37);     // крыша-купе
  g.bezierCurveTo(-1.55, 1.25, -1.85, 1.07, -2.02, 0.97);     // покатое заднее стекло
  g.lineTo(-2.02, 0.90); g.lineTo(0.86, 0.90);
  const taperG = (x, y) => (1 - 0.2 * sstep(0.95, 1.43, y)) * (1 - 0.06 * sstep(0.2, 2.0, Math.abs(x + 0.5)));
  const glass = new THREE.Mesh(extrudeProfile(g, 1.62, { t: 0.16, s: 0.02 }, taperG), M.glass);
  glass.name = 'glass'; car.add(glass);

  // --- крыша в цвет кузова (тонкая панель над стеклом)
  const r = new THREE.Shape();
  r.moveTo(-0.12, 1.37);
  r.bezierCurveTo(-0.45, 1.425, -0.95, 1.425, -1.16, 1.36);
  r.lineTo(-1.14, 1.405);
  r.bezierCurveTo(-0.95, 1.46, -0.45, 1.46, -0.12, 1.405);
  r.lineTo(-0.12, 1.37);
  const roof = new THREE.Mesh(extrudeProfile(r, 1.32, { t: 0.1, s: 0.01 }, () => 1), M.body);
  roof.name = 'roof'; car.add(roof);

  // --- хромированная линия окон
  for (const side of [-1, 1]) {
    const pts = [];
    for (let i = 0; i <= 24; i++) { const x = lerp(0.8, -1.98, i / 24); pts.push(new THREE.Vector3(x, 0.92 + 0.03 * (i / 24), side * 0.805 * taperG(x, 0.92))); }
    const strip = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.008, 5), M.chrome);
    car.add(strip);
  }

  // --- фары (линзы + светодиодная «бровь»), фонари, решётка, зеркала
  for (const side of [-1, 1]) {
    // узкие фары с «бровью» дневных огней
    const lens = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.075, 0.4), M.lens); lens.position.set(2.405, 0.625, side * 0.6); lens.rotation.y = side * 0.5; lens.rotation.x = side * -0.08; lens.name = 'headlight'; car.add(lens);
    const drl = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 0.36), M.drl); drl.position.set(2.445, 0.598, side * 0.6); drl.rotation.y = side * 0.5; car.add(drl);
    // узкие фонари
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.065, 0.44), M.tail); tail.position.set(-2.495, 0.85, side * 0.5); tail.rotation.y = -side * 0.22; car.add(tail);
    const mirror = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 10), M.body); mirror.scale.set(1, 0.55, 0.85); mirror.position.set(0.55, 1.0, side * 0.98); car.add(mirror);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.014, 0.01), M.chrome);
    for (const hx of [0.05, -1.0]) { const h = handle.clone(); h.position.set(hx, 0.86, side * 0.905); car.add(h); }
    const sill = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.04, 0.02), M.chrome); sill.position.set(0.08, 0.3, side * 0.93); car.add(sill);
  }
  // решётка радиатора с двумя хромированными ламелями, нижний воздухозаборник, диффузор
  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.2, 0.78), M.trim); grille.position.set(2.495, 0.49, 0); car.add(grille);
  for (const gy of [0.46, 0.52]) { const bar = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.016, 0.76), M.chrome); bar.position.set(2.52, gy, 0); car.add(bar); }
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.08, 1.25), M.trim); intake.position.set(2.48, 0.32, 0); car.add(intake);
  const lip = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.012, 1.25), M.chrome); lip.position.set(2.50, 0.365, 0); car.add(lip);
  const diff = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.09, 1.25), M.trim); diff.position.set(-2.445, 0.33, 0); car.add(diff);
  for (const side of [-1, 1]) { const ex = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.24), M.chrome); ex.position.set(-2.465, 0.33, side * 0.45); car.add(ex); }

  // --- днище закрыто (при виде снизу внутренности не видны)
  const under = new THREE.Mesh(new THREE.PlaneGeometry(4.7, 1.6), M.under); under.rotation.x = Math.PI / 2; under.position.y = 0.2; car.add(under);

  // --- колёса R18, 5 двойных спиц
  const wheel = buildWheel(M);
  for (const [x, side] of [[AX_F, 1], [AX_F, -1], [AX_R, 1], [AX_R, -1]]) {
    const w = wheel.clone(); w.position.set(x, WR, side * TRACK); if (side < 0) w.rotation.y = Math.PI; car.add(w);
  }
  return car;
}

function buildWheel(M) {
  const w = new THREE.Group(); w.name = 'wheel';
  const prof = [[0.232, -0.11], [0.29, -0.122], [0.33, -0.105], [0.342, -0.05], [0.342, 0.05], [0.33, 0.105], [0.29, 0.122], [0.232, 0.11]].map(([r, y]) => new THREE.Vector2(r, y));
  const tg = new THREE.LatheGeometry(prof, 40); tg.rotateX(Math.PI / 2);
  const tire = new THREE.Mesh(tg, M.tire); tire.name = 'tire'; w.add(tire);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.232, 0.232, 0.22, 32, 1, true), M.trim); barrel.rotation.x = Math.PI / 2; w.add(barrel);
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 32), M.brake); disc.rotation.x = Math.PI / 2; disc.position.z = 0.02; w.add(disc);
  const cal = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.06), M.caliper); cal.position.set(-0.13, 0.06, 0.05); w.add(cal);
  const rimG = new THREE.Group(); rimG.name = 'rim';
  const lip = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.012, 8, 40), M.rim); lip.position.z = 0.1; rimG.add(lip);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.04, 20), M.rim); hub.rotation.x = Math.PI / 2; hub.position.z = 0.1; rimG.add(hub);
  const spokeG = new THREE.BoxGeometry(0.03, 0.18, 0.025); spokeG.translate(0, 0.13, 0);
  for (let i = 0; i < 5; i++) for (const o of [-0.09, 0.09]) {
    const sp = new THREE.Mesh(spokeG, M.rim); sp.rotation.z = (i / 5) * Math.PI * 2 + o; sp.position.z = 0.095; rimG.add(sp);
  }
  w.add(rimG);
  return w;
}

/* ---------------------------------------------------------------------
   Основная GLB-модель Mercedes-Maybach 2022 (models/mercedes-maybach-2022.glb).
   Поддерживает сжатие Draco и Meshopt (gltf-transform), прогресс загрузки.
   Детали распознаются по именам; салон и мотор скрываются.
   --------------------------------------------------------------------- */
const RX = {
  hide: /interior|seat|steer|dash|engine|motor|cabin|salon|pedal|belt|carpet|gear|console|door_?in|trunk_?in|headliner|speaker/i,
  glass: /glass|window|windshield|windscreen|стекл/i,
  tire: /tire|tyre|rubber|шин/i,
  rim: /rim|wheel|disk|disc|диск/i,
  lens: /head.?light|headlamp|lamp_?f|фар/i,
  tail: /tail|rear.?light|lamp_?r|стоп/i,
  chrome: /chrome|хром/i,
  trim: /plastic|trim|black|grille|рамк/i,
  body: /paint|body|carpaint|кузов/i
};
const MODEL_LENGTH = 5.47; // Mercedes-Maybach S-класса (Z223), м
async function loadGLB(url, M, onProgress) {
  // загрузчики подключены статически: весь файл и так грузится лениво
  const loader = new GLTFLoader();
  const draco = new DRACOLoader(); draco.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/libs/draco/gltf/');
  loader.setDRACOLoader(draco); loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(url, (e) => onProgress && e.total && onProgress(e.loaded / e.total));
  draco.dispose();
  const root = gltf.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const name = (o.name + ' ' + (o.material && o.material.name || '')).toLowerCase();
    if (RX.hide.test(name)) { o.visible = false; return; }
    o.material = RX.glass.test(name) ? M.glass : RX.tire.test(name) ? M.tire : RX.rim.test(name) ? M.rim : RX.lens.test(name) ? M.lens
      : RX.tail.test(name) ? M.tail : RX.chrome.test(name) ? M.chrome : RX.trim.test(name) ? M.trim : M.body;
  });
  // нормализация: реальная длина, нос по +X, колёса на земле
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  if (size.z > size.x) root.rotation.y = Math.PI / 2;
  const box2 = new THREE.Box3().setFromObject(root), s2 = box2.getSize(new THREE.Vector3());
  root.scale.multiplyScalar(MODEL_LENGTH / s2.x);
  const box3 = new THREE.Box3().setFromObject(root), c = box3.getCenter(new THREE.Vector3());
  root.position.sub(new THREE.Vector3(c.x, box3.min.y, c.z));
  return root;
}

/* ---------------------------------------------------------------------
   Сцена, свет, окружение
   --------------------------------------------------------------------- */
function studioEnvironment(renderer) {
  // RoomEnvironment + неоновые полосы в цветах сайта → отражения на кузове
  const env = new RoomEnvironment();
  const strip = (color, k, pos, rotY, w = 6, h = 0.25) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.copy(pos); m.rotation.y = rotY; env.add(m);
  };
  strip('#8b6cff', 6, new THREE.Vector3(0, 9, -9), 0);
  strip('#2ad4ff', 6, new THREE.Vector3(0, 7, 9), 0);
  strip('#ffffff', 8, new THREE.Vector3(9, 10, 0), Math.PI / 2, 10, 0.4);
  strip('#ff5fd2', 4, new THREE.Vector3(-9, 6, 0), Math.PI / 2);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(env, 0.035).texture; pm.dispose();
  return tex;
}
function contactShadow() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), gr = x.createRadialGradient(64, 64, 6, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,0.85)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.002; return m;
}

/* Состояние → параметры материалов */
function applyState(M, s) {
  const g = Math.min(1, s.gloss);
  M.body.roughness = lerp(0.42, 0.05, g);
  M.body.clearcoat = lerp(0.15, 1.0, g);
  M.body.clearcoatRoughness = Math.max(0.005, lerp(0.32, 0.02, g) - 0.012 * s.ceramic);
  M.body.envMapIntensity = lerp(0.55, 1.2, g) + 0.2 * s.ceramic;
  M.body.userData.u.uDirt.value = s.dirt;
  M.body.userData.u.uScratch.value = s.scratches;
  M.glass.userData.u.uDirt.value = s.glassDirt;
  M.rim.userData.u.uDirt.value = s.wheelDirt;
  M.rim.roughness = 0.2 + s.wheelDirt * 0.25;
  M.tire.userData.u.uDirt.value = s.tireDust;
  M.tire.roughness = lerp(0.88, 0.38, s.tireShine);
  M.lens.color.set('#cfd8e0').lerp(new THREE.Color('#9c8a5c'), s.haze);
  M.lens.roughness = 0.04 + s.haze * 0.55;
  M.lens.userData.u.uDirt.value = s.haze * 0.6;
}

/* ---------------------------------------------------------------------
   Публичный API
   --------------------------------------------------------------------- */
export async function createViewer(container, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  const coarse = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 1.75)); // на телефонах экономим GPU
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = false; // тени не считаем — только мягкая «контактная» тень-текстура
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = studioEnvironment(renderer);
  const key = new THREE.DirectionalLight('#ffffff', 1.4); key.position.set(3, 6, 4); scene.add(key);
  const fill = new THREE.HemisphereLight('#bfc8ff', '#0b0b12', 0.35); scene.add(fill);

  // пол растворяется к краям, чтобы сцена сливалась с фоном сайта
  const fc = document.createElement('canvas'); fc.width = fc.height = 256;
  const fx = fc.getContext('2d'), fg = fx.createRadialGradient(128, 128, 20, 128, 128, 128);
  fg.addColorStop(0, '#fff'); fg.addColorStop(0.55, '#888'); fg.addColorStop(1, '#000'); fx.fillStyle = fg; fx.fillRect(0, 0, 256, 256);
  const floor = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.MeshStandardMaterial({ color: '#08080d', roughness: 0.7, metalness: 0.1, transparent: true, alphaMap: new THREE.CanvasTexture(fc), depthWrite: false }));
  floor.rotation.x = -Math.PI / 2; scene.add(floor); scene.add(contactShadow());

  const M = makeMaterials();
  let car = null, source = 'procedural';
  // Список моделей по приоритету (облегчённая для телефона → полная); первая доступная загружается
  let modelUsed = null;
  for (const url of [].concat(opts.modelUrls || [], opts.modelUrl || []).filter(Boolean)) {
    try {
      // без предварительного HEAD: некоторые хостинги отвечают на него 405
      car = await loadGLB(url, M, opts.onProgress); source = 'glb'; modelUsed = url; break;
    } catch (e) { console.warn('[3D] GLB не загружен:', url, e); }
  }
  if (!car && (opts.modelUrls || opts.modelUrl)) console.warn('[3D] используется встроенная модель-заглушка');
  if (!car) car = buildProceduralCar(M);
  scene.add(car);

  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 60);
  camera.position.copy(VIEWS.three);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(TARGET);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.enablePan = false;                       // машина всегда в центре
  controls.minDistance = 3.6; controls.maxDistance = 10.5; // не залетаем в кузов и не улетаем далеко
  controls.minPolarAngle = 0.05; controls.maxPolarAngle = 1.70; // до «снизу под углом», но не под пол
  controls.rotateSpeed = 0.8; controls.zoomSpeed = 0.9;
  controls.update();

  // --- состояния До / После (текущее плавно догоняет целевое)
  const keys = ['dirt', 'glassDirt', 'wheelDirt', 'tireDust', 'tireShine', 'gloss', 'scratches', 'haze', 'ceramic'];
  const cur = { before: null, after: null }, tgt = { before: null, after: null };
  let mode = 'compare', split = 0.5, needs = true, flyTo = null, running = true, last = performance.now();

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 46 : 36; // на телефоне шире угол, чтобы машина помещалась
    camera.updateProjectionMatrix(); needs = true;
  }
  // Дистанция ракурса с учётом пропорций экрана: машина (5.47 м) целиком в кадре и на телефоне
  const FIT = { three: [2.9, 'h'], side: [3.1, 'h'], front: [1.25, 'h'], rear: [1.25, 'h'], top: [3.4, 'v'], low: [2.2, 'h'] };
  function fitRadius(name, base) {
    const f = FIT[name]; if (!f) return base;
    const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)), t = f[1] === 'h' ? tv * camera.aspect : tv;
    return Math.max(base, f[0] / t + (name === 'top' ? 0 : 1.0)); // +1 м: ближний край машины ближе к камере
  }
  const ro = new ResizeObserver(resize); ro.observe(container); resize();
  { const s0 = new THREE.Spherical().setFromVector3(camera.position.clone().sub(TARGET));
    s0.radius = Math.min(controls.maxDistance, fitRadius('three', s0.radius));
    camera.position.copy(new THREE.Vector3().setFromSpherical(s0).add(TARGET)); controls.update(); }
  controls.addEventListener('change', () => { needs = true; });

  function stepStates(dt) {
    const k = 1 - Math.exp(-dt * 4.5); let moving = false;
    for (const side of ['before', 'after']) {
      if (!tgt[side]) continue;
      if (!cur[side]) { cur[side] = { ...tgt[side] }; moving = true; continue; }
      for (const key of keys) {
        const d = tgt[side][key] - cur[side][key];
        if (Math.abs(d) > 1e-4) { cur[side][key] += d * k; moving = true; } else cur[side][key] = tgt[side][key];
      }
    }
    return moving;
  }
  function stepFly(dt) {
    if (!flyTo) return false;
    flyTo.t = Math.min(1, (performance.now() - flyTo.start) / 900); // по реальному времени, не зависит от FPS
    const e = flyTo.t < 0.5 ? 4 * flyTo.t ** 3 : 1 - (-2 * flyTo.t + 2) ** 3 / 2;
    const sph = new THREE.Spherical(lerp(flyTo.a.radius, flyTo.b.radius, e), lerp(flyTo.a.phi, flyTo.b.phi, e), lerp(flyTo.a.theta, flyTo.b.theta, e));
    camera.position.setFromSpherical(sph).add(TARGET);
    if (flyTo.t >= 1) flyTo = null;
    return true;
  }

  function render() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!cur.after) return;
    if (mode === 'compare' && cur.before) {
      const sx = Math.round(w * split);
      renderer.setScissorTest(true);
      applyState(M, cur.before); renderer.setScissor(0, 0, sx, h); renderer.render(scene, camera);
      applyState(M, cur.after); renderer.setScissor(sx, 0, w - sx, h); renderer.render(scene, camera);
      renderer.setScissorTest(false);
    } else {
      applyState(M, mode === 'before' ? cur.before : cur.after); renderer.render(scene, camera);
    }
  }

  function loop(now) {
    if (!running) return;
    const raw = (now - last) / 1000, dt = Math.min(0.05, raw); last = now;
    const a = stepStates(Math.min(0.2, raw)), // по реальному времени: на слабом телефоне переход не затягивается
       b = stepFly(dt), c = controls.update();
    if (a || b || c || needs) { render(); needs = false; }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  return {
    source,
    setStates(before, after) { tgt.before = before; tgt.after = after; needs = true; },
    setMode(m) { mode = m; needs = true; },
    setSplit(x) { split = Math.min(1, Math.max(0, x)); needs = true; },
    setView(name) {
      const v = VIEWS[name]; if (!v) return;
      const a = new THREE.Spherical().setFromVector3(camera.position.clone().sub(TARGET));
      const b = new THREE.Spherical().setFromVector3(v.clone().sub(TARGET));
      // кратчайший поворот вокруг машины (не «сквозь» кузов)
      let dTheta = b.theta - a.theta; while (dTheta > Math.PI) dTheta -= 2 * Math.PI; while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
      b.theta = a.theta + dTheta;
      b.radius = Math.min(controls.maxDistance, Math.max(controls.minDistance, fitRadius(name, b.radius)));
      b.phi = Math.min(controls.maxPolarAngle, Math.max(controls.minPolarAngle, b.phi));
      flyTo = { a, b, t: 0, start: performance.now() };
    },
    pause() { running = false; },
    resume() { if (!running) { running = true; last = performance.now(); needs = true; requestAnimationFrame(loop); } },
    debug: () => ({ source, modelUsed, camera: camera.position.toArray(), distance: camera.position.distanceTo(TARGET), cur, tgt, flying: !!flyTo, info: renderer.info.render })
  };
}
