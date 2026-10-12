/* Garage Detailing — маршрут до студии в навигатор одним тапом.
   Навигаторы сами строят самый быстрый маршрут от текущего места клиента (с пробками). */
(function () {
  'use strict';
  var btn = document.querySelector('[data-route-open]'), box = document.getElementById('route');
  if (!btn || !box) return;
  var b = (window.GD_CONFIG && GD_CONFIG.business) || {}, g = b.geo || { lat: 54.251868, lon: 48.319854 };
  var lat = g.lat, lon = g.lon;
  var ua = navigator.userAgent, mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));

  var web = {
    yandex: 'https://yandex.ru/maps/?rtext=~' + lat + ',' + lon + '&rtt=auto',
    google: 'https://www.google.com/maps/dir/?api=1&destination=' + lat + ',' + lon + '&travelmode=driving',
    '2gis': 'https://2gis.ru/directions/points/%7C' + lon + '%2C' + lat
  };
  var app = {
    yandex: 'yandexnavi://build_route_on_map?lat_to=' + lat + '&lon_to=' + lon,
    '2gis': 'dgis://2gis.ru/routeSearch/rsType/car/to/' + lon + ',' + lat
  };
  // На компьютере навигатора нет → Яндекс Карты с маршрутом
  if (!mobile) { var l = box.querySelector('[data-yandex-label]'); if (l) l.textContent = 'Яндекс Карты'; }
  box.querySelectorAll('[data-nav]').forEach(function (a) { a.href = web[a.dataset.nav]; });

  var R = window.GDRoute = { go: function (u) { location.href = u; }, web: web, app: app };
  // Открыть приложение; если его нет (страница не ушла в фон за 1.2 с) — веб-версия в той же вкладке
  function openApp(name) {
    var left = false, t;
    function gone() { if (document.hidden) { left = true; clearTimeout(t); } }
    document.addEventListener('visibilitychange', gone);
    t = setTimeout(function () { document.removeEventListener('visibilitychange', gone); if (!left) R.go(web[name]); }, 1200);
    R.go(app[name]);
  }
  box.addEventListener('click', function (e) {
    var a = e.target.closest('[data-nav]'); if (!a) return;
    var name = a.dataset.nav;
    a.classList.add('flash'); setTimeout(function () { a.classList.remove('flash'); }, 500);
    if (mobile && app[name]) { e.preventDefault(); openApp(name); }  // Google Maps по https сам открывает приложение
  });
  btn.addEventListener('click', function (e) {
    e.preventDefault();
    box.hidden = !box.hidden;
    btn.setAttribute('aria-expanded', String(!box.hidden));
    if (!box.hidden) box.querySelector('[data-nav]').focus({ preventScroll: true });
  });
})();
