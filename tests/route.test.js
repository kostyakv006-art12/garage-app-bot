// Маршрут в навигаторы и пакеты 3D: SITE=http://127.0.0.1:3000/ node tests/route.test.js
const { chromium } = require('playwright');
const assert = require('assert');
const URL_ = process.env.SITE || 'http://127.0.0.1:3000/';
let ok = 0, fail = 0;
const t = async (n, f) => { try { await f(); ok++; console.log('  ✔ ' + n); } catch (e) { fail++; console.log('  ✖ ' + n + '\n     ' + e.message.split('\n')[0]); } };
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
  for (const vp of [{ n: 'desktop', w: 1366, h: 900 }, { n: 'mobile', w: 390, h: 844, m: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' }]) {
    console.log('\nМаршрут: ' + vp.n);
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.m, hasTouch: !!vp.m, deviceScaleFactor: vp.m ? 2 : 1, userAgent: vp.ua });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/yandex\.ru\/map-widget/, (r) => r.fulfill({ body: '' }));
    // тяжёлую 3D-модель тут не грузим: проверяем только интерфейс пакетов (сама 3D — в viewer3d.test.js)
    await p.route(/\.glb(\?|$)/, (r) => r.abort());
    await p.goto(URL_, { waitUntil: 'networkidle' });
    await t('панель маршрута скрыта, по кнопке открывается', async () => {
      assert.ok(await p.isHidden('#route')); await p.click('[data-route-open]'); assert.ok(await p.isVisible('#route'));
      assert.strictEqual(await p.getAttribute('[data-route-open]', 'aria-expanded'), 'true');
    });
    await t('3 навигатора с точкой студии', async () => {
      const h = await p.$$eval('[data-nav]', (a) => a.map((x) => [x.dataset.nav, x.href, x.textContent]));
      assert.strictEqual(h.length, 3);
      h.forEach(([, href]) => assert.ok(/54\.251868/.test(href) && /48\.319854/.test(href), href));
      assert.match(h[0][1], /yandex\.ru\/maps\/\?rtext=~54\.251868,48\.319854&rtt=auto/);
      assert.match(h[1][1], /google\.com\/maps\/dir\/\?api=1&destination=/);
      assert.match(h[2][1], /2gis\.ru\/directions\/points/);
      assert.match(h[0][2], vp.m ? /Навигатор/ : /Яндекс Карты/);
    });
    if (vp.m) await t('телефон: тап открывает приложение Яндекс Навигатор (yandexnavi://)', async () => {
      const goes = await p.evaluate(() => new Promise((res) => {
        const seen = []; GDRoute.go = (u) => seen.push(u);   // не уходим со страницы
        document.querySelector('[data-nav=yandex]').click();
        setTimeout(() => res(seen), 1500);
      }));
      const href = goes[0];
      assert.strictEqual(goes[1], 'https://yandex.ru/maps/?rtext=~54.251868,48.319854&rtt=auto', 'фолбэк на веб, если приложения нет');
      assert.ok(/^yandexnavi:\/\/build_route_on_map\?lat_to=54\.251868&lon_to=48\.319854$/.test(href) , href);
    });
    if (process.env.SHOTS) await p.locator('#contacts .card').screenshot({ path: `${process.env.SHOTS}/route-${vp.n}.png` });
    await t('пакеты 3D: 4 кнопки, «Детейлинг» отмечает нужные услуги', async () => {
      assert.strictEqual(await p.locator('[data-preset]').count(), 4);
      // на телефоне 3D-сцена «липкая»: прокручиваем так, чтобы пакеты были под ней (как это делает человек)
      await p.evaluate(() => { const e = document.querySelector('.v3-presets'); scrollTo({ top: scrollY + e.getBoundingClientRect().bottom - innerHeight + 40, behavior: 'instant' }); });
      await p.waitForTimeout(300);
      const tapPreset = async (id) => { const b = await p.locator(`[data-preset=${id}]`).boundingBox(); const hit = await p.evaluate(([x, y, id]) => !!document.elementFromPoint(x, y).closest(`[data-preset=${id}]`), [b.x + b.width / 2, b.y + b.height / 2, id]); assert.ok(hit, 'кнопка пакета перекрыта'); await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
      await tapPreset('detailing');
      const on = await p.$$eval('.v3-services input:checked', (a) => a.map((x) => x.value).sort());
      assert.deepStrictEqual(on, ['ceramic', 'headlights', 'polish_full', 'wash3']);
      assert.strictEqual(await p.getAttribute('[data-preset=detailing]', 'aria-pressed'), 'true');
      await tapPreset('express');
      assert.deepStrictEqual(await p.$$eval('.v3-services input:checked', (a) => a.map((x) => x.value)), ['wash2']);
      assert.strictEqual(await p.getAttribute('[data-preset=detailing]', 'aria-pressed'), 'false');
    });
    await t('нет горизонтальной прокрутки и ошибок JS', async () => { assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepStrictEqual(errs, []); });
    await ctx.close();
  }
  await browser.close(); console.log(`\nИтого маршрут и пакеты: ${ok} пройдено, ${fail} с ошибкой`); process.exit(fail ? 1 : 0);
})();
