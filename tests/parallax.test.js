// Проверка параллакса главного экрана: SITE=http://127.0.0.1:3000/ node tests/parallax.test.js
const { chromium } = require('playwright');
const assert = require('assert');
const URL_ = process.env.SITE || 'http://127.0.0.1:3000/';
let ok = 0, fail = 0;
const t = async (n, f) => { try { await f(); ok++; console.log('  ✔ ' + n); } catch (e) { fail++; console.log('  ✖ ' + n + '\n     ' + e.message.split('\n')[0]); } };
const shift = (p, sel) => p.evaluate((s) => { const m = new DOMMatrix(getComputedStyle(document.querySelector(s)).transform); return { x: m.m41, y: m.m42 }; }, sel);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  for (const vp of [{ n: 'desktop', w: 1366, h: 900 }, { n: 'mobile', w: 390, h: 844, m: true }]) {
    console.log('\nПараллакс: ' + vp.n);
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.m, hasTouch: !!vp.m, deviceScaleFactor: vp.m ? 2 : 1 });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/yandex/, (r) => r.fulfill({ body: '' }));
    await p.goto(URL_, { waitUntil: 'networkidle' });
    const box = await p.locator('.hero').boundingBox();
    const max = vp.m ? 8 : 18;
    await t('картинка больше окна на 10% и не оставляет пустых краёв', async () => {
      const r = await p.evaluate(() => { const bg = document.querySelector('.hero-bg').getBoundingClientRect(), l = document.querySelector('.hero-bg picture').getBoundingClientRect(); return { bw: bg.width, lw: l.width, bh: bg.height, lh: l.height, ov: getComputedStyle(document.querySelector('.hero-bg')).overflow }; });
      assert.ok(Math.abs(r.lw / r.bw - 1.1) < 0.01 && Math.abs(r.lh / r.bh - 1.1) < 0.01, JSON.stringify(r)); assert.strictEqual(r.ov, 'hidden');
      assert.ok(r.bw * 0.05 > max && r.bh * 0.05 > max, 'запас больше макс. сдвига');
    });
    await t('кнопки над картинкой и кликабельны', async () => {
      const hit = await p.evaluate(() => { const b = document.querySelector('.hero .cta a, .hero .cta button'); const r = b.getBoundingClientRect(); const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return b.contains(el); });
      assert.ok(hit);
    });
    const corner = { x: box.x + 4, y: box.y + Math.min(box.height, vp.h) * 0.02 + 4 };
    if (!vp.m) {
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await t('плавно догоняет курсор (Lerp, без рывка)', async () => {
        await p.mouse.move(corner.x, corner.y);
        await p.waitForTimeout(50); const a = await shift(p, '.hero-bg picture');
        assert.ok(a.x > 0.3 && a.x < max - 1, 'промежуточное значение: ' + a.x);
        await p.waitForTimeout(1500); const b = await shift(p, '.hero-bg picture');
        assert.ok(b.x > max * 0.9 && b.x <= max + 0.01, 'итог x ' + b.x);
      });
      await t('неоновый слой движется навстречу (глубина)', async () => { const g = await shift(p, '.hero-glow'); assert.ok(g.x < -max), g.x; });
      await t('курсор ушёл с блока → плавный возврат в центр', async () => {
        await p.mouse.move(box.x + box.width / 2, box.y + box.height + 300); await p.evaluate(() => window.scrollTo(0, 0));
        await p.waitForTimeout(1800); const b = await shift(p, '.hero-bg picture'); assert.ok(Math.abs(b.x) < 0.2 && Math.abs(b.y) < 0.2, JSON.stringify(b));
      });
    } else {
      const cdp = await ctx.newCDPSession(p);
      const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      const y = box.y + 80;
      await t('палец ведёт картинку, сдвиг на телефоне ≤ 8px', async () => {
        await touch('touchStart', vp.w / 2, y);
        for (let i = 1; i <= 8; i++) { await touch('touchMove', vp.w / 2 - i * 22, y); await p.waitForTimeout(30); }
        await p.waitForTimeout(1200); const s = await shift(p, '.hero-bg picture');
        assert.ok(s.x > 3 && s.x <= max + 0.01, 'x ' + s.x);
      });
      await t('палец оторван → возврат в центр', async () => {
        await touch('touchEnd'); await p.waitForTimeout(1800); const s = await shift(p, '.hero-bg picture'); assert.ok(Math.abs(s.x) < 0.2, 'x ' + s.x);
      });
    }
    await t('нет горизонтальной прокрутки', async () => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)));
    await t('цикл анимации засыпает в покое', async () => { await p.waitForTimeout(300); const a = await p.evaluate(() => document.querySelector('.hero-bg picture').style.transform); await p.waitForTimeout(400); assert.strictEqual(await p.evaluate(() => document.querySelector('.hero-bg picture').style.transform), a); });
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/px-${vp.n}.png` });
    await t('нет ошибок JavaScript', async () => assert.deepStrictEqual(errs, []));
    await ctx.close();
  }
  await browser.close();
  console.log(`\nИтого параллакс: ${ok} пройдено, ${fail} с ошибкой`); process.exit(fail ? 1 : 0);
})();
