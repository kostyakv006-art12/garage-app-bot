'use strict';
/* Garage Detailing — сервер сайта и приёма записей (Node.js 18+, без зависимостей). */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Core = require('./public/booking-core.js');

require('./tools/env.js')(__dirname);

const PORT = +process.env.PORT || 3000;
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const TG_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
// Mini App: бот, из которого открывается приложение (может отличаться от бота для заявок)
const MINIAPP_TOKEN = (process.env.TELEGRAM_MINIAPP_BOT_TOKEN || TOKEN).trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim();
const POLLING = process.env.TELEGRAM_POLLING !== '0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'bookings.json');
const PUBLIC = path.join(__dirname, 'public');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, 'config.json');
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const createAdmin = require('./admin.js');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- хранилище ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; }
}
function saveDb(list) {
  const tmp = DB_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 1));
  fs.renameSync(tmp, DB_FILE); // атомарная замена
}
let db = loadDb();
// Очередь: все изменения записей выполняются строго по одной → нет двойных броней.
let queue = Promise.resolve();
const exclusive = fn => (queue = queue.then(fn, fn));

// ---------- Telegram ----------
// Запрос к Telegram Bot API через модуль https (работает и там, где нет глобального fetch)
const https = require('https');
function tgRaw(method, payload, timeoutMs, token) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const u = new URL(`${TG_BASE}/bot${token || TOKEN}/${method}`);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }, timeout: timeoutMs }, (r) => {
      const chunks = []; r.on('data', c => chunks.push(c));
      r.on('end', () => {
        let j; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { j = { ok: false, description: 'ответ не JSON, HTTP ' + r.statusCode }; }
        resolve(j);
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('нет ответа от ' + u.host + ' за ' + timeoutMs / 1000 + ' с'), { network: true })));
    req.on('error', (e) => reject(Object.assign(e, { network: true })));
    req.end(body);
  });
}
const tgState = { lastOkAt: null, lastError: null, lastErrorAt: null };
async function tg(method, payload, token) {
  const timeoutMs = method === 'getUpdates' ? 40000 : 10000;
  for (let attempt = 1; ; attempt++) {
    let j;
    try { j = await tgRaw(method, payload, timeoutMs, token); }
    catch (e) {
      if (method !== 'getUpdates' && attempt < 3) { await new Promise(r => setTimeout(r, 700 * attempt)); continue; }
      throw new Error(`Telegram ${method}: сеть — ${e.code || ''} ${e.message}`.replace(/\s+/g, ' '));
    }
    if (j.ok) { if (method !== 'getUpdates') tgState.lastOkAt = new Date().toISOString(); return j.result; }
    const retry = j.parameters && j.parameters.retry_after;
    if (j.error_code === 429 && retry && retry <= 10 && attempt < 3) { await new Promise(r => setTimeout(r, retry * 1000)); continue; }
    const err = new Error(`Telegram ${method}: ${j.error_code || ''} ${j.description || 'ошибка'}`.replace(/\s+/g, ' '));
    err.tgCode = j.error_code; err.tgDescription = j.description || '';
    throw err;
  }
}
// Понятная подсказка владельцу по тексту ошибки Telegram
function tgHint(msg) {
  const m = String(msg);
  if (/bots can't send messages to bots/i.test(m)) return 'TELEGRAM_CHAT_ID — это id бота. Нужен ВАШ id: напишите @userinfobot, впишите число в .env и перезапустите сервер.';
  if (/chat not found/i.test(m)) return 'Неверный TELEGRAM_CHAT_ID, либо вы не нажали /start у своего бота. Запустите npm run check-telegram.';
  if (/bot was blocked|user is deactivated|can't initiate/i.test(m)) return 'Бот заблокирован или вы ему не писали. Откройте бота в Telegram и нажмите /start.';
  if (/kicked|not a member|have no rights|need administrator/i.test(m)) return 'Бота нет в группе или у него нет прав писать. Добавьте бота в группу заново.';
  if (/Unauthorized|401|404 Not Found/i.test(m)) return 'Неверный TELEGRAM_BOT_TOKEN. Скопируйте токен у @BotFather заново.';
  if (/can't parse entities/i.test(m)) return 'Ошибка разметки сообщения (отправлено без форматирования).';
  if (/сеть|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|нет ответа/i.test(m)) return 'Сервер не может связаться с api.telegram.org. Хостинг блокирует Telegram: включите доступ, смените хостинг или задайте TELEGRAM_API_BASE (прокси).';
  return 'Запустите npm run check-telegram — он покажет причину.';
}
function noteTgError(e) {
  tgState.lastError = e.message.replace(TOKEN, '***') + ' → ' + tgHint(e.message);
  tgState.lastErrorAt = new Date().toISOString();
  console.error('[telegram]', tgState.lastError);
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ruDate = d => { const [y, m, dd] = d.split('-'); const wd = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][Core.weekday(d)]; return `${dd}.${m}.${y} (${wd})`; };

function bookingText(b) {
  const status = b.status === 'cancelled' ? '\n\n❌ <b>ОТМЕНЕНА</b> — время на сайте снова свободно'
    : b.status === 'confirmed' ? '\n\n✅ <b>ПОДТВЕРЖДЕНА</b> — время на сайте занято'
    : '\n\n⏳ Ждёт решения — время на сайте пока занято';
  return [
    `🚗 <b>Новая запись #${esc(b.id)}</b>`, '',
    `📅 <b>${esc(ruDate(b.date))}, ${esc(b.time)}</b>`,
    `⏱ Длительность: ~${esc(Core.formatDuration(b.minutes))}${b.multiDay ? ' (авто остаётся больше чем на день)' : ''}`, '',
    `👤 ${esc(b.name)}`, `📞 ${esc(b.phone)}`,
    ...(b.tgUser ? [`✈️ Telegram: ${b.tgUser.username ? '@' + esc(b.tgUser.username) : `<a href="tg://user?id=${b.tgUser.id}">${esc(b.tgUser.name || 'профиль')}</a>`} (из Mini App)`] : []), `🚘 ${esc(b.car)} · ${esc(b.carClassName)}`, '',
    '🧽 <b>Услуги:</b>', ...b.serviceNames.map(n => '• ' + esc(n)), '',
    `💰 Ориентировочно: от ${b.price.toLocaleString('ru-RU')} ₽`,
    b.comment ? `\n💬 ${esc(b.comment)}` : ''
  ].join('\n').trim() + status;
}
const keyboard = b => b.status === 'new'
  ? { inline_keyboard: [[{ text: '✅ Подтвердить', callback_data: 'ok:' + b.id }, { text: '❌ Отменить', callback_data: 'no:' + b.id }]] }
  : b.status === 'confirmed'
    ? { inline_keyboard: [[{ text: '❌ Отменить (освободить время)', callback_data: 'no:' + b.id }]] }
    : { inline_keyboard: [] };

async function notify(b) {
  // Заявка считается отправленной, если дошла хотя бы в один чат
  const sent = [], errors = [];
  for (const chat_id of CHAT_IDS) {
    try {
      let m;
      try { m = await tg('sendMessage', { chat_id, text: bookingText(b), parse_mode: 'HTML', reply_markup: keyboard(b) }); }
      catch (e) {
        if (!/can't parse entities/i.test(e.message)) throw e;
        m = await tg('sendMessage', { chat_id, text: bookingText(b).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), reply_markup: keyboard(b) });
      }
      sent.push({ chat_id, message_id: m.message_id });
    } catch (e) { noteTgError(e); errors.push(e); }
  }
  if (!sent.length) throw errors[0] || new Error('Telegram: нет чатов');
  return sent;
}

// Проверка настроек при запуске: результат виден в консоли и в /api/health
async function selfCheck() {
  try {
    const me = await tg('getMe');
    console.log(`Telegram: бот @${me.username} подключён`);
    for (const id of CHAT_IDS) {
      if (String(me.id) === String(id)) { noteTgError(new Error(`chat_id ${id}: bots can't send messages to bots`)); continue; }
      try { const c = await tg('getChat', { chat_id: id }); console.log(`Telegram: чат ${id} найден (${c.title || c.first_name || c.username || c.type})`); }
      catch (e) { noteTgError(new Error(`chat_id ${id}: ${e.message}`)); }
    }
  } catch (e) { noteTgError(e); }
}

const pollState = { running: false, lastOkAt: null, lastError: null };
async function pollLoop(token = TOKEN, state = pollState, onMsg = onMessage, onCb = onCallback) {
  let offset = 0;
  // Если у бота когда-то был настроен webhook, getUpdates не работает (409) → кнопки «молчат». Снимаем его.
  try { await tg('deleteWebhook', { drop_pending_updates: false }, token); } catch (e) { console.error('[poll] deleteWebhook:', e.message.replace(token, '***')); }
  const pollState = state;
  pollState.running = true;
  while (true) {
    try {
      const ups = await tg('getUpdates', { offset, timeout: 30, allowed_updates: ['callback_query', 'message'] }, token);
      pollState.lastOkAt = new Date().toISOString(); pollState.lastError = null;
      for (const u of ups) {
        offset = u.update_id + 1;
        if (u.callback_query) { if (onCb) await onCb(u.callback_query).catch(e => console.error('[кнопка]', e.message)); }
        else if (u.message) await onMsg(u.message).catch(e => console.error('[команда]', e.message));
      }
    } catch (e) {
      const hint = /409|Conflict/i.test(e.message)
        ? 'Этого бота опрашивает другой запущенный сервер (например, второй экземпляр или копия на другом компьютере). Оставьте только один.'
        : tgHint(e.message);
      pollState.lastError = e.message.replace(token, '***') + ' → ' + hint;
      console.error('[poll]', pollState.lastError);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Смена статуса: new → confirmed (время занято), new/confirmed → cancelled (время снова свободно)
function setStatus(id, act) {
  return exclusive(() => {
    const x = db.find(r => r.id === String(id || '').toUpperCase());
    if (!x) return { b: null, msg: 'Запись не найдена' };
    if (x.status === 'cancelled') return { b: x, msg: 'Запись уже отменена' };
    if (act === 'ok') {
      if (x.status === 'confirmed') return { b: x, msg: 'Уже подтверждена' };
      x.status = 'confirmed';
    } else x.status = 'cancelled';
    x.updatedAt = new Date().toISOString(); saveDb(db);
    console.log(`[запись ${x.id}] → ${x.status}`);
    return { b: x, changed: true, msg: x.status === 'cancelled' ? 'Запись отменена, время на сайте снова свободно' : 'Запись подтверждена, время на сайте занято' };
  });
}
async function refreshMessages(b) {
  for (const m of b.messages || []) await tg('editMessageText', { chat_id: m.chat_id, message_id: m.message_id, text: bookingText(b), parse_mode: 'HTML', reply_markup: keyboard(b) }).catch(e => { if (!/not modified/i.test(e.message)) console.error('[edit]', e.message); });
}
async function onCallback(q) {
  const chat = String(q.message && q.message.chat && q.message.chat.id);
  if (!CHAT_IDS.includes(chat)) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Нет доступа' });
  const [act, id] = String(q.data || '').split(':');
  const r = await setStatus(id, act);
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: r.msg }).catch(() => {});
  if (r.b) await refreshMessages(r.b);
  if (r.changed) admin.notifyClient(r.b).catch(() => {});
}
// Запасной способ без кнопок: /ok 9E4729, /cancel 9E4729
async function onMessage(m) {
  const chat = String(m.chat && m.chat.id), t = String(m.text || '').trim();
  // Если заявки и Mini App — один и тот же бот, команды участников обрабатывает админ-модуль
  if (MINIAPP_TOKEN === TOKEN && (!CHAT_IDS.includes(chat) || /^\/(id|admin)\b/i.test(t))) { if (await admin.onUserMessage(m, TOKEN) || !CHAT_IDS.includes(chat)) return; }
  if (!CHAT_IDS.includes(chat)) return;
  const mm = t.match(/^\/?(ok|confirm|да|подтвердить|cancel|no|нет|отмена|отменить)(?:@\w+)?\s+#?([0-9a-f]{6})$/i);
  if (!mm) { if (/^\/(help|start)/i.test(t)) await tg('sendMessage', { chat_id: chat, text: 'Кнопки под заявкой меняют её статус.\nЗапасной вариант — команды:\n/ok КОД — подтвердить\n/cancel КОД — отменить (время освободится)' }); return; }
  const r = await setStatus(mm[2], /^(ok|confirm|да|подтвердить)$/i.test(mm[1]) ? 'ok' : 'no');
  await tg('sendMessage', { chat_id: chat, text: (r.b ? '#' + r.b.id + ': ' : '') + r.msg });
  if (r.b) await refreshMessages(r.b);
  if (r.changed) admin.notifyClient(r.b).catch(() => {});
}

// ---------- Telegram Mini App ----------
// Кнопка «Открыть» в меню бота Mini App (если указан WEBAPP_URL)
async function setupMiniApp() {
  if (!WEBAPP_URL || !MINIAPP_TOKEN) return;
  if (!/^https:\/\//i.test(WEBAPP_URL)) return console.error('[mini app] WEBAPP_URL должен начинаться с https://');
  try {
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Записаться', web_app: { url: WEBAPP_URL } } }, MINIAPP_TOKEN);
    console.log('Mini App: кнопка меню → ' + WEBAPP_URL);
    await tg('setMyCommands', { commands: [{ command: 'start', description: 'Записаться онлайн' }, { command: 'id', description: 'Мой Telegram ID' }] }, MINIAPP_TOKEN).catch(() => {});
  } catch (e) { console.error('[mini app]', e.message.replace(MINIAPP_TOKEN, '***')); }
}

const admin = createAdmin({ CONFIG, CONFIG_FILE, DATA_DIR, MINIAPP_TOKEN, WEBAPP_URL, tg, send, readBody, Core, setStatus, refreshMessages, getDb: () => db });
const miniPollState = { running: false, lastOkAt: null, lastError: null };

// ---------- HTTP ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), arr = (hits.get(ip) || []).filter(t => now - t < 10 * 60e3);
  arr.push(now); hits.set(ip, arr); return arr.length > 5;
}
function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 10240) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json' };

async function handleBooking(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  let input;
  try { input = JSON.parse(await readBody(req)); } catch { return send(res, 400, { ok: false, error: 'Некорректный запрос' }); }
  if (input && input.website) return send(res, 200, { ok: true, id: 'ok' }); // honeypot для ботов
  if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'Слишком много заявок. Позвоните нам: ' + CONFIG.business.phoneDisplay });
  if (!TOKEN || !CHAT_IDS.length) return send(res, 503, { ok: false, error: 'Онлайн-запись временно недоступна. Позвоните: ' + CONFIG.business.phoneDisplay });

  const tgU = admin.verifyInitData(input && input.tgInitData);
  if (tgU && admin.isBanned(tgU.id)) return send(res, 403, { ok: false, error: 'Онлайн-запись для вашего аккаунта недоступна. Позвоните: ' + CONFIG.business.phoneDisplay });
  if (tgU) admin.upsertUser(tgU);
  const result = await exclusive(async () => {
    const v = Core.validateBooking(input, CONFIG, Core.fullCellsFrom(db, CONFIG), new Date());
    if (!v.ok) return { code: 422, body: { ok: false, errors: v.errors } };
    const b = Object.assign({ id: crypto.randomBytes(3).toString('hex').toUpperCase(), status: 'new', createdAt: new Date().toISOString(), ip }, v.booking);
    const tgUser = admin.verifyInitData(input.tgInitData);
    if (tgUser) { b.tgUser = { id: tgUser.id, username: tgUser.username, name: tgUser.name }; b.source = 'telegram'; }
    try { b.messages = await notify(b); }
    catch (e) { return { code: 502, body: { ok: false, error: 'Не удалось отправить заявку. Попробуйте ещё раз или позвоните: ' + CONFIG.business.phoneDisplay } }; }
    db.push(b); saveDb(db); // слот занимается только после успешной отправки в Telegram
    return { code: 200, body: { ok: true, id: b.id, date: b.date, time: b.time, price: b.price, minutes: b.minutes } };
  });
  send(res, result.code, result.body);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/booking' && req.method === 'POST') return await handleBooking(req, res);
    if (url.pathname === '/api/busy' && req.method === 'GET') {
      const now = Core.nowInTz(CONFIG.schedule.timezone).date;
      const full = [...Core.fullCellsFrom(db, CONFIG)].filter(c => c.slice(0, 10) >= now);
      return send(res, 200, { ok: true, full, now: Core.nowInTz(CONFIG.schedule.timezone) });
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, telegramConfigured: !!(TOKEN && CHAT_IDS.length), chats: CHAT_IDS.length, telegramLastOk: tgState.lastOkAt, telegramLastError: tgState.lastError, telegramLastErrorAt: tgState.lastErrorAt, buttonsPolling: POLLING ? pollState : 'выключено (TELEGRAM_POLLING=0)', miniAppPolling: MINIAPP_TOKEN !== TOKEN ? miniPollState : 'тот же бот' });
    if (url.pathname === '/config.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      return res.end('window.GD_CONFIG = ' + JSON.stringify(CONFIG) + ';\nwindow.GD_API = "/api";\n');
    }
    if (await admin.handle(req, res, url)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { ok: false });
    let p = decodeURIComponent(url.pathname); if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { ok: false });
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
      if (file === path.join(PUBLIC, 'index.html') && CONFIG.images) { // картинки из админ-панели — сразу в HTML, без «мигания»
        const attr = v => String(v).replace(/"/g, '&quot;');
        buf = Buffer.from(buf.toString('utf8').replace('srcset="hero-mobile.webp"', 'srcset="' + attr(CONFIG.images.heroMobile || 'hero-mobile.webp') + '"').replace('src="hero.webp"', 'src="' + attr(CONFIG.images.hero || 'hero.webp') + '"'));
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': path.extname(file) === '.webp' ? 'max-age=604800' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      res.end(buf);
    });
  } catch (e) { console.error(e); send(res, 500, { ok: false, error: 'Ошибка сервера' }); }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Garage Detailing: http://localhost:${PORT}`);
    if (!TOKEN || !CHAT_IDS.length) console.warn('⚠ Не заданы TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID в .env — запись работать не будет');
    else { if (process.env.TELEGRAM_SELFCHECK !== '0') selfCheck(); if (POLLING) pollLoop(); setupMiniApp();
      if (POLLING && MINIAPP_TOKEN && MINIAPP_TOKEN !== TOKEN) pollLoop(MINIAPP_TOKEN, miniPollState, m => admin.onUserMessage(m, MINIAPP_TOKEN), null); }
  });
}
module.exports = { server, bookingText };
