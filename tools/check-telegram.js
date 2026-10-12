// Проверка подключения бота: node tools/check-telegram.js
// 1) проверяет токен (getMe); 2) показывает chat_id тех, кто писал боту; 3) шлёт тестовое сообщение в TELEGRAM_CHAT_ID.
const path = require('path');
require('./env.js')(path.join(__dirname, '..'));
const T = (process.env.TELEGRAM_BOT_TOKEN || '').trim(), BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const call = async (m, b) => { const r = await fetch(`${BASE}/bot${T}/${m}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }); return r.json(); };
(async () => {
  if (!/^\d+:[\w-]{30,}$/.test(T)) { console.log('✖ TELEGRAM_BOT_TOKEN не задан или неверного формата (пример: 123456789:AA...).\n  Проверьте, что файл называется именно «.env» (не .env.example / .env.txt) и лежит в папке ' + path.join(__dirname, '..')); process.exit(1); }
  const me = await call('getMe'); if (!me.ok) { console.log('✖ Токен не принят Telegram:', me.description); process.exit(1); }
  console.log('✔ Бот найден: @' + me.result.username);
  const wh = await call('getWebhookInfo'); if (wh.ok && wh.result.url) console.log('⚠ У бота установлен webhook (' + wh.result.url + ') — кнопки «Подтвердить/Отменить» работать не будут. Удалите: deleteWebhook');
  const up = await call('getUpdates', { limit: 50 });
  const chats = new Map(); (up.result || []).forEach(u => { const c = (u.message || u.my_chat_member || {}).chat; if (c) chats.set(c.id, c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username); });
  if (chats.size) { console.log('Чаты, которые писали боту (возьмите нужный chat_id):'); chats.forEach((n, id) => console.log('   chat_id = ' + id + '   (' + n + ')')); }
  const ids = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.includes(String(me.result.id))) { console.log('✖ TELEGRAM_CHAT_ID = ' + me.result.id + ' — это ID самого бота (цифры из токена), а нужен ID вашего чата.\n  Напишите боту /start в Telegram и запустите проверку снова — выше появится ваш chat_id.'); process.exit(1); }
  if (!ids.length) { console.log('✖ TELEGRAM_CHAT_ID не задан. Напишите боту /start и запустите проверку снова.'); process.exit(1); }
  for (const id of ids) {
    const r = await call('sendMessage', { chat_id: id, text: '✅ Garage Detailing: бот подключён, заявки с сайта будут приходить сюда.' });
    console.log(r.ok ? '✔ Тестовое сообщение отправлено в ' + id : '✖ Не удалось отправить в ' + id + ': ' + r.description);
    if (!r.ok) process.exitCode = 1;
  }
})().catch(e => { console.log('✖ Ошибка сети:', e.message); process.exit(1); });
