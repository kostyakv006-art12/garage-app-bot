/* =====================================================================
   Garage Detailing — блок «3D-осмотр: до и после»
   UI и логика эффектов услуг. Three.js-сцена (viewer3d-scene.js)
   подгружается лениво, только когда блок приближается к экрану.
   ===================================================================== */

/* Телефон/планшет → облегчённая модель (data-model-lite), компьютер → полная (data-model) */
function modelList() {
  const root = document.getElementById('viewer3d'), full = root.dataset.model, lite = root.dataset.modelLite;
  const q = new URLSearchParams(location.search).get('model3d');
  const small = q ? q === 'lite' : (window.matchMedia && matchMedia('(pointer: coarse)').matches) || window.innerWidth < 900;
  return small && lite ? [lite, full] : [full];
}

/* Услуги блока (те же id, что в записи, — чтобы можно было перенести выбор в форму) */
const FALLBACK_SERVICES = [
  { id: 'wash2', name: 'Двухфазная мойка', excludes: ['wash3', 'presale'] },
  { id: 'wash3', name: 'Трёхфазная мойка', excludes: ['wash2', 'presale'] },
  { id: 'headlights', name: 'Полировка фар', excludes: [] },
  { id: 'polish_local', name: 'Локальная полировка', excludes: ['polish_full', 'presale'] },
  { id: 'polish_full', name: 'Полная полировка кузова', excludes: ['polish_local', 'presale'] },
  { id: 'ceramic', name: 'Керамическое покрытие', excludes: [] },
  { id: 'interior', name: 'Химчистка салона', excludes: [] },
  { id: 'presale', name: 'Предпродажная подготовка', excludes: ['wash2', 'wash3', 'polish_local', 'polish_full'] }
];
const SERVICES = (window.GD_CONFIG && window.GD_CONFIG.services) || FALLBACK_SERVICES;
const LEVELS = [10, 25, 40, 50, 70];
const HINT = {
  wash2: 'Чище кузов и диски', wash3: 'Почти идеально чистый кузов', headlights: 'Прозрачные фары',
  polish_local: 'Меньше царапин, ярче цвет', polish_full: 'Без паутинки, зеркальный глянец', ceramic: 'Максимальный блеск и защита',
  interior: 'Салон не показываем — чище стёкла изнутри', presale: 'Мойка, полировка, чернение резины, стёкла'
};

/* ---------------------------------------------------------------------
   Модель эффектов. Все значения 0..1.
   ДО зависит только от загрязнения; ПОСЛЕ — от выбранных услуг (эффекты суммируются).
   --------------------------------------------------------------------- */
export function computeStates(level, selected) {
  const L = level / 100, has = (id) => selected.includes(id);
  const before = {
    dirt: L, glassDirt: Math.min(1, L * 0.9), wheelDirt: Math.min(1, L * 1.25 + 0.05), tireDust: L,
    tireShine: 0, gloss: 0.5 - L * 0.15, scratches: 0.35 + L * 0.3, haze: 0.45 + L * 0.3, ceramic: 0
  };
  const a = { ...before };
  const wash = (k) => { a.dirt *= k; a.glassDirt *= k * 1.5; a.wheelDirt *= k * 1.6; a.tireDust *= k * 2; };
  if (has('wash2')) wash(0.2);
  if (has('wash3')) wash(0.06);
  // перед полировкой и керамикой авто всегда моют — грязь уходит, даже если мойку не отметили
  if ((has('polish_local') || has('polish_full') || has('ceramic')) && !has('wash2') && !has('wash3')) wash(0.08);
  // + глубокая очистка (глина, обезжиривание) перед полировкой/керамикой
  if (has('polish_local') || has('polish_full') || has('ceramic')) { a.dirt *= 0.3; a.glassDirt *= 0.5; }
  if (has('presale')) { wash(0.04); a.tireDust = 0; a.tireShine = 1; a.gloss += 0.25; a.scratches *= 0.5; a.haze *= 0.6; }
  if (has('headlights')) a.haze = 0.03;
  if (has('polish_local')) { a.scratches *= 0.55; a.gloss += 0.15; }
  if (has('polish_full')) { a.scratches = 0.03; a.gloss = Math.max(a.gloss + 0.35, 0.8); } // полная полировка восстанавливает ЛКП
  if (has('ceramic')) { a.ceramic = 1; a.gloss += 0.22; a.scratches *= 0.85; }
  if (has('interior')) a.glassDirt *= 0.6;
  for (const k in a) a[k] = Math.min(1, Math.max(0, a[k]));
  return { before, after: a };
}
/* Человекочитаемые показатели для панели */
export function metrics(s) {
  return {
    body: Math.round((1 - s.dirt) * 100), gloss: Math.round(Math.min(1, s.gloss) * (1 - s.dirt * 0.8) * 100),
    wheels: Math.round((1 - s.wheelDirt) * 100), glass: Math.round((1 - s.glassDirt) * 100),
    lights: Math.round((1 - s.haze) * 100), protect: Math.round(s.ceramic * 100)
  };
}

