/* =====================================================================
   Garage Detailing — интерактивный параллакс фона главного экрана
   Vanilla JS, без зависимостей. Мышь, стилус и палец — одно событие pointer*.
   ===================================================================== */
(function () {
  'use strict';
  var hero = document.querySelector('.hero');
  if (!hero) return;
  var layers = Array.prototype.slice.call(hero.querySelectorAll('.hero-layer'));
  if (!layers.length) return;

  // Уважение системной настройки «уменьшить движение»
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;

  // ---- Настройки
  var MAX_DESKTOP = 18;   // макс. сдвиг на ПК, px в каждую сторону
  var MAX_MOBILE = 8;     // на экранах < 768px — меньше, чтобы картинка не «улетала»
  var EASE = 0.08;        // коэффициент Lerp за кадр при 60 fps: меньше → «ленивее» и мягче
  var EPS = 0.05;         // px: ближе этого считаем, что слой «доехал» → цикл засыпает
  var mobileMq = window.matchMedia('(max-width: 767px)');
  function maxShift() { return mobileMq.matches ? MAX_MOBILE : MAX_DESKTOP; }

  // Нормированная цель: от -1 до 1 по каждой оси (0,0 — центр блока)
  var target = { x: 0, y: 0 };
  // Текущее (сглаженное) положение в тех же единицах
  var current = { x: 0, y: 0 };
  var rect = null, rafId = 0, lastTime = 0, visible = true;

  // Глубина слоя (data-depth): 1 — картинка, отрицательная — слой движется навстречу (неоновый отсвет)
  var depths = layers.map(function (el) { return parseFloat(el.getAttribute('data-depth')) || 1; });

  function measure() { rect = hero.getBoundingClientRect(); }

  // Координаты указателя → цель в диапазоне [-1; 1]
  function setTargetFromEvent(e) {
    if (!rect) measure();
    var nx = (e.clientX - rect.left) / rect.width;   // 0..1 слева направо
    var ny = (e.clientY - rect.top) / rect.height;   // 0..1 сверху вниз
    // (n - 0.5) * 2 переводит 0..1 в -1..1; знак «минус» — картинка уходит ОТ курсора,
    // как дальний план за стеклом: так глубина читается естественнее.
    target.x = -clamp((nx - 0.5) * 2, -1, 1);
    target.y = -clamp((ny - 0.5) * 2, -1, 1);
    hero.classList.add('is-active');
    wake();
  }
  function resetTarget() {
    // Плавный возврат в центр: меняем только цель, движение сделает тот же Lerp
    target.x = 0; target.y = 0;
    hero.classList.remove('is-active');
    wake();
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---- Главный цикл анимации
  function frame(now) {
    // dt в «кадрах по 60 fps». На 120 Гц dt≈0.5, на 30 Гц dt≈2.
    var dt = lastTime ? Math.min((now - lastTime) / 16.667, 4) : 1;
    lastTime = now;

    // Lerp: current += (target - current) * k
    // Каждый кадр закрываем долю k оставшегося расстояния → быстрый старт и мягкое «доезжание» (инерция).
    // Чтобы скорость не зависела от частоты экрана, пересчитываем k под реальный dt:
    //   за 1 кадр остаётся (1 - EASE) пути, за dt кадров — (1 - EASE)^dt  →  k = 1 - (1 - EASE)^dt
    var k = 1 - Math.pow(1 - EASE, dt);
    current.x += (target.x - current.x) * k;
    current.y += (target.y - current.y) * k;

    var m = maxShift();
    for (var i = 0; i < layers.length; i++) {
      var d = depths[i];
      // Только transform: translate3d → композитинг на GPU, без reflow/repaint страницы
      layers[i].style.transform = 'translate3d(' + (current.x * m * d).toFixed(2) + 'px,' + (current.y * m * d).toFixed(2) + 'px,0)';
    }

    // Засыпаем, когда доехали (не тратим батарею на пустые кадры)
    var restX = Math.abs(target.x - current.x) * m, restY = Math.abs(target.y - current.y) * m;
    if (restX < EPS && restY < EPS) { current.x = target.x; current.y = target.y; rafId = 0; lastTime = 0; return; }
    rafId = requestAnimationFrame(frame);
  }
  function wake() { if (!rafId && visible && !reduce.matches) rafId = requestAnimationFrame(frame); }

  // ---- События: pointer* одинаково работают для мыши, пера и пальца
  hero.addEventListener('pointerenter', measure, { passive: true });
  hero.addEventListener('pointerdown', function (e) { measure(); setTargetFromEvent(e); }, { passive: true }); // касание сразу «подталкивает» картинку
  hero.addEventListener('pointermove', function (e) {
    // На телефоне pointermove приходит только пока палец на экране — то, что нужно
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    setTargetFromEvent(e); // в обработчике только запоминаем цель; двигает картинку rAF-цикл
  }, { passive: true });
  hero.addEventListener('pointerleave', resetTarget, { passive: true });   // курсор ушёл за пределы блока
  hero.addEventListener('pointerup', function (e) { if (e.pointerType !== 'mouse') resetTarget(); }, { passive: true }); // палец оторвался
  hero.addEventListener('pointercancel', resetTarget, { passive: true });  // браузер забрал жест под прокрутку

  window.addEventListener('resize', function () { rect = null; wake(); }, { passive: true });
  window.addEventListener('scroll', function () { rect = null; }, { passive: true });

  // Блок за экраном — цикл не крутим
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) {
      visible = en[0].isIntersecting;
      if (!visible && rafId) { cancelAnimationFrame(rafId); rafId = 0; lastTime = 0; } else wake();
    }).observe(hero);
  }
  // Пользователь включил «уменьшить движение» на лету → возвращаем в центр и выключаемся
  if (reduce.addEventListener) reduce.addEventListener('change', function () { if (reduce.matches) { target.x = target.y = current.x = current.y = 0; layers.forEach(function (el) { el.style.transform = ''; }); } });
})();
