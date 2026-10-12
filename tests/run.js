'use strict';
const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process');
const C = require('../public/booking-core.js');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('  ✔ ' + name); } catch (e) { fail++; console.log('  ✖ ' + name + '\n     ' + e.message); } }

// фиксированное «сейчас»: 5 окт 2026, 13:37 по Ульяновску (UTC+4) = 09:37 UTC
const NOW = new Date('2026-10-05T09:37:00Z');
const base = { carClass: 'sedan', services: ['wash3'], date: '2026-10-06', time: '10:00', name: 'Иван', phone: '8 927 123-45-67', car: 'Kia Rio', comment: '', consent: true };
const v = (o, full, now) => C.validateBooking(Object.assign({}, base, o), cfg, full || new Set(), now || NOW);

(async () => {
  console.log('\n1. Логика записи');
  await t('часовой пояс Ульяновска (UTC+4)', () => assert.deepStrictEqual(C.nowInTz('Europe/Ulyanovsk', NOW), { date: '2026-10-05', minutes: 13 * 60 + 37 }));
  await t('корректная заявка проходит', () => { const r = v({}); assert.ok(r.ok, JSON.stringify(r.errors)); assert.strictEqual(r.booking.phone, '+79271234567'); });
  await t('телефон: +7, 8, 10 цифр; отказ для городского и мусора', () => {
    assert.strictEqual(C.normalizePhone('+7 (927) 123-45-67'), '+79271234567');
    assert.strictEqual(C.normalizePhone('9271234567'), '+79271234567');
    ['', '12345', '+7 842 212-34-56', '+1 202 555 0101', '8927123456789'].forEach(p => assert.strictEqual(C.normalizePhone(p), null, p));
  });
  await t('пустые/неверные поля дают ошибки', () => { const r = v({ name: '', phone: '123', car: '', consent: false, services: [] }); assert.deepStrictEqual(Object.keys(r.errors).sort(), ['car', 'consent', 'name', 'phone', 'services']); });
  await t('имя с цифрами/HTML отклоняется', () => { assert.ok(v({ name: '<b>x</b>' }).errors.name); assert.ok(v({ name: 'Иван123' }).errors.name); });
  await t('неизвестная услуга и дубль', () => { assert.ok(v({ services: ['hack'] }).errors.services); assert.ok(v({ services: ['wash3', 'wash3'] }).errors.services); });
  await t('несовместимые услуги (2 мойки, 2 полировки, комплекс+мойка)', () => {
    [['wash2', 'wash3'], ['polish_local', 'polish_full'], ['presale', 'wash2'], ['presale', 'polish_full']].forEach(s => assert.ok(v({ services: s }).errors.services, s.join('+')));
  });
  await t('совместимые: мойка + фары + химчистка', () => assert.ok(v({ services: ['wash3', 'headlights', 'interior'], time: '09:00' }).ok));
  await t('класс авто влияет на цену (×1.4)', () => { assert.strictEqual(C.quote(['wash3'], 'sedan', cfg).price, 1000); assert.strictEqual(C.quote(['wash3'], 'jeep', cfg).price, 1400); });
  await t('подмена цены с клиента невозможна (считается на сервере)', () => assert.strictEqual(v({ price: 1 }).booking.price, 1000));
  await t('прошедшая дата', () => assert.strictEqual(v({ date: '2026-10-04' }).errors.time, 'Дата уже прошла'));
  await t('сегодня: время раньше «сейчас + 60 мин» закрыто', () => { assert.ok(v({ date: '2026-10-05', time: '14:00' }).errors.time); assert.ok(v({ date: '2026-10-05', time: '15:00' }).ok); });
  await t('дальше 30 дней — нельзя', () => assert.ok(v({ date: '2026-11-05' }).errors.time));
  await t('несуществующие дата/время', () => { assert.ok(v({ date: '2026-02-30' }).errors.time); assert.ok(v({ time: '10:15' }).errors.time); assert.ok(v({ time: '20:00' }).errors.time); assert.ok(v({ time: '07:00' }).errors.time); });
  await t('работы должны закончиться до закрытия (20:00)', () => { assert.ok(v({ time: '19:00' }).errors.time); assert.ok(v({ time: '18:30' }).ok); assert.ok(v({ services: ['interior'], time: '12:30' }).errors.time); assert.ok(v({ services: ['interior'], time: '12:00' }).ok); });
  await t('многодневные работы: только к открытию, занимают следующий день', () => {
    const s = ['polish_full', 'ceramic']; // 13 ч > 11 ч рабочего дня
    assert.ok(v({ services: s, time: '10:00' }).errors.time);
    const r = v({ services: s, time: '09:00' }); assert.ok(r.ok);
    assert.ok(r.booking.multiDay); assert.ok(r.booking.cells.includes('2026-10-07|09:00')); assert.ok(r.booking.cells.includes('2026-10-07|10:30')); assert.ok(!r.booking.cells.includes('2026-10-07|11:00'));
  });
  await t('занятый слот и пересечение интервалов', () => {
    const full = C.fullCellsFrom([{ cells: C.jobCells('2026-10-06', '10:00', 90, cfg) }], cfg);
    assert.ok(v({ time: '10:00' }, full).errors.time); assert.ok(v({ time: '09:00' }, full).errors.time); // 9:00–10:30 пересекается
    assert.ok(v({ time: '08:30' === 0 ? '' : '11:30' }, full).ok); assert.ok(v({ time: '11:00' }, full).errors.time);
  });
  await t('отменённая запись освобождает время', () => { const full = C.fullCellsFrom([{ status: 'cancelled', cells: ['2026-10-06|10:00'] }], cfg); assert.ok(v({}, full).ok); });
  await t('выходной день (если задан) закрыт и пропускается в многодневных', () => {
    const c2 = JSON.parse(JSON.stringify(cfg)); c2.schedule.closedWeekdays = [3]; // ср 07.10
    assert.ok(C.validateBooking(Object.assign({}, base, { date: '2026-10-07' }), c2, new Set(), NOW).errors.time);
    const cells = C.jobCells('2026-10-06', '09:00', 780, c2); assert.ok(cells.some(c => c.startsWith('2026-10-08')) && !cells.some(c => c.startsWith('2026-10-07')));
  });

  // ---------- интеграция ----------
  console.log('\n2. Сервер + Telegram (имитация API)');
  const tg = { msgs: [], edits: [], answers: [], failSend: false, updates: [] };
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = b ? JSON.parse(b) : {}, m = req.url.split('/').pop(), tokenOk = req.url.startsWith('/botTEST:TOKEN/');
      const out = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (!tokenOk) return out({ ok: false, description: 'Unauthorized' });
      if (m === 'sendMessage') { if (tg.failParse && body.parse_mode) return out({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unsupported start tag" }); if (tg.failSend) return out({ ok: false, description: 'Bad Request: chat not found' }); tg.msgs.push(body); return out({ ok: true, result: { message_id: tg.msgs.length } }); }
      if (m === 'getUpdates') { const u = tg.updates.splice(0); return setTimeout(() => out({ ok: true, result: u }), u.length ? 0 : 300); }
      if (m === 'editMessageText') { tg.edits.push(body); return out({ ok: true, result: {} }); }
      if (m === 'answerCallbackQuery') { tg.answers.push(body); return out({ ok: true, result: true }); }
      out({ ok: true, result: {} });
    });
  }).listen(0);
  await new Promise(r => mock.on('listening', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-'));
  const cfgCopy = path.join(dataDir, 'config.json'); fs.copyFileSync(path.join(__dirname, '..', 'config.json'), cfgCopy);
  const PORT = 3999;
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_CHAT_ID: '111', TELEGRAM_API_BASE: 'http://127.0.0.1:' + mock.address().port, DATA_DIR: dataDir, CONFIG_FILE: cfgCopy, ADMIN_IDS: '42', TELEGRAM_MINIAPP_BOT_TOKEN: '', WEBAPP_URL: 'https://example.com/' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let srvLog = ''; srv.stdout.on('data', d => srvLog += d); srv.stderr.on('data', d => srvLog += d);
  await new Promise(r => setTimeout(r, 700));
  const U = 'http://127.0.0.1:' + PORT;
  const post = (o, ip) => fetch(U + '/api/booking', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || '1.1.1.1' }, body: typeof o === 'string' ? o : JSON.stringify(o) }).then(async r => ({ s: r.status, j: await r.json() }));
  const today = C.nowInTz('Europe/Ulyanovsk').date, d1 = C.addDays(today, 1), d2 = C.addDays(today, 2);
  const good = Object.assign({}, base, { date: d1, time: '10:00' });

  await t('сайт и config.js отдаются', async () => { const h = await fetch(U + '/'); assert.strictEqual(h.status, 200); assert.ok((await h.text()).includes('Garage')); const c = await (await fetch(U + '/config.js')).text(); assert.ok(c.includes('Автомобилистов')); });
  await t('защита от выхода из папки (path traversal)', async () => { const r = await fetch(U + '/..%2fserver.js'); assert.ok([403, 404].includes(r.status)); const r2 = await fetch(U + '/..%2f.env'); assert.ok([403, 404].includes(r2.status)); });
  await t('health: Telegram настроен', async () => { const h = await (await fetch(U + '/api/health')).json(); assert.strictEqual(h.ok, true); assert.strictEqual(h.telegramConfigured, true); assert.ok(!JSON.stringify(h).includes('TEST:TOKEN'), 'токен не светится'); });
  await t('успешная запись → сообщение в Telegram с кнопками', async () => {
    const r = await post(good); assert.strictEqual(r.s, 200, JSON.stringify(r.j)); assert.ok(r.j.id);
    const m = tg.msgs[0]; assert.strictEqual(m.chat_id, '111'); assert.strictEqual(m.parse_mode, 'HTML');
    ['Иван', '+79271234567', 'Kia Rio', 'Трёхфазная мойка', '10:00', 'от 1 000 ₽'].forEach(s => assert.ok(m.text.replace(/\u00a0/g, ' ').includes(s), 'нет «' + s + '» в: ' + m.text));
    assert.strictEqual(m.reply_markup.inline_keyboard[0].length, 2);
  });
  await t('повторная запись на то же время → 422 «занято»', async () => { const r = await post(good, '2.2.2.2'); assert.strictEqual(r.s, 422); assert.match(r.j.errors.time, /занято/); });
  await t('пересекающееся время (09:30, 1.5 ч) → отказ', async () => { const r = await post(Object.assign({}, good, { time: '09:30' }), '2.2.2.2'); assert.strictEqual(r.s, 422); });
  await t('/api/busy показывает занятые ячейки', async () => { const j = await (await fetch(U + '/api/busy')).json(); assert.ok(j.full.includes(d1 + '|10:00') && j.full.includes(d1 + '|11:00') && !j.full.includes(d1 + '|11:30')); });
  await t('10 одновременных заявок на один слот → принята ровно одна', async () => {
    const before = tg.msgs.length;
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => post(Object.assign({}, good, { date: d2, time: '15:00' }), '10.0.0.' + i)));
    assert.strictEqual(rs.filter(r => r.s === 200).length, 1); assert.strictEqual(tg.msgs.length - before, 1);
  });
  await t('Telegram недоступен → 502, время НЕ занимается', async () => {
    tg.failSend = true; const r = await post(Object.assign({}, good, { date: d2, time: '09:00' }), '3.3.3.3'); tg.failSend = false;
    assert.strictEqual(r.s, 502); assert.match(r.j.error, /позвоните/);
    const h = await (await fetch(U + '/api/health')).json();
    assert.match(h.telegramLastError || '', /chat not found.*check-telegram/, 'подсказка владельцу в /api/health');
    const r2 = await post(Object.assign({}, good, { date: d2, time: '09:00' }), '3.3.3.3'); assert.strictEqual(r2.s, 200);
  });
  await t('ошибка HTML-разметки → заявка всё равно уходит (без форматирования)', async () => {
    tg.failParse = true; const n = tg.msgs.length; const r = await post(Object.assign({}, good, { date: C.addDays(today, 7), time: '16:00' }), '3.3.3.4'); tg.failParse = false;
    assert.strictEqual(r.s, 200, JSON.stringify(r.j)); assert.strictEqual(tg.msgs.length, n + 1); assert.ok(!tg.msgs[n].parse_mode && !/<b>/.test(tg.msgs[n].text));
  });
  await t('ошибки валидации возвращаются по полям', async () => { const r = await post({ services: ['wash2', 'wash3'], phone: '1' }, '4.4.4.4'); assert.strictEqual(r.s, 422); ['name', 'phone', 'car', 'services', 'consent'].forEach(k => assert.ok(r.j.errors[k], k)); });
  await t('битый JSON и слишком большой запрос', async () => { assert.strictEqual((await post('{oops', '5.5.5.5')).s, 400); const big = await post(JSON.stringify(Object.assign({}, good, { comment: 'x'.repeat(20000) })), '5.5.5.6').catch(() => ({ s: 400 })); assert.strictEqual(big.s, 400); });
  await t('HTML в полях экранируется в Telegram', async () => {
    const r = await post(Object.assign({}, good, { date: d2, time: '17:00', car: '<b>BMW</b> & Co', comment: '<script>alert(1)</script>' }), '6.6.6.6'); assert.strictEqual(r.s, 200);
    const m = tg.msgs[tg.msgs.length - 1].text; assert.ok(m.includes('&lt;b&gt;BMW&lt;/b&gt; &amp; Co') && m.includes('&lt;script&gt;'));
  });
  await t('honeypot: бот-заявка не уходит в Telegram', async () => { const n = tg.msgs.length; const r = await post(Object.assign({}, good, { website: 'spam.ru', time: '18:00' }), '7.7.7.7'); assert.strictEqual(r.s, 200); assert.strictEqual(tg.msgs.length, n); });
  await t('антиспам: больше 5 заявок за 10 мин с одного IP → 429', async () => { let last; for (let i = 0; i < 6; i++) last = await post({}, '8.8.8.8'); assert.strictEqual(last.s, 429); });
  await t('кнопка «Отменить» в Telegram освобождает время', async () => {
    const id = JSON.parse(fs.readFileSync(path.join(dataDir, 'bookings.json'), 'utf8')).find(b => b.date === d1 && b.time === '10:00').id;
    tg.updates.push({ update_id: 1, callback_query: { id: 'cq1', data: 'no:' + id, message: { chat: { id: 111 }, message_id: 1 } } });
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(tg.answers.some(a => /отменена/.test(a.text))); assert.ok(tg.edits.some(e => /ОТМЕНЕНА/.test(e.text)));
    const r = await post(Object.assign({}, good, { name: 'Пётр' }), '9.9.9.9'); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
  });
  const d6 = C.addDays(today, 6);
  const busyHas = async (date, time) => (await (await fetch(U + '/api/busy')).json()).full.includes(date + '|' + time);
  await t('«Подтвердить» → время занято; потом «Отменить» → время свободно', async () => {
    const r = await post(Object.assign({}, good, { date: d6, time: '10:00', services: ['wash2'] }), '7.7.7.1'); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    assert.ok(await busyHas(d6, '10:00'), 'новая заявка сразу держит время');
    tg.updates.push({ update_id: 10, callback_query: { id: 'cq10', data: 'ok:' + r.j.id, message: { chat: { id: 111 }, message_id: 1 } } });
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(tg.answers.some(a => a.callback_query_id === 'cq10' && /подтверждена/.test(a.text)));
    assert.ok(await busyHas(d6, '10:00'), 'подтверждённая держит время');
    const ed = tg.edits.filter(e => /ПОДТВЕРЖДЕНА/.test(e.text)).pop(); assert.ok(ed && /^no:/.test(ed.reply_markup.inline_keyboard[0][0].callback_data), 'у подтверждённой осталась кнопка отмены');
    tg.updates.push({ update_id: 11, callback_query: { id: 'cq11', data: 'no:' + r.j.id, message: { chat: { id: 111 }, message_id: 1 } } });
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(!(await busyHas(d6, '10:00')), 'после отмены время свободно');
    const r2 = await post(Object.assign({}, good, { date: d6, time: '10:00', services: ['wash2'], name: 'Олег' }), '7.7.7.2'); assert.strictEqual(r2.s, 200, JSON.stringify(r2.j));
  });
  await t('запасные команды в чате: /cancel КОД освобождает время', async () => {
    const r = await post(Object.assign({}, good, { date: d6, time: '14:00', services: ['wash2'] }), '7.7.7.3'); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    tg.updates.push({ update_id: 12, message: { chat: { id: 111 }, text: '/cancel ' + r.j.id.toLowerCase() } });
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(tg.msgs.some(m => /отменена/.test(m.text || '')), 'ответ на команду'); assert.ok(!(await busyHas(d6, '14:00')));
  });
  await t('кнопки из чужого чата игнорируются', async () => {
    tg.updates.push({ update_id: 2, callback_query: { id: 'cq2', data: 'no:XXXX', message: { chat: { id: 999 }, message_id: 1 } } });
    await new Promise(r => setTimeout(r, 1200)); assert.ok(tg.answers.some(a => a.callback_query_id === 'cq2' && a.text === 'Нет доступа'));
  });
  await t('записи сохраняются после перезапуска (файл bookings.json валиден)', () => { const list = JSON.parse(fs.readFileSync(path.join(dataDir, 'bookings.json'), 'utf8')); assert.ok(list.length >= 4); });

  // ---------- админ-панель ----------
  console.log('\n2б. Админ-панель (Telegram ID)');
  const crypto = require('crypto');
  const sign = (user, token = 'TEST:TOKEN', age = 0) => {
    const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000) - age), query_id: 'q', user: JSON.stringify(user) });
    const check = [...p.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex')); return p.toString();
  };
  const ADM = sign({ id: 42, first_name: 'Админ' }), USR = sign({ id: 777, first_name: 'Клиент', username: 'client' });
  const A = (pth, body, init = ADM) => fetch(U + '/api/admin/' + pth, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': init }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ s: r.status, j: await r.json() }));
  const cfgNow = async () => JSON.parse((await (await fetch(U + '/config.js')).text()).match(/GD_CONFIG = (.*);\n/)[1]);
  await t('без подписи Telegram → 401, поддельная подпись → 401', async () => {
    assert.strictEqual((await A('state', null, '')).s, 401);
    assert.strictEqual((await A('state', null, sign({ id: 42 }, 'WRONG:TOKEN'))).s, 401);
    assert.strictEqual((await A('state', null, sign({ id: 42 }, 'TEST:TOKEN', 3 * 86400))).s, 401, 'просроченная подпись');
  });
  await t('чужой Telegram ID → 403, админ (ADMIN_IDS) → доступ', async () => {
    assert.strictEqual((await A('state', null, USR)).s, 403);
    const r = await A('state'); assert.strictEqual(r.s, 200); assert.ok(r.j.me.owner); assert.ok(Array.isArray(r.j.bookings));
  });
  await t('участник регистрируется при открытии Mini App', async () => {
    const r = await (await fetch(U + '/api/tg/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: USR }) })).json();
    assert.deepStrictEqual([r.ok, r.isAdmin, r.banned], [true, false, false]);
    assert.ok((await A('state')).j.users.some(u => u.id === '777' && u.username === 'client'));
  });
  let newId;
  await t('добавить услугу (вид, название, цена, время) → появляется на сайте', async () => {
    const r = await A('service', { category: 'Шиномонтаж', name: 'Сезонная смена шин', desc: '', price: 2500, minutes: 60, excludes: ['wash2'] });
    assert.strictEqual(r.s, 200, JSON.stringify(r.j)); newId = r.j.service.id;
    const c = await cfgNow(); const s = c.services.find(x => x.id === newId);
    assert.deepStrictEqual([s.category, s.name, s.price, s.minutes], ['Шиномонтаж', 'Сезонная смена шин', 2500, 60]);
    assert.ok(c.services.find(x => x.id === 'wash2').excludes.includes(newId), 'несовместимость взаимная');
  });
  await t('валидация услуги: пустые поля, время не кратно 30, дубль названия', async () => {
    const r = await A('service', { category: '', name: 'x', price: -5, minutes: 45 }); assert.strictEqual(r.s, 422);
    assert.deepStrictEqual(Object.keys(r.j.errors).sort(), ['category', 'minutes', 'name', 'price']);
    assert.ok((await A('service', { category: 'Мойка', name: 'Двухфазная мойка', price: 1, minutes: 30 })).j.errors.name);
  });
  await t('новую услугу можно забронировать, затем изменить цену', async () => {
    const r = await post(Object.assign({}, good, { date: C.addDays(today, 8), time: '12:00', services: [newId] }), '5.5.5.5'); assert.strictEqual(r.s, 200, JSON.stringify(r.j)); assert.strictEqual(r.j.price, 2500);
    assert.strictEqual((await A('service', { id: newId, category: 'Шиномонтаж', name: 'Сезонная смена шин', price: 3000, minutes: 90 })).s, 200);
    assert.strictEqual((await cfgNow()).services.find(x => x.id === newId).price, 3000);
  });
  await t('удалить услугу → пропадает с сайта и из несовместимых', async () => {
    assert.strictEqual((await A('service-delete', { id: newId })).s, 200);
    const c = await cfgNow(); assert.ok(!c.services.some(x => x.id === newId)); assert.ok(!c.services.some(x => x.excludes.includes(newId)));
    assert.strictEqual((await post(Object.assign({}, good, { date: C.addDays(today, 9), services: [newId] }), '5.5.5.6')).s, 422, 'удалённую нельзя забронировать');
  });
  await t('изменение данных и коэффициентов цены сохраняется в config', async () => {
    const st = (await A('state')).j.config;
    const body = { business: Object.assign({}, st.business, { address: 'ул. Новая, 1' }), schedule: st.schedule, carClasses: st.carClasses.map(c => c.id === 'jeep' ? Object.assign({}, c, { factor: 1.5 }) : c) };
    assert.strictEqual((await A('business', body)).s, 200);
    const c = await cfgNow(); assert.strictEqual(c.business.address, 'ул. Новая, 1'); assert.strictEqual(c.carClasses.find(x => x.id === 'jeep').factor, 1.5);
    assert.strictEqual(JSON.parse(fs.readFileSync(cfgCopy, 'utf8')).business.address, 'ул. Новая, 1');
    const bad = await A('business', Object.assign({}, body, { schedule: Object.assign({}, st.schedule, { open: '20:00', close: '09:00' }), business: Object.assign({}, st.business, { phone: 'abc' }) }));
    assert.strictEqual(bad.s, 422); assert.ok(bad.j.errors.hours && bad.j.errors.phone);
    assert.strictEqual((await A('business', { business: st.business, schedule: st.schedule, carClasses: st.carClasses })).s, 200, 'возвращаем исходные данные');
  });
  await t('заявка из Mini App: подтверждение в панели → клиенту приходит уведомление', async () => {
    const r = await post(Object.assign({}, good, { date: C.addDays(today, 10), time: '11:00', tgInitData: USR }), '5.5.5.7'); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    assert.ok(tg.msgs[tg.msgs.length - 1].text.includes('@client'), 'в заявке есть Telegram клиента');
    const a = await A('booking', { id: r.j.id, act: 'ok' }); assert.strictEqual(a.j.status, 'confirmed');
    await new Promise(r => setTimeout(r, 300));
    assert.ok(tg.msgs.some(m => String(m.chat_id) === '777' && /подтверждена/.test(m.text)));
    assert.ok(tg.edits.some(e => /ПОДТВЕРЖДЕНА/.test(e.text) && e.text.includes(r.j.id)));
  });
  await t('сообщение одному участнику и рассылка всем', async () => {
    const n = tg.msgs.length;
    assert.strictEqual((await A('message', { userId: '777', text: 'Привет' })).s, 200);
    assert.ok(tg.msgs.slice(n).some(m => String(m.chat_id) === '777' && m.text === 'Привет' && m.reply_markup.inline_keyboard[0][0].web_app));
    assert.strictEqual((await A('broadcast', { text: 'Акция!' })).s, 200);
    await new Promise(r => setTimeout(r, 500));
    const st = (await A('state')).j.broadcast; assert.ok(!st.running && st.sent === st.total && st.total >= 1);
    assert.ok(tg.msgs.some(m => String(m.chat_id) === '777' && m.text === 'Акция!'));
  });
  await t('бан по Telegram ID: нет записи, нет рассылки; разбан возвращает', async () => {
    assert.strictEqual((await A('ban', { userId: '777', banned: true, reason: 'спам' })).s, 200);
    const r = await post(Object.assign({}, good, { date: C.addDays(today, 11), tgInitData: USR }), '5.5.5.8'); assert.strictEqual(r.s, 403);
    const h = await (await fetch(U + '/api/tg/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: USR }) })).json(); assert.strictEqual(h.banned, true);
    await A('broadcast', { text: 'Только не забаненным' }); await new Promise(r => setTimeout(r, 400));
    assert.ok(!tg.msgs.some(m => String(m.chat_id) === '777' && m.text === 'Только не забаненным'));
    assert.strictEqual((await A('ban', { userId: '42', banned: true })).s, 422, 'админа забанить нельзя');
    assert.strictEqual((await A('ban', { userId: '777', banned: false })).s, 200);
    assert.strictEqual((await post(Object.assign({}, good, { date: C.addDays(today, 11), tgInitData: USR }), '5.5.5.9')).s, 200);
  });
  await t('смена картинки: только реальные изображения, файл отдаётся и подставляется в HTML', async () => {
    assert.strictEqual((await A('image', { slot: 'hero', dataUrl: 'data:image/png;base64,' + Buffer.from('<script>').toString('base64') })).s, 422);
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const r = await A('image', { slot: 'hero', dataUrl: 'data:image/png;base64,' + png }); assert.strictEqual(r.s, 200, JSON.stringify(r.j));
    const f = await fetch(U + r.j.url); assert.strictEqual(f.status, 200); assert.strictEqual(f.headers.get('content-type'), 'image/png');
    assert.ok((await (await fetch(U + '/')).text()).includes('src="' + r.j.url + '"'));
    assert.strictEqual((await A('image', { slot: 'hero', dataUrl: null })).j.url, 'hero.webp');
    assert.strictEqual((await fetch(U + '/uploads/../server.js')).status !== 200, true);
  });
  await t('админы: владелец добавляет по ID, новый админ получает доступ', async () => {
    assert.strictEqual((await A('admins', { userId: '555' })).s, 200);
    const NEW = sign({ id: 555, first_name: 'Менеджер' });
    assert.strictEqual((await A('state', null, NEW)).s, 200);
    assert.strictEqual((await A('admins', { userId: '556' }, NEW)).s, 422, 'не владелец не добавляет админов');
    assert.strictEqual((await A('admins', { userId: '555', remove: true })).s, 200);
    assert.strictEqual((await A('state', null, NEW)).s, 403);
  });
  await t('команды бота: /id показывает ID, /admin — кнопку только админу', async () => {
    tg.updates.push({ update_id: 50, message: { chat: { id: 777, type: 'private' }, from: { id: 777, first_name: 'Клиент' }, text: '/id' } });
    tg.updates.push({ update_id: 51, message: { chat: { id: 42, type: 'private' }, from: { id: 42, first_name: 'Админ' }, text: '/admin' } });
    tg.updates.push({ update_id: 52, message: { chat: { id: 777, type: 'private' }, from: { id: 777, first_name: 'Клиент' }, text: '/admin' } });
    await new Promise(r => setTimeout(r, 1200));
    assert.ok(tg.msgs.some(m => String(m.chat_id) === '777' && /Ваш Telegram ID: 777/.test(m.text)));
    assert.ok(tg.msgs.some(m => String(m.chat_id) === '42' && m.reply_markup && /admin\.html$/.test(m.reply_markup.inline_keyboard[0][0].web_app.url)));
    assert.ok(tg.msgs.some(m => String(m.chat_id) === '777' && /Нет доступа/.test(m.text)));
  });

  // ---------- браузер ----------
  console.log('\n3. Браузер: телефон 390px и компьютер');
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  const shots = path.join(__dirname, '..', 'screens'); fs.mkdirSync(shots, { recursive: true });
  for (const vp of [{ n: 'mobile', w: 390, h: 844, m: true }, { n: 'desktop', w: 1366, h: 900 }]) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.m, hasTouch: !!vp.m, deviceScaleFactor: vp.m ? 2 : 1, locale: 'ru-RU', timezoneId: 'Europe/London' });
    const p = await ctx.newPage(); const jsErr = []; p.on('pageerror', e => jsErr.push(e.message));
    await p.route(/yandex\.ru\/map-widget/, r => r.fulfill({ body: '' }));
    await p.goto(U + '/', { waitUntil: 'networkidle' });
    await p.screenshot({ path: path.join(shots, vp.n + '-1-hero.png') });
    await t(vp.n + ': нет горизонтальной прокрутки', async () => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)));
    await t(vp.n + ': пустая отправка показывает ошибки', async () => {
      await p.locator('#booking').scrollIntoViewIfNeeded();
      if (vp.m) await p.click('#mbBtn'); else await p.click('#submit');
      assert.ok((await p.textContent('#err-services')).length > 0); assert.ok((await p.textContent('#err-name')).length > 0);
    });
    await t(vp.n + ': без услуг время не выбирается', async () => assert.match(await p.textContent('#timeHint'), /Сначала выберите услуги/));
    await t(vp.n + ': несовместимая услуга снимается автоматически', async () => {
      await p.click('label[for=sv-wash2]'); await p.click('label[for=sv-wash3]');
      assert.ok(!(await p.isChecked('#sv-wash2'))); assert.ok(await p.isChecked('#sv-wash3')); assert.match(await p.textContent('#svcNotice'), /нельзя совместить/);
    });
    await t(vp.n + ': цена пересчитывается по классу авто', async () => { await p.click('label[for=cc-jeep]'); assert.match((await p.textContent('#sumTotal')).replace(/\s/g, ''), /от1400₽/); await p.click('label[for=cc-sedan]'); });
    const day = vp.m ? d1 : d2;
    await p.click(`label[for=d-${day}]`);
    await t(vp.n + ': занятое время недоступно', async () => { if (vp.m) assert.ok(await p.isDisabled('#t-1000')); else assert.ok(await p.isDisabled('#t-1500')); });
    await t(vp.n + ': поздние слоты закрыты (не успеем до 20:00)', async () => assert.ok(await p.isDisabled('#t-1930')));
    await p.click('label[for=t-1200]');
    await p.fill('#name', 'Анна'); await p.fill('#phone', ''); await p.type('#phone', '89271112233');
    await t(vp.n + ': маска телефона', async () => assert.strictEqual(await p.inputValue('#phone'), '+7 (927) 111-22-33'));
    await p.fill('#car', 'Toyota Camry'); await p.check('#consent');
    await p.locator('#whenStep').screenshot({ path: path.join(shots, vp.n + '-2-when.png') });
    await p.screenshot({ path: path.join(shots, vp.n + '-3-form.png') });
    const before = tg.msgs.length;
    if (vp.m) await p.click('#mbBtn'); else await p.click('#submit');
    await p.waitForSelector('#modal.open', { timeout: 5000 }).catch(() => {});
    await t(vp.n + ': заявка отправлена и пришла в Telegram', async () => { assert.ok(await p.isVisible('#modal.open'), await p.textContent('#formErr')); assert.strictEqual(tg.msgs.length, before + 1); assert.ok(tg.msgs[tg.msgs.length - 1].text.includes('Анна')); });
    await p.screenshot({ path: path.join(shots, vp.n + '-4-success.png') });
    await p.click('#mClose');
    await t(vp.n + ': после записи слот сразу занят', async () => { await p.click('label[for=sv-wash3]'); await p.click(`label[for=d-${day}]`); assert.ok(await p.isDisabled('#t-1200')); });
    await p.goto(U + '/#services'); await p.waitForTimeout(400); await p.screenshot({ path: path.join(shots, vp.n + '-5-services.png') });
    await p.goto(U + '/#contacts'); await p.waitForTimeout(400); await p.screenshot({ path: path.join(shots, vp.n + '-6-contacts.png') });
    await t(vp.n + ': нет ошибок JavaScript', async () => assert.deepStrictEqual(jsErr, []));
    await ctx.close();
  }
  await browser.close();
  srv.kill(); mock.close();
  console.log(`\nИтого: ${pass} пройдено, ${fail} с ошибкой`);
  if (fail) { console.log(srvLog); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