/* ---------------------------------------------------------------------
   UI
   --------------------------------------------------------------------- */
const root = document.getElementById('viewer3d');
if (root) init(root);

function init(root) {
  const $ = (s) => root.querySelector(s);
  const state = { level: 40, selected: ['wash3'], mode: 'compare', split: 0.5 };
  root.classList.add('v3-compare');
  let viewer = null;

  // список услуг
  $('.v3-services').innerHTML = SERVICES.map((s) => `
    <label class="v3-check"><input type="checkbox" value="${s.id}"${state.selected.includes(s.id) ? ' checked' : ''}>
      <span class="v3-box" aria-hidden="true"></span><span><b>${s.name}</b><small>${HINT[s.id] || ''}</small></span></label>`).join('');
  // уровни загрязнения
  $('.v3-levels').innerHTML = LEVELS.map((l) => `<button type="button" class="v3-chip${l === state.level ? ' on' : ''}" data-level="${l}" aria-pressed="${l === state.level}">${l}%</button>`).join('');

  const note = $('.v3-note');
  // ---- пакеты: быстрый выбор набора услуг (Экспресс → Детейлинг)
  const PRESETS = [
    { id: 'express', name: 'Экспресс', ids: ['wash2'] },
    { id: 'standard', name: 'Стандарт', ids: ['wash3'] },
    { id: 'premium', name: 'Премиум', ids: ['wash3', 'headlights', 'polish_local'] },
    { id: 'detailing', name: 'Детейлинг', ids: ['wash3', 'headlights', 'polish_full', 'ceramic'] }
  ].map((p) => ({ ...p, ids: p.ids.filter((x) => SERVICES.some((s) => s.id === x)) })).filter((p) => p.ids.length);
  const presetBox = $('.v3-presets');
  function syncPresets() {
    if (!presetBox) return;
    const key = state.selected.slice().sort().join();
    presetBox.querySelectorAll('[data-preset]').forEach((b) => {
      const on = PRESETS.find((p) => p.id === b.dataset.preset).ids.slice().sort().join() === key;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    });
  }
  if (presetBox) {
    presetBox.innerHTML = PRESETS.map((p) => `<button type="button" class="v3-chip" data-preset="${p.id}" aria-pressed="false">${p.name}</button>`).join('');
    presetBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]'); if (!b) return;
      state.selected = PRESETS.find((p) => p.id === b.dataset.preset).ids.slice();
      root.querySelectorAll('.v3-services input').forEach((x) => { x.checked = state.selected.includes(x.value); });
      note.textContent = ''; update();
    });
  }

  $('.v3-services').addEventListener('change', (e) => {
    const id = e.target.value, svc = SERVICES.find((s) => s.id === id);
    if (e.target.checked) {
      const removed = state.selected.filter((x) => svc.excludes.includes(x) || (SERVICES.find((s) => s.id === x).excludes || []).includes(id));
      state.selected = state.selected.filter((x) => !removed.includes(x)).concat(id);
      removed.forEach((x) => { root.querySelector(`.v3-services input[value="${x}"]`).checked = false; });
      note.textContent = removed.length ? `«${svc.name}» заменяет: ${removed.map((x) => SERVICES.find((s) => s.id === x).name).join(', ')}` : '';
    } else { state.selected = state.selected.filter((x) => x !== id); note.textContent = ''; }
    update();
  });
  $('.v3-levels').addEventListener('click', (e) => {
    const b = e.target.closest('[data-level]'); if (!b) return;
    state.level = +b.dataset.level;
    root.querySelectorAll('[data-level]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    update();
  });
  // режим До / Сравнение / После
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    root.querySelectorAll('[data-mode]').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
    root.classList.toggle('v3-compare', state.mode === 'compare');
    $('.v3-tag-before').hidden = state.mode === 'after'; $('.v3-tag-after').hidden = state.mode === 'before';
    viewer && viewer.setMode(state.mode);
  }));
  // ракурсы
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer && viewer.setView(b.dataset.view)));

  // слайдер сравнения: перетаскивается только «ручка», остальное — вращение камеры
  const stage = $('.v3-stage'), handle = $('.v3-split');
  const setSplit = (x) => { state.split = Math.min(0.95, Math.max(0.05, x)); stage.style.setProperty('--split', state.split * 100 + '%'); handle.setAttribute('aria-valuenow', Math.round(state.split * 100)); viewer && viewer.setSplit(state.split); };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); handle.setPointerCapture(e.pointerId);
    const move = (ev) => { const r = stage.getBoundingClientRect(); setSplit((ev.clientX - r.left) / r.width); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', up); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') setSplit(state.split - 0.05); if (e.key === 'ArrowRight') setSplit(state.split + 0.05); });
  setSplit(0.5);

  // перенести выбор в форму записи (кликаем по чекбоксам формы — её логика проверок срабатывает как обычно)
  $('.v3-book').addEventListener('click', () => {
    const boxes = [...document.querySelectorAll('#svcList input[type=checkbox]')];
    boxes.filter((b) => b.checked && !state.selected.includes(b.value)).forEach((b) => b.click());
    state.selected.forEach((id) => { const b = document.getElementById('sv-' + id); if (b && !b.checked) b.click(); });
    const booking = document.getElementById('booking'); booking && booking.scrollIntoView({ behavior: 'smooth' });
  });

  function update() {
    const { before, after } = computeStates(state.level, state.selected);
    const mb = metrics(before), ma = metrics(after);
    const rows = [['Чистота кузова', 'body'], ['Блеск ЛКП', 'gloss'], ['Диски', 'wheels'], ['Стёкла', 'glass'], ['Фары', 'lights'], ['Защита керамикой', 'protect']];
    $('.v3-metrics').innerHTML = rows.map(([t, k]) => `
      <div class="v3-m"><div class="v3-m-top"><span>${t}</span><span><s>${mb[k]}%</s> → <b>${ma[k]}%</b></span></div>
      <div class="v3-bar"><i class="v3-bar-b" style="width:${mb[k]}%"></i><i class="v3-bar-a" style="width:${ma[k]}%"></i></div></div>`).join('');
    $('.v3-book').disabled = !state.selected.length;
    viewer && viewer.setStates(before, after);
    syncPresets();
  }
  update();

  // ---- ленивая загрузка 3D
  const status = $('.v3-status');
  let started = false;
  async function start() {
    if (started) return; started = true;
    const gl = document.createElement('canvas');
    if (!(gl.getContext('webgl2') || gl.getContext('webgl'))) { status.textContent = 'Ваш браузер не поддерживает 3D (WebGL).'; return; }
    let stage3d = 'код 3D';
    try {
      // 1) локальная сборка (Three.js внутри, без CDN и import maps); 2) запасной вариант — исходник + CDN
      let mod;
      try { mod = await import(window.GD_SCENE_URL || './viewer3d-scene.min.js'); }
      catch (e1) { console.warn('[3D] локальная сборка не загрузилась, пробуем CDN', e1); mod = await import('./viewer3d-scene.js'); }
      stage3d = 'сцена';
      viewer = await mod.createViewer($('.v3-canvas'), { modelUrls: modelList(), onProgress: (k) => { status.textContent = 'Загружаем 3D-модель… ' + Math.round(k * 100) + '%'; } });
      window.__gdViewer = viewer; // для отладки / тестов
      const { before, after } = computeStates(state.level, state.selected);
      viewer.setStates(before, after); viewer.setMode(state.mode); viewer.setSplit(state.split);
      status.hidden = true; root.classList.add('v3-ready');
      // пауза рендера, когда блок не виден (экономия батареи)
      new IntersectionObserver(([en]) => (en.isIntersecting ? viewer.resume() : viewer.pause())).observe(stage);
    } catch (e) {
      console.error('[3D]', stage3d, e);
      const why = stage3d === 'сцена' ? 'видеокарта или браузер не дали запустить 3D' : 'не загрузились файлы 3D (проверьте интернет)';
      status.innerHTML = '<span>Не удалось загрузить 3D: ' + why + '.<br><small class="v3-err">' + String(e && e.message || e).replace(/[<>&]/g, '').slice(0, 140) + '</small><br><button type="button" class="v3-retry">Повторить</button></span>';
      status.querySelector('.v3-retry').addEventListener('click', () => { started = false; status.textContent = 'Загружаем 3D…'; start(); });
    }
  }
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { io.disconnect(); start(); } }, { rootMargin: '400px 0px' });
    io.observe(root);
  } else start();
}
