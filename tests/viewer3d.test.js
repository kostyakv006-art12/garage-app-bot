'use strict';
/* Тесты 3D-блока: node tests/viewer3d.test.js (нужен запущенный сайт: npm start, и интернет для CDN Three.js) */
const assert = require('assert');
const { chromium } = require('playwright');
const URL_ = process.env.SITE || 'http://127.0.0.1:3000/';
const shots = process.env.SHOTS;
let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); pass++; console.log('  ✔ ' + n); } catch (e) { fail++; console.log('  ✖ ' + n + '\n     ' + e.message.split('\n')[0]); } };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  for (const vp of [{ n: 'desktop', w: 1366, h: 900 }, { n: 'mobile', w: 390, h: 844, m: true }]) {
    console.log('\n3D-блок: ' + vp.n);
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: !!vp.m, hasTouch: !!vp.m, deviceScaleFactor: vp.m ? 2 : 1 });
    const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/yandex\.ru\/map-widget/, (r) => r.fulfill({ body: '' }));
    if (process.env.THREE_LOCAL) await p.route(/cdn\.jsdelivr\.net\/npm\/three@0\.165\.0\/(.*)/, (r) => r.fulfill({ path: process.env.THREE_LOCAL + '/' + r.request().url().split('three@0.165.0/')[1], contentType: 'text/javascript' }));
    let threeRequested = false; p.on('request', (r) => { if (/three\.module|viewer3d-scene/.test(r.url())) threeRequested = true; });
    p.setDefaultTimeout(+process.env.TIMEOUT || 60000); // программный рендер (без видеокарты) медленный
    // MODEL3D=lite — облегчённая модель и на компьютере (для медленных CI без GPU)
    await p.goto(URL_ + (process.env.MODEL3D ? '?model3d=' + process.env.MODEL3D : ''), { waitUntil: 'networkidle' });
    await t('ленивая загрузка: Three.js не грузится, пока блок далеко', async () => assert.strictEqual(threeRequested, false));
    await p.locator('#viewer3d').scrollIntoViewIfNeeded();
    await p.waitForFunction(() => window.__gdViewer, null, { timeout: 40000 });
    await p.waitForTimeout(1500);
    const dbg = () => p.evaluate(() => { const d = window.__gdViewer.debug(); return { cam: d.camera, dist: d.distance, cur: d.cur, tri: d.info.triangles, src: d.source }; });
    await t('сцена отрисована: GLB Maybach загружен, полигонов в кадре < 700 000', async () => { const d = await dbg(); assert.equal(d.src, process.env.EXPECT_SRC || 'glb'); assert.ok(d.tri > 1000 && d.tri < (d.src === 'glb' ? 700000 : 60000), d.tri); });
    await t('нет горизонтальной прокрутки', async () => assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)));
    await t('5 уровней загрязнения и 8 услуг', async () => { assert.strictEqual(await p.locator('[data-level]').count(), 5); assert.strictEqual(await p.locator('.v3-services input').count(), 8); });
    if (shots) await p.locator('.v3-stage').screenshot({ path: `${shots}/${vp.n}-compare.png` });

    // ждём, пока плавный переход материалов завершится
    const settle = () => p.waitForFunction(() => { const d = window.__gdViewer.debug(); return ['before', 'after'].every((k) => Object.keys(d.tgt[k]).every((x) => Math.abs(d.tgt[k][x] - d.cur[k][x]) < 0.005)); }, null, { timeout: 45000, polling: 100 });
    await t('70% грязи → «До» грязнее, плавный переход (не рывком)', async () => {
      const start = (await dbg()).cur.before.dirt;
      await p.click('[data-level="70"]');
      const samples = []; for (let i = 0; i < 15; i++) { samples.push((await dbg()).cur.before.dirt); await p.waitForTimeout(60); }
      await settle(); const end = (await dbg()).cur.before.dirt;
      assert.ok(samples.some((v) => v > start + 0.01 && v < 0.69), 'нет промежуточных значений: ' + samples.map((v) => v.toFixed(2)).join(','));
      assert.ok(Math.abs(end - 0.7) < 0.01, 'итог ' + end);
    });
    await t('мультивыбор: полировка + керамика = максимальный блеск', async () => {
      await p.click('.v3-check:has(input[value="polish_full"])'); await p.click('.v3-check:has(input[value="ceramic"])'); await p.click('.v3-check:has(input[value="headlights"])');
      await settle(); const a = (await dbg()).cur.after;
      assert.ok(a.gloss > 0.99 && a.ceramic > 0.99 && a.scratches < 0.05 && a.haze < 0.05 && a.dirt < 0.02, JSON.stringify(a));
    });
    await t('несовместимые услуги: трёхфазная снимает двухфазную', async () => {
      await p.click('.v3-check:has(input[value="wash2"])'); assert.ok(!(await p.isChecked('.v3-services input[value="wash3"]')));
      assert.match(await p.textContent('.v3-note'), /заменяет/);
      await p.click('.v3-check:has(input[value="wash3"])'); assert.ok(!(await p.isChecked('.v3-services input[value="wash2"]')));
    });
    await t('режимы До / После / Сравнить', async () => {
      await p.click('[data-mode="after"]'); assert.ok(await p.isHidden('.v3-tag-before')); assert.ok(await p.isHidden('.v3-split'));
      if (shots) { await p.waitForTimeout(300); await p.locator('.v3-stage').screenshot({ path: `${shots}/${vp.n}-after.png` }); }
      await p.click('[data-mode="before"]'); assert.ok(await p.isHidden('.v3-tag-after'));
      if (shots) { await p.waitForTimeout(300); await p.locator('.v3-stage').screenshot({ path: `${shots}/${vp.n}-before.png` }); }
      await p.click('[data-mode="compare"]'); assert.ok(await p.isVisible('.v3-split'));
    });
    await t('слайдер сравнения перетаскивается', async () => {
      const b = await p.locator('.v3-split').boundingBox(), st = await p.locator('.v3-stage').boundingBox();
      await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.mouse.move(st.x + st.width * 0.25, b.y + b.height / 2, { steps: 5 }); await p.mouse.up();
      const v = +(await p.getAttribute('.v3-split', 'aria-valuenow')); assert.ok(v > 20 && v < 32, v);
    });
    for (const v of ['front', 'rear', 'side', 'top', 'low', 'three']) {
      await t('ракурс «' + v + '»', async () => {
        await p.click(`[data-view="${v}"]`); await p.waitForTimeout(200); await p.waitForFunction(() => !window.__gdViewer.debug().flying, null, { timeout: 20000 }); await p.waitForTimeout(300); const d = await dbg();
        assert.ok(d.cam[1] > 0.1, 'камера под полом'); assert.ok(d.dist >= 3.59 && d.dist <= 10.51, 'дистанция ' + d.dist);
        if (shots && (v === 'front' || v === 'rear' || v === 'top' || v === 'low')) await p.locator('.v3-stage').screenshot({ path: `${shots}/${vp.n}-view-${v}.png` });
      });
    }
    if (!vp.m) {
      await t('зум колёсиком ограничен (не внутрь кузова и не далеко)', async () => {
        const st = await p.locator('.v3-stage').boundingBox(); await p.mouse.move(st.x + st.width * 0.7, st.y + st.height * 0.45);
        for (let i = 0; i < 25; i++) { await p.mouse.wheel(0, -400); await p.waitForTimeout(20); } await p.waitForTimeout(900);
        const near = (await dbg()).dist; assert.ok(near >= 3.59 && near < 4.2, 'близко ' + near);
        for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, 600); await p.waitForTimeout(20); } await p.waitForTimeout(900);
        const far = (await dbg()).dist; assert.ok(far <= 10.51 && far > 9, 'далеко ' + far);
      });
      await t('вращение мышью на 360°', async () => {
        const st = await p.locator('.v3-stage').boundingBox(), y = st.y + st.height * 0.45, before = (await dbg()).cam;
        await p.mouse.move(st.x + st.width * 0.7, y); await p.mouse.down(); await p.mouse.move(st.x + st.width * 0.2, y, { steps: 10 }); await p.mouse.up(); await p.waitForTimeout(800);
        const after = (await dbg()).cam; assert.ok(Math.hypot(after[0] - before[0], after[2] - before[2]) > 1, 'камера не повернулась');
      });
    } else {
      await t('пинч на тачскрине приближает', async () => {
        const st = await p.locator('.v3-stage').boundingBox(), cx = st.x + st.width / 2, cy = st.y + st.height * 0.45, d0 = (await dbg()).dist;
        const cdp = await ctx.newCDPSession(p);
        const tp = (dx) => [{ x: cx - dx, y: cy, id: 1 }, { x: cx + dx, y: cy, id: 2 }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(30) });
        for (let i = 1; i <= 10; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(30 + i * 12) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await p.waitForTimeout(900);
        const d1 = (await dbg()).dist; assert.ok(d1 < d0 - 0.3 && d1 >= 3.59, d0 + ' → ' + d1);
      });
    }
    await t('«Записаться с этими услугами» переносит выбор в форму записи', async () => {
      await p.click('.v3-book'); await p.waitForTimeout(600);
      const sel = await p.$$eval('#svcList input:checked', (a) => a.map((x) => x.value).sort());
      const want = await p.$$eval('.v3-services input:checked', (a) => a.map((x) => x.value).sort());
      assert.deepStrictEqual(sel, want);
    });
    if (shots) { await p.locator('#viewer3d').scrollIntoViewIfNeeded(); await p.waitForTimeout(400); await p.locator('#viewer3d').screenshot({ path: `${shots}/${vp.n}-section.png` }); }
    await t('нет ошибок JavaScript', async () => assert.deepStrictEqual(errs, []));
    await ctx.close();
  }
  await browser.close();
  console.log(`\nИтого 3D: ${pass} пройдено, ${fail} с ошибкой`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
