'use strict';
/* Garage Detailing — админ-панель (Telegram Mini App) и работа с участниками бота.
   Доступ — только по Telegram ID (ADMIN_IDS в .env + админы, добавленные в панели).
   Каждый запрос панели подписан Telegram (initData) и проверяется на сервере. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

module.exports = function createAdmin(ctx) {
  const { CONFIG, CONFIG_FILE, DATA_DIR, MINIAPP_TOKEN, WEBAPP_URL, tg, send, readBody, Core, setStatus, refreshMessages, getDb } = ctx;
  const OWNERS = (process.env.ADMIN_IDS || '').split(/[,\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
  const USERS_FILE = path.join(DATA_DIR, 'users.json');
  const ADMINS_FILE = path.join(DATA_DIR, 'admins.json');
  const UPLOADS = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(UPLOADS, { recursive: true });

  const readJson = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
  const writeJson = (f, obj) => { const tmp = f + '.' + process.pid + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); fs.renameSync(tmp, f); };
  let users = readJson(USERS_FILE, {});           // { [id]: { id, username, name, firstSeen, lastSeen, banned, banReason, blockedBot } }
  let extraAdmins = readJson(ADMINS_FILE, []);     // Telegram ID, добавленные через панель
  const saveUsers = () => writeJson(USERS_FILE, users);

  if (!CONFIG.images) CONFIG.images = { hero: 'hero.webp', heroMobile: 'hero-mobile.webp' };
  const saveConfig = () => writeJson(CONFIG_FILE, CONFIG);

  const isOwner = id => OWNERS.includes(String(id));
  const isAdmin = id => isOwner(id) || extraAdmins.includes(String(id));
  const isBanned = id => !!(users[String(id)] && users[String(id)].banned);
  const appUrl = sub => WEBAPP_URL ? WEBAPP_URL.replace(/\/?$/, '/') + (sub || '') : '';
  const appButton = (text, sub) => WEBAPP_URL ? { inline_keyboard: [[{ text, web_app: { url: appUrl(sub) } }]] } : undefined;

  function upsertUser(u, extra) {
    if (!u || !u.id) return null;
    const id = String(u.id), now = new Date().toISOString();
    const x = users[id] || (users[id] = { id, firstSeen: now, banned: false });
    if (u.username !== undefined) x.username = u.username || '';
    const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name;
    if (name) x.name = name;
    x.lastSeen = now; x.blockedBot = false;
    Object.assign(x, extra || {});
    saveUsers();
    return x;
  }

  // ---------- проверка подписи Telegram ----------
  function verifyInitData(initData, maxAgeSec = 24 * 3600) {
    if (!initData || !MINIAPP_TOKEN) return null;
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash'); if (!hash) return null;
      params.delete('hash');
      const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
      const secret = crypto.createHmac('sha256', 'WebAppData').update(MINIAPP_TOKEN).digest();
      const calc = crypto.createHmac('sha256', secret).update(check).digest('hex');
      if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
      if (Date.now() / 1000 - +params.get('auth_date') > maxAgeSec) return null;
      const u = JSON.parse(params.get('user') || 'null');
      return u && u.id ? { id: u.id, username: u.username || '', name: [u.first_name, u.last_name].filter(Boolean).join(' '), first_name: u.first_name, last_name: u.last_name } : null;
    } catch { return null; }
  }

  // ---------- отправка сообщений участникам ----------
  async function sendToUser(id, text, opts) {
    opts = opts || {};
    try {
      await tg('sendMessage', { chat_id: id, text: String(text).slice(0, 4096), reply_markup: opts.button === false ? undefined : appButton('📱 Открыть приложение') }, MINIAPP_TOKEN);
      return { ok: true };
    } catch (e) {
      const blocked = /403|blocked|deactivated|chat not found|can't initiate/i.test(e.message);
      if (blocked && users[String(id)]) { users[String(id)].blockedBot = true; saveUsers(); }
      return { ok: false, blocked, error: e.message.replace(MINIAPP_TOKEN, '***') };
    }
  }
  // Клиенту из Mini App — статус его записи
  async function notifyClient(b) {
    if (!b || !b.tgUser || isBanned(b.tgUser.id)) return;
    const [y, m, d] = b.date.split('-');
    const when = `${d}.${m}.${y} в ${b.time}`;
    const text = b.status === 'confirmed' ? `✅ Ваша запись #${b.id} на ${when} подтверждена. Ждём вас: ${CONFIG.business.address}.`
      : b.status === 'cancelled' ? `❌ Запись #${b.id} на ${when} отменена. Выберите другое время в приложении или позвоните: ${CONFIG.business.phoneDisplay}.` : null;
    if (text) await sendToUser(b.tgUser.id, text);
  }

  // Рассылка всем: в фоне, ~20 сообщений/с (лимит Telegram ~30/с)
  let broadcast = null;
  function startBroadcast(text, by) {
    if (broadcast && broadcast.running) return { ok: false, error: 'Предыдущая рассылка ещё идёт' };
    const ids = Object.values(users).filter(u => !u.banned && !u.blockedBot).map(u => u.id);
    broadcast = { text: text.slice(0, 200), total: ids.length, sent: 0, failed: 0, blocked: 0, running: true, startedAt: new Date().toISOString(), finishedAt: null, by };
    const job = broadcast;
    (async () => {
      for (const id of ids) {
        const r = await sendToUser(id, text);
        if (r.ok) job.sent++; else { job.failed++; if (r.blocked) job.blocked++; }
        await new Promise(r => setTimeout(r, 50));
      }
      job.running = false; job.finishedAt = new Date().toISOString();
      console.log(`[рассылка] отправлено ${job.sent}/${job.total}, ошибок ${job.failed}`);
    })();
    return { ok: true, total: ids.length };
  }

  // ---------- сообщения в бот Mini App ----------
  async function onUserMessage(m, token) {
    if (!m.from || !m.chat || m.chat.type !== 'private') return false;
    const id = String(m.from.id), t = String(m.text || '').trim();
    if (isBanned(id)) return true;                 // забаненным бот не отвечает
    upsertUser(m.from);
    const reply = (text, markup) => tg('sendMessage', { chat_id: id, text, reply_markup: markup }, token);
    if (/^\/start/i.test(t)) { await reply(`Здравствуйте! Это ${CONFIG.business.name} — ${CONFIG.business.city}.\nНажмите кнопку ниже, чтобы выбрать услуги и записаться.\n📞 ${CONFIG.business.phoneDisplay}`, appButton('🚗 Записаться')); return true; }
    if (/^\/id\b/i.test(t)) { await reply(`Ваш Telegram ID: ${id}`); return true; }
    if (/^\/admin\b/i.test(t)) {
      if (!isAdmin(id)) { await reply('Нет доступа. Ваш Telegram ID: ' + id); return true; }
      await reply(WEBAPP_URL ? '⚙️ Админ-панель' : 'Укажите WEBAPP_URL в .env, чтобы открыть панель из Telegram.', appButton('⚙️ Открыть админ-панель', 'admin.html'));
      return true;
    }
    return false;
  }

  // ---------- валидация ----------
  const str = (v, min, max) => { const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' '); return s.length >= min && s.length <= max ? s : null; };
  const hhmm = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null;
  const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3);
  const int = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };
  const httpsOrEmpty = v => { const s = String(v || '').trim(); return s === '' || /^https:\/\/[^\s<>"]+$/i.test(s) ? s : null; };

  function applyBusiness(input) {
    const e = {}, b = input.business || {}, s = input.schedule || {}, nb = {}, ns = {};
    if (!(nb.name = str(b.name, 2, 60))) e.name = 'Название: 2–60 символов';
    if (!(nb.city = str(b.city, 2, 40))) e.city = 'Город: 2–40 символов';
    if (!(nb.address = str(b.address, 3, 120))) e.address = 'Адрес: 3–120 символов';
    const ph = String(b.phone || '').replace(/[^\d+]/g, '');
    if (!/^\+\d{10,15}$/.test(ph)) e.phone = 'Телефон в формате +79991234567'; else nb.phone = ph;
    if (!(nb.phoneDisplay = str(b.phoneDisplay, 5, 30))) e.phoneDisplay = 'Как показывать телефон: 5–30 символов';
    if ((nb.vk = httpsOrEmpty(b.vk)) === null) e.vk = 'Ссылка должна начинаться с https://';
    if ((nb.yandexMaps = httpsOrEmpty(b.yandexMaps)) === null) e.yandexMaps = 'Ссылка должна начинаться с https://';
    if (!(nb.rating = /^[0-5](\.\d)?$/.test(String(b.rating)) ? String(b.rating) : null)) e.rating = 'Рейтинг от 0 до 5, например 4.9';
    if ((nb.ratingCount = int(b.ratingCount, 0, 1e6)) === null) e.ratingCount = 'Целое число';
    const slot = CONFIG.schedule.slotMinutes;
    ns.open = hhmm(s.open); ns.close = hhmm(s.close);
    if (!ns.open || !ns.close || toMin(ns.open) >= toMin(ns.close)) e.hours = 'Время работы: открытие раньше закрытия';
    else if (toMin(ns.open) % slot || toMin(ns.close) % slot) e.hours = `Время должно быть кратно ${slot} мин`;
    if ((ns.daysAhead = int(s.daysAhead, 1, 180)) === null) e.daysAhead = 'От 1 до 180 дней';
    if ((ns.minLeadMinutes = int(s.minLeadMinutes, 0, 2880)) === null) e.minLeadMinutes = 'От 0 до 2880 минут';
    if ((ns.boxes = int(s.boxes, 1, 20)) === null) e.boxes = 'От 1 до 20';
    ns.closedWeekdays = Array.isArray(s.closedWeekdays) ? [...new Set(s.closedWeekdays.map(Number))].filter(n => Number.isInteger(n) && n >= 0 && n <= 6).sort() : [];
    if (ns.closedWeekdays.length === 7) e.closedWeekdays = 'Нельзя закрыть все дни недели';
    const classes = Array.isArray(input.carClasses) ? input.carClasses : [];
    const nc = CONFIG.carClasses.map(c => {
      const x = classes.find(k => k && k.id === c.id) || c;
      const name = str(x.name, 2, 40), factor = Number(x.factor);
      if (!name) e['cc_' + c.id] = 'Название класса: 2–40 символов';
      if (!(factor >= 0.5 && factor <= 5)) e['cc_' + c.id] = 'Коэффициент от 0.5 до 5';
      return { id: c.id, name: name || c.name, factor: Math.round(factor * 100) / 100 };
    });
    if (Object.keys(e).length) return { ok: false, errors: e };
    Object.assign(CONFIG.business, nb);
    Object.assign(CONFIG.schedule, ns);
    CONFIG.carClasses = nc;
    saveConfig();
    return { ok: true };
  }

  function saveService(input) {
    const e = {}, slot = CONFIG.schedule.slotMinutes;
    const category = str(input.category, 1, 40), name = str(input.name, 2, 80), desc = str(input.desc, 0, 200);
    const price = int(input.price, 0, 10000000), minutes = int(input.minutes, slot, 3 * 24 * 60);
    if (!category) e.category = 'Вид услуги: 1–40 символов';
    if (!name) e.name = 'Название: 2–80 символов';
    if (desc === null) e.desc = 'Описание: до 200 символов';
    if (price === null) e.price = 'Цена — целое число ₽ (0–10 000 000)';
    if (minutes === null) e.minutes = `Время — от ${slot} мин`;
    else if (minutes % slot) e.minutes = `Время должно быть кратно ${slot} мин`;
    let svc = input.id ? CONFIG.services.find(s => s.id === input.id) : null;
    if (input.id && !svc) return { ok: false, error: 'Услуга не найдена' };
    if (CONFIG.services.some(s => s !== svc && s.name.toLowerCase() === String(name || '').toLowerCase())) e.name = 'Услуга с таким названием уже есть';
    if (Object.keys(e).length) return { ok: false, errors: e };
    if (!svc) { svc = { id: 'svc_' + crypto.randomBytes(3).toString('hex'), excludes: [] }; CONFIG.services.push(svc); }
    Object.assign(svc, { category, name, desc, price, minutes });
    // Несовместимые услуги — всегда взаимно
    const ex = Array.isArray(input.excludes) ? input.excludes.filter(id => id !== svc.id && CONFIG.services.some(s => s.id === id)) : svc.excludes;
    svc.excludes = [...new Set(ex)];
    CONFIG.services.forEach(s => {
      if (s === svc) return;
      const has = s.excludes.includes(svc.id), need = svc.excludes.includes(s.id);
      if (need && !has) s.excludes.push(svc.id);
      if (!need && has) s.excludes = s.excludes.filter(x => x !== svc.id);
    });
    saveConfig();
    return { ok: true, service: svc };
  }
  function deleteService(id) {
    const i = CONFIG.services.findIndex(s => s.id === id);
    if (i < 0) return { ok: false, error: 'Услуга не найдена' };
    if (CONFIG.services.length === 1) return { ok: false, error: 'Нельзя удалить последнюю услугу' };
    CONFIG.services.splice(i, 1);
    CONFIG.services.forEach(s => { s.excludes = s.excludes.filter(x => x !== id); });
    saveConfig();
    return { ok: true };   // старые записи хранят названия услуг — история не ломается
  }

  // Картинки: проверяем настоящий формат по сигнатуре файла
  const SLOTS = { hero: 'Главный экран (компьютер)', heroMobile: 'Главный экран (телефон)' };
  const DEFAULT_IMG = { hero: 'hero.webp', heroMobile: 'hero-mobile.webp' };
  function saveImage(slot, dataUrl) {
    if (!SLOTS[slot]) return { ok: false, error: 'Неизвестное место картинки' };
    if (dataUrl === null) { removeUpload(CONFIG.images[slot]); CONFIG.images[slot] = DEFAULT_IMG[slot]; saveConfig(); return { ok: true, url: CONFIG.images[slot] }; }
    const m = String(dataUrl || '').match(/^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return { ok: false, error: 'Нужен файл JPG, PNG или WEBP' };
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 6 * 1024 * 1024) return { ok: false, error: 'Файл больше 6 МБ' };
    const ext = buf[0] === 0xFF && buf[1] === 0xD8 ? '.jpg' : buf.slice(0, 4).toString('hex') === '89504e47' ? '.png'
      : buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP' ? '.webp' : null;
    if (!ext) return { ok: false, error: 'Поддерживаются только JPG, PNG, WEBP' };
    const name = slot + '-' + Date.now() + ext;
    fs.writeFileSync(path.join(UPLOADS, name), buf);
    removeUpload(CONFIG.images[slot]);
    CONFIG.images[slot] = '/uploads/' + name;
    saveConfig();
    return { ok: true, url: CONFIG.images[slot] };
  }
  function removeUpload(url) {
    const m = String(url || '').match(/^\/uploads\/([\w.-]+)$/);
    if (m) fs.unlink(path.join(UPLOADS, m[1]), () => {});
  }
  function serveUpload(p, res) {
    const name = p.slice('/uploads/'.length);
    if (!/^[\w.-]+$/.test(name)) return send(res, 404, { ok: false });
    fs.readFile(path.join(UPLOADS, name), (err, buf) => {
      if (err) { res.writeHead(404); return res.end(); }
      const type = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[path.extname(name)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  }

  // ---------- HTTP ----------
  function auth(req) {
    const u = verifyInitData(req.headers['x-telegram-init-data']);
    if (!u) return { code: 401, error: 'Откройте панель из Telegram (команда /admin в боте)' };
    if (!isAdmin(u.id)) return { code: 403, error: 'Нет доступа. Ваш Telegram ID: ' + u.id };
    return { user: u };
  }
  const parse = async (req, limit) => { try { return JSON.parse(await readBody(req, limit)); } catch { return null; } };

  function state(me) {
    const list = getDb().slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 300)
      .map(b => ({ id: b.id, status: b.status, createdAt: b.createdAt, date: b.date, time: b.time, name: b.name, phone: b.phone, car: b.car, carClassName: b.carClassName, serviceNames: b.serviceNames, price: b.price, minutes: b.minutes, comment: b.comment, tgUser: b.tgUser || null }));
    return {
      ok: true, me: { id: String(me.id), name: me.name, owner: isOwner(me.id) },
      config: CONFIG, slots: SLOTS, bookings: list,
      users: Object.values(users).sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || '')),
      admins: { owners: OWNERS, extra: extraAdmins }, broadcast, webappUrl: WEBAPP_URL
    };
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    if (p.startsWith('/uploads/') && req.method === 'GET') { serveUpload(p, res); return true; }
    // Открытие Mini App: регистрируем участника (для рассылок) и сообщаем, админ ли он
    if (p === '/api/tg/hello' && req.method === 'POST') {
      const body = await parse(req) || {};
      const u = verifyInitData(body.initData);
      if (!u) { send(res, 401, { ok: false }); return true; }
      const banned = isBanned(u.id);
      if (!banned) upsertUser(u, { openedApp: true });
      send(res, 200, { ok: true, isAdmin: !banned && isAdmin(u.id), banned });
      return true;
    }
    if (!p.startsWith('/api/admin/')) return false;
    const a = auth(req);
    if (a.error) { send(res, a.code, { ok: false, error: a.error }); return true; }
    const me = a.user, act = p.slice('/api/admin/'.length);
    if (act === 'state' && req.method === 'GET') { send(res, 200, state(me)); return true; }
    if (req.method !== 'POST') { send(res, 405, { ok: false }); return true; }
    const body = await parse(req, act === 'image' ? 9 * 1024 * 1024 : 64 * 1024);
    if (!body) { send(res, 400, { ok: false, error: 'Некорректный запрос' }); return true; }
    const log = what => console.log(`[админ ${me.id}] ${what}`);
    let r;
    switch (act) {
      case 'business': r = applyBusiness(body); if (r.ok) log('изменил данные/цены классов'); break;
      case 'service': r = saveService(body); if (r.ok) log((body.id ? 'изменил' : 'добавил') + ' услугу ' + r.service.name); break;
      case 'service-delete': r = deleteService(String(body.id || '')); if (r.ok) log('удалил услугу ' + body.id); break;
      case 'booking': {
        const s = await setStatus(String(body.id || ''), body.act === 'ok' ? 'ok' : 'no');
        if (s.b) { await refreshMessages(s.b); if (s.changed) notifyClient(s.b); }
        r = s.b ? { ok: true, msg: s.msg, status: s.b.status } : { ok: false, error: s.msg };
        if (s.changed) log(`запись ${s.b.id} → ${s.b.status}`);
        break;
      }
      case 'broadcast': {
        const text = str(body.text, 1, 4000);
        r = text ? startBroadcast(String(body.text).trim(), me.id) : { ok: false, error: 'Введите текст (до 4000 символов)' };
        if (r.ok) log('рассылка на ' + r.total);
        break;
      }
      case 'message': {
        const id = String(body.userId || '').trim(), text = String(body.text || '').trim();
        if (!/^\d{3,15}$/.test(id)) r = { ok: false, error: 'Неверный Telegram ID' };
        else if (!text || text.length > 4000) r = { ok: false, error: 'Введите текст (до 4000 символов)' };
        else { const s = await sendToUser(id, text); r = s.ok ? { ok: true } : { ok: false, error: s.blocked ? 'Пользователь не запускал бота или заблокировал его' : s.error }; }
        if (r.ok) log('сообщение пользователю ' + id);
        break;
      }
      case 'ban': {
        const id = String(body.userId || '').trim();
        if (!/^\d{3,15}$/.test(id)) { r = { ok: false, error: 'Неверный Telegram ID' }; break; }
        if (body.banned && isAdmin(id)) { r = { ok: false, error: 'Нельзя забанить администратора' }; break; }
        const x = users[id] || (users[id] = { id, firstSeen: new Date().toISOString(), name: '', username: '' });
        x.banned = !!body.banned; x.banReason = x.banned ? String(body.reason || '').slice(0, 200) : '';
        x.bannedAt = x.banned ? new Date().toISOString() : null; saveUsers();
        r = { ok: true }; log((x.banned ? 'забанил ' : 'разбанил ') + id);
        break;
      }
      case 'image': r = saveImage(String(body.slot || ''), body.dataUrl === null ? null : body.dataUrl); if (r.ok) log('сменил картинку ' + body.slot); break;
      case 'admins': {
        if (!isOwner(me.id)) { r = { ok: false, error: 'Добавлять админов может только владелец (ADMIN_IDS в .env)' }; break; }
        const id = String(body.userId || '').trim();
        if (!/^\d{3,15}$/.test(id)) { r = { ok: false, error: 'Неверный Telegram ID' }; break; }
        if (isOwner(id)) { r = { ok: false, error: 'Владелец задаётся в .env' }; break; }
        extraAdmins = body.remove ? extraAdmins.filter(x => x !== id) : [...new Set(extraAdmins.concat(id))];
        writeJson(ADMINS_FILE, extraAdmins); r = { ok: true }; log((body.remove ? 'убрал админа ' : 'добавил админа ') + id);
        break;
      }
      default: send(res, 404, { ok: false }); return true;
    }
    send(res, r.ok ? 200 : 422, r);
    return true;
  }

  if (!OWNERS.length) console.warn('⚠ ADMIN_IDS не задан в .env — админ-панель недоступна. Узнайте свой ID командой /id в боте.');
  return { handle, verifyInitData, isBanned, isAdmin, upsertUser, onUserMessage, notifyClient };
};
