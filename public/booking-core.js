/* Garage Detailing — общая логика записи (браузер + сервер). Одни и те же правила
   используются и для отображения формы, и для финальной проверки на сервере. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BookingCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function pad(n) { return String(n).padStart(2, '0'); }
  function toMin(hhmm) { var p = String(hhmm).split(':'); return (+p[0]) * 60 + (+p[1]); }
  function fromMin(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function isValidDateStr(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
    var d = new Date(s + 'T00:00:00Z');
    return !isNaN(d) && d.toISOString().slice(0, 10) === s;
  }
  function addDays(dateStr, n) {
    var d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function weekday(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); } // 0 = вс
  function diffDays(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5); }

  /** Текущие дата и минуты в часовом поясе студии (не зависит от пояса клиента). */
  function nowInTz(tz, now) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now || new Date());
    var o = {}; parts.forEach(function (p) { o[p.type] = p.value; });
    return { date: o.year + '-' + o.month + '-' + o.day, minutes: (+o.hour % 24) * 60 + (+o.minute) };
  }

  function isWorkingDay(dateStr, cfg) { return cfg.schedule.closedWeekdays.indexOf(weekday(dateStr)) === -1; }

  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.length === 10 && d[0] === '9') d = '7' + d;
    if (d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
    if (d.length !== 11 || d[0] !== '7' || d[1] !== '9') return null; // мобильные РФ: +7 9XX
    return '+' + d;
  }

  /** Проверка набора услуг: существование, дубли, взаимоисключения. */
  function checkServices(ids, cfg) {
    var errors = [];
    if (!Array.isArray(ids) || ids.length === 0) return ['Выберите хотя бы одну услугу'];
    var map = {}; cfg.services.forEach(function (s) { map[s.id] = s; });
    var seen = {};
    ids.forEach(function (id) {
      if (!map[id]) errors.push('Неизвестная услуга: ' + id);
      else if (seen[id]) errors.push('Услуга выбрана дважды: ' + map[id].name);
      seen[id] = true;
    });
    if (errors.length) return errors;
    ids.forEach(function (a) {
      ids.forEach(function (b) {
        if (a < b && (map[a].excludes.indexOf(b) !== -1 || map[b].excludes.indexOf(a) !== -1))
          errors.push('Нельзя выбрать вместе: «' + map[a].name + '» и «' + map[b].name + '»');
      });
    });
    return errors;
  }

  /** Стоимость «от» и длительность (округлена до шага слота). */
  function quote(ids, carClassId, cfg) {
    var cls = cfg.carClasses.filter(function (c) { return c.id === carClassId; })[0] || cfg.carClasses[0];
    var items = cfg.services.filter(function (s) { return ids.indexOf(s.id) !== -1; });
    var price = 0, minutes = 0;
    items.forEach(function (s) { price += Math.round(s.price * cls.factor / 50) * 50; minutes += s.minutes; });
    var step = cfg.schedule.slotMinutes;
    minutes = Math.ceil(minutes / step) * step;
    var dayLen = toMin(cfg.schedule.close) - toMin(cfg.schedule.open);
    return { items: items, carClass: cls, price: price, minutes: minutes, multiDay: minutes > dayLen };
  }

  /** Ячейки (дата|время), которые займёт работа. Если не помещается в день —
      продолжается со следующего рабочего дня с открытия. */
  function jobCells(date, time, minutes, cfg) {
    var sc = cfg.schedule, step = sc.slotMinutes, open = toMin(sc.open), close = toMin(sc.close);
    var cells = [], left = minutes, d = date, t = toMin(time), guard = 0;
    while (left > 0 && guard++ < 400) {
      if (t >= close || !isWorkingDay(d, cfg)) { d = addDays(d, 1); t = open; continue; }
      cells.push(d + '|' + fromMin(t)); t += step; left -= step;
    }
    return cells;
  }

  /** Все стартовые слоты дня (без учёта занятости). */
  function daySlots(cfg) {
    var sc = cfg.schedule, res = [];
    for (var t = toMin(sc.open); t < toMin(sc.close); t += sc.slotMinutes) res.push(fromMin(t));
    return res;
  }

  /** Почему слот недоступен (null — доступен). fullCells: Set/объект занятых ячеек. */
  function slotProblem(date, time, minutes, fullCells, cfg, now) {
    var sc = cfg.schedule, n = nowInTz(sc.timezone, now);
    if (!isValidDateStr(date)) return 'Некорректная дата';
    if (daySlots(cfg).indexOf(time) === -1) return 'Некорректное время';
    var dd = diffDays(n.date, date);
    if (dd < 0) return 'Дата уже прошла';
    if (dd > sc.daysAhead) return 'Запись возможна не более чем на ' + sc.daysAhead + ' дней вперёд';
    if (!isWorkingDay(date, cfg)) return 'В этот день студия не работает';
    if (dd === 0 && toMin(time) < n.minutes + sc.minLeadMinutes) return 'Это время уже недоступно';
    var dayLen = toMin(sc.close) - toMin(sc.open);
    if (minutes <= dayLen && toMin(time) + minutes > toMin(sc.close))
      return 'Работы не успеют закончиться до закрытия — выберите время раньше';
    if (minutes > dayLen && toMin(time) !== toMin(sc.open))
      return 'Для работ дольше одного дня авто принимаем к открытию';
    var cells = jobCells(date, time, minutes, cfg);
    for (var i = 0; i < cells.length; i++) {
      var has = typeof fullCells.has === 'function' ? fullCells.has(cells[i]) : !!fullCells[cells[i]];
      if (has) return 'Это время уже занято';
    }
    return null;
  }

  /** Ячейки, где уже занято boxes и более мест. */
  function fullCellsFrom(bookings, cfg) {
    var cnt = {}, full = new Set();
    bookings.forEach(function (b) {
      if (b.status === 'cancelled') return;
      b.cells.forEach(function (c) { cnt[c] = (cnt[c] || 0) + 1; if (cnt[c] >= cfg.schedule.boxes) full.add(c); });
    });
    return full;
  }

  /** Полная проверка заявки. Возвращает {ok, errors:{поле:текст}, booking}. */
  function validateBooking(input, cfg, fullCells, now) {
    input = input || {};
    var errors = {};
    var name = String(input.name || '').trim().replace(/\s+/g, ' ');
    if (name.length < 2 || name.length > 50 || !/^[A-Za-zА-Яа-яЁё\-' .]+$/.test(name)) errors.name = 'Введите имя (2–50 букв)';
    var phone = normalizePhone(input.phone);
    if (!phone) errors.phone = 'Введите мобильный номер в формате +7 9XX XXX-XX-XX';
    var car = String(input.car || '').trim().replace(/\s+/g, ' ');
    if (car.length < 2 || car.length > 60) errors.car = 'Укажите марку и модель авто';
    var comment = String(input.comment || '').trim();
    if (comment.length > 500) errors.comment = 'Комментарий — не более 500 символов';
    if (!cfg.carClasses.some(function (c) { return c.id === input.carClass; })) errors.carClass = 'Выберите класс автомобиля';
    var sErr = checkServices(input.services, cfg);
    if (sErr.length) errors.services = sErr.join('. ');
    if (input.consent !== true) errors.consent = 'Нужно согласие на обработку данных';
    var q = null;
    if (!errors.services && !errors.carClass) {
      q = quote(input.services, input.carClass, cfg);
      if (!input.date) errors.date = 'Выберите дату';
      else if (!input.time) errors.time = 'Выберите время';
      else {
        var p = slotProblem(String(input.date), String(input.time), q.minutes, fullCells || new Set(), cfg, now);
        if (p) errors.time = p;
      }
    }
    var ok = Object.keys(errors).length === 0;
    return {
      ok: ok, errors: errors,
      booking: ok ? {
        name: name, phone: phone, car: car, comment: comment, carClass: q.carClass.id, carClassName: q.carClass.name,
        services: q.items.map(function (s) { return s.id; }), serviceNames: q.items.map(function (s) { return s.name; }),
        price: q.price, minutes: q.minutes, multiDay: q.multiDay, date: input.date, time: input.time,
        cells: jobCells(input.date, input.time, q.minutes, cfg)
      } : null
    };
  }

  function formatDuration(min) {
    var h = Math.floor(min / 60), m = min % 60;
    return (h ? h + '\u00a0ч' : '') + (h && m ? ' ' : '') + (m ? m + '\u00a0мин' : '');
  }

  return {
    pad: pad, toMin: toMin, fromMin: fromMin, addDays: addDays, weekday: weekday, diffDays: diffDays,
    nowInTz: nowInTz, isWorkingDay: isWorkingDay, normalizePhone: normalizePhone, checkServices: checkServices,
    quote: quote, jobCells: jobCells, daySlots: daySlots, slotProblem: slotProblem, fullCellsFrom: fullCellsFrom,
    validateBooking: validateBooking, formatDuration: formatDuration, isValidDateStr: isValidDateStr
  };
});
