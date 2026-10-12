(function () {
  'use strict';
  var C = window.BookingCore, cfg = window.GD_CONFIG, API = window.GD_API || '/api', DEMO = !!window.GD_DEMO;
  var $ = function (id) { return document.getElementById(id); };
  var sc = cfg.schedule;
  var state = { carClass: cfg.carClasses[0].id, services: [], date: null, time: null, full: new Set(), now: null };
  var rub = function (n) { return n.toLocaleString('ru-RU') + ' ₽'; };
  var WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'], MON = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  var byId = {}; cfg.services.forEach(function (s) { byId[s.id] = s; });

  function toast(msg) { var t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(function () { t.classList.remove('show'); }, 3500); }
  function factor() { return cfg.carClasses.filter(function (c) { return c.id === state.carClass; })[0].factor; }
  function priceOf(s) { return Math.round(s.price * factor() / 50) * 50; }

  // ---- контакты из конфига
  document.querySelectorAll('[data-phone]').forEach(function (a) { a.href = 'tel:' + cfg.business.phone; });
  document.querySelectorAll('[data-phone-text]').forEach(function (a) { a.textContent = cfg.business.phoneDisplay; });
  // ---- данные из админ-панели
  var B = cfg.business, set = function (sel, fn) { document.querySelectorAll(sel).forEach(fn); };
  set('[data-address]', function (e) { e.textContent = B.address; });
  set('[data-city]', function (e) { e.textContent = B.city; });
  set('[data-address-full]', function (e) { e.textContent = B.city + ', ' + B.address; });
  set('[data-rating]', function (e) { e.textContent = B.rating; });
  set('[data-rating-count]', function (e) { e.textContent = B.ratingCount; });
  set('[data-vk]', function (e) { if (B.vk) e.href = B.vk; else e.hidden = true; });
  set('[data-yandex]', function (e) { if (B.yandexMaps) e.href = B.yandexMaps; });
  if (cfg.images) {
    set('[data-img-hero]', function (e) { if (cfg.images.hero) e.src = cfg.images.hero; });
    set('[data-img-hero-mobile]', function (e) { if (cfg.images.heroMobile) e.srcset = cfg.images.heroMobile; });
  }
  var hrs = sc.open + '–' + sc.close;
  document.querySelectorAll('[data-hours]').forEach(function (e) { e.textContent = hrs; });
  document.querySelectorAll('[data-hours-full]').forEach(function (e) { e.textContent = (sc.closedWeekdays.length ? 'Пн–Вс, кроме выходных дней, ' : 'Ежедневно, ') + hrs; });

  // ---- карточки услуг
  $('svcCards').innerHTML = cfg.services.map(function (s) {
    return '<article class="card"><div class="cat">' + esc(s.category) + '</div><h3>' + esc(s.name) + '</h3><p>' + esc(s.desc) + '</p>' +
      '<div class="meta"><span class="price">от ' + rub(s.price) + '</span><span class="dur">~' + C.formatDuration(s.minutes) + '</span></div>' +
      '<button type="button" class="btn btn-ghost add" data-add="' + s.id + '">Добавить в запись</button></article>';
  }).join('');
  $('svcCards').addEventListener('click', function (e) {
    var b = e.target.closest('[data-add]'); if (!b) return;
    toggleService(b.dataset.add, true); renderAll();
    $('booking').scrollIntoView({ behavior: 'smooth' });
  });

  // ---- шаг 1: класс
  $('classes').innerHTML = cfg.carClasses.map(function (c, i) {
    return '<div class="opt"><input type="radio" name="carClass" id="cc-' + c.id + '" value="' + c.id + '"' + (i === 0 ? ' checked' : '') + '><label for="cc-' + c.id + '">' + esc(c.name) + (c.factor !== 1 ? '<small>+' + Math.round((c.factor - 1) * 100) + '% к цене</small>' : '<small>базовая цена</small>') + '</label></div>';
  }).join('');
  $('classes').addEventListener('change', function (e) { state.carClass = e.target.value; renderAll(); });

  // ---- шаг 2: услуги
  function renderServices() {
    var cats = [], html = '';
    cfg.services.forEach(function (s) { if (cats.indexOf(s.category) === -1) cats.push(s.category); });
    cats.forEach(function (cat) {
      html += '<div class="svc-cat">' + esc(cat) + '</div><div class="svc">';
      cfg.services.filter(function (s) { return s.category === cat; }).forEach(function (s) {
        var on = state.services.indexOf(s.id) !== -1;
        html += '<div class="opt"><input type="checkbox" id="sv-' + s.id + '" value="' + s.id + '"' + (on ? ' checked' : '') + '><label for="sv-' + s.id + '"><span class="box"></span><span class="t"><b>' + esc(s.name) + '</b><small>' + esc(s.desc) + '</small></span><span class="pr">от ' + rub(priceOf(s)) + '<small>~' + C.formatDuration(s.minutes) + '</small></span></label></div>';
      });
      html += '</div>';
    });
    $('svcList').innerHTML = html;
  }
  function toggleService(id, on) {
    var i = state.services.indexOf(id);
    if (on && i === -1) {
      var s = byId[id], removed = [];
      state.services = state.services.filter(function (x) {
        var clash = s.excludes.indexOf(x) !== -1 || byId[x].excludes.indexOf(id) !== -1;
        if (clash) removed.push(byId[x].name); return !clash;
      });
      state.services.push(id);
      $('svcNotice').textContent = removed.length ? '«' + s.name + '» нельзя совместить с: ' + removed.join(', ') + ' — убрали из записи.' : '';
    } else if (!on && i !== -1) { state.services.splice(i, 1); $('svcNotice').textContent = ''; }
    state.services.sort(function (a, b) { return cfg.services.indexOf(byId[a]) - cfg.services.indexOf(byId[b]); });
  }
  $('svcList').addEventListener('change', function (e) { toggleService(e.target.value, e.target.checked); setErr('services', ''); renderAll(); });

  // ---- шаг 3: дата/время
  function nowTz() { return C.nowInTz(sc.timezone, new Date()); }
  function renderDates() {
    var n = nowTz(), html = '';
    for (var i = 0; i <= sc.daysAhead; i++) {
      var d = C.addDays(n.date, i), p = d.split('-'), work = C.isWorkingDay(d, cfg);
      var label = i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : WD[C.weekday(d)];
      html += '<div class="opt"><input type="radio" name="date" id="d-' + d + '" value="' + d + '"' + (state.date === d ? ' checked' : '') + (work ? '' : ' disabled') + '><label for="d-' + d + '"><small>' + label + '</small>' + (+p[2]) + '<small>' + MON[+p[1] - 1] + '</small></label></div>';
    }
    $('dates').innerHTML = html;
  }
  function currentQuote() { return C.quote(state.services, state.carClass, cfg); }
  function renderTimes() {
    var hint = $('timeHint'), notice = $('timeNotice');
    if (!state.services.length) { $('times').innerHTML = ''; hint.textContent = 'Сначала выберите услуги — покажем время, в которое работы успеем выполнить.'; notice.textContent = ''; return; }
    if (!state.date) { $('times').innerHTML = ''; hint.textContent = 'Выберите дату.'; notice.textContent = ''; return; }
    var q = currentQuote(), now = new Date(), free = 0, html = '';
    C.daySlots(cfg).forEach(function (t) {
      var prob = C.slotProblem(state.date, t, q.minutes, state.full, cfg, now);
      if (!prob) free++;
      html += '<div class="opt"><input type="radio" name="time" id="t-' + t.replace(':', '') + '" value="' + t + '"' + (state.time === t ? ' checked' : '') + (prob ? ' disabled title="' + esc(prob) + '"' : '') + '><label for="t-' + t.replace(':', '') + '"' + (prob ? ' title="' + esc(prob) + '"' : '') + '>' + t + '</label></div>';
    });
    if (state.time && C.slotProblem(state.date, state.time, q.minutes, state.full, cfg, now)) {
      toast('Время ' + state.time + ' больше не подходит под выбранные услуги — выберите другое');
      state.time = null; html = html.replace(/ checked/g, '');
    }
    $('times').innerHTML = html;
    hint.textContent = free ? 'Свободно ' + free + ' вариантов. Длительность работ ~' + C.formatDuration(q.minutes) + '.' : 'На эту дату нет подходящего времени — выберите другой день.';
    notice.textContent = q.multiDay ? 'Работы займут больше одного рабочего дня: авто принимаем к открытию (' + sc.open + ') и оно остаётся в студии. Точный срок выдачи подтвердит мастер.' : '';
  }
  $('dates').addEventListener('change', function (e) { state.date = e.target.value; state.time = null; setErr('date', ''); renderTimes(); renderSummary(); });
  $('times').addEventListener('change', function (e) { state.time = e.target.value; setErr('time', ''); renderSummary(); });

  // ---- итог
  function renderSummary() {
    var q = currentQuote();
    $('sumBody').innerHTML = q.items.length
      ? '<ul>' + q.items.map(function (s) { return '<li><span>' + esc(s.name) + '</span><span>от ' + rub(priceOf(s)) + '</span></li>'; }).join('') + '</ul>'
      : '<p class="empty">Услуги не выбраны</p>';
    var when = '—';
    if (state.date) { var p = state.date.split('-'); when = (+p[2]) + ' ' + MON[+p[1] - 1] + (state.time ? ', ' + state.time : ''); }
    $('sumWhen').textContent = when;
    $('sumDur').textContent = q.items.length ? '~' + C.formatDuration(q.minutes) : '—';
    $('sumTotal').textContent = (q.items.length ? 'от ' : '') + rub(q.price);
    $('mbTotal').textContent = (q.items.length ? 'от ' : '') + rub(q.price);
    $('mbInfo').textContent = q.items.length ? q.items.length + ' усл. · ' + (state.time ? when : 'выберите время') : 'Выберите услуги';
  }
  function renderAll() { renderServices(); renderTimes(); renderSummary(); }

  // ---- телефон: маска
  $('phone').addEventListener('input', function (e) {
    var d = e.target.value.replace(/\D/g, '');
    if (d[0] === '8') d = '7' + d.slice(1); if (d[0] === '9') d = '7' + d; if (d && d[0] !== '7') d = '7' + d;
    d = d.slice(0, 11);
    var r = d ? '+7' : '';
    if (d.length > 1) r += ' (' + d.slice(1, 4); if (d.length >= 4) r += ')';
    if (d.length > 4) r += ' ' + d.slice(4, 7); if (d.length > 7) r += '-' + d.slice(7, 9); if (d.length > 9) r += '-' + d.slice(9, 11);
    e.target.value = r;
  });

  // ---- ошибки
  var FIELDS = ['carClass', 'services', 'date', 'time', 'name', 'phone', 'car', 'comment', 'consent'];
  function setErr(k, msg) {
    var el = $('err-' + k); if (el) el.textContent = msg || '';
    var inp = $(k); if (inp && inp.closest('.field')) { inp.closest('.field').classList.toggle('bad', !!msg); inp.setAttribute('aria-invalid', msg ? 'true' : 'false'); }
  }
  ['name', 'phone', 'car', 'comment'].forEach(function (k) { $(k).addEventListener('input', function () { setErr(k, ''); }); });
  $('consent').addEventListener('change', function () { setErr('consent', ''); });
  function showErrors(errs) {
    FIELDS.forEach(function (k) { setErr(k, errs[k]); });
    var first = FIELDS.filter(function (k) { return errs[k]; })[0];
    if (first) {
      var el = $('err-' + first); var target = $(first) && $(first).focus ? $(first) : el;
      (el.closest('.step') || el).scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target && target.tagName === 'INPUT') setTimeout(function () { target.focus({ preventScroll: true }); }, 400);
    }
  }

  function payload() {
    return {
      carClass: state.carClass, services: state.services.slice(), date: state.date, time: state.time,
      name: $('name').value, phone: $('phone').value, car: $('car').value, comment: $('comment').value,
      consent: $('consent').checked, website: document.querySelector('[name=website]').value,
      tgInitData: window.tgInitData || ''
    };
  }

  // ---- занятость с сервера
  function loadBusy() {
    if (DEMO) return Promise.resolve();
    return fetch(API + '/busy', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { state.full = new Set(j.full); renderTimes(); renderSummary(); }
    }).catch(function () {});
  }

  var sending = false;
  function submit(e) {
    if (e) e.preventDefault();
    if (sending) return;
    $('formErr').textContent = '';
    var data = payload();
    var v = C.validateBooking(data, cfg, state.full, new Date());
    if (!v.ok) { showErrors(v.errors); return; }
    showErrors({});
    sending = true; $('submit').disabled = $('mbBtn').disabled = true; $('submit').textContent = 'Отправляем…';
    var req = DEMO
      ? new Promise(function (res) { setTimeout(function () { res({ status: 200, j: { ok: true, id: 'DEMO', demo: v.booking } }); }, 600); })
      : fetch(API + '/booking', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
          .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); });
    req.then(function (res) {
      var j = res.j || {};
      if (j.ok) { if (window.tgBookingDone) window.tgBookingDone(); return success(j, v.booking); }
      if (window.tgBookingFail) window.tgBookingFail();
      if (j.errors) { showErrors(j.errors); if (j.errors.time) loadBusy(); }
      $('formErr').textContent = j.error || 'Проверьте поля формы';
    }).catch(function () {
      $('formErr').innerHTML = 'Нет связи с сервером. Попробуйте ещё раз или позвоните: <a href="tel:' + cfg.business.phone + '">' + cfg.business.phoneDisplay + '</a>';
    }).then(function () {
      sending = false; $('submit').disabled = $('mbBtn').disabled = false; $('submit').textContent = 'Записаться';
    });
  }
  function success(j, b) {
    var p = b.date.split('-');
    $('mText').textContent = 'Заявка №' + j.id + ' на ' + (+p[2]) + ' ' + MON[+p[1] - 1] + ' в ' + b.time + ' отправлена мастеру. Мы перезвоним на ' + b.phone + ' для подтверждения.';
    if (j.demo) { $('mPre').hidden = false; $('mPre').textContent = 'Демо-режим: так заявка придёт в Telegram\n\n📅 ' + b.date + ', ' + b.time + '\n👤 ' + b.name + '\n📞 ' + b.phone + '\n🚘 ' + b.car + ' · ' + b.carClassName + '\n🧽 ' + b.serviceNames.join(', ') + '\n💰 от ' + rub(b.price); }
    $('modal').classList.add('open'); $('mClose').focus();
    state.full = new Set(Array.from(state.full).concat(b.cells));
    state.services = []; state.date = null; state.time = null;
    $('form').reset(); state.carClass = cfg.carClasses[0].id;
    renderDates(); renderAll(); loadBusy();
  }
  $('form').addEventListener('submit', submit);
  $('mbBtn').addEventListener('click', function () { submit(); });
  $('mClose').addEventListener('click', function () { $('modal').classList.remove('open'); });
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) $('modal').classList.remove('open'); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('modal').classList.remove('open'); });

  // ---- мобильная панель: показываем, когда виден блок записи
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (en) { var on = en[0].isIntersecting; $('mbar').classList.toggle('show', on); document.body.classList.toggle('has-bar', on); }, { threshold: 0.05 }).observe($('booking'));
  }

  renderDates(); renderAll(); loadBusy();
  // занятость обновляется сама: отмена в Telegram освобождает время на сайте в течение ~20 с
  setInterval(function () { if (!document.hidden) { renderDates(); loadBusy(); renderTimes(); } }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadBusy(); });
})();
