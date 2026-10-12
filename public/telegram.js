/* Garage Detailing — интеграция с Telegram Mini App.
   В обычном браузере ничего не делает; внутри Telegram подстраивает сайт под приложение. */
(function () {
  'use strict';
  var tg = window.Telegram && window.Telegram.WebApp;
  window.tgInitData = '';
  if (!tg || !tg.initData) return;                 // открыто не из Telegram
  window.tgInitData = tg.initData;
  var root = document.documentElement;
  root.classList.add('tg-app');
  var BG = '#07070c';
  var v = function (min) { return tg.isVersionAtLeast && tg.isVersionAtLeast(min); };
  try {
    tg.ready();
    tg.expand();
    if (v('6.1')) { tg.setHeaderColor(BG); tg.setBackgroundColor(BG); }
    if (v('7.10')) tg.setBottomBarColor(BG);
    if (v('7.7')) tg.disableVerticalSwipes();      // свайп по 3D-модели/слайдерам не закрывает приложение
  } catch (e) {}

  // Отступы под «чёлку» и кнопки Telegram в полноэкранном режиме
  function insets() {
    var s = tg.safeAreaInsets || {}, c = tg.contentSafeAreaInsets || {};
    root.style.setProperty('--tg-top', ((s.top || 0) + (c.top || 0)) + 'px');
    root.style.setProperty('--tg-bottom', ((s.bottom || 0) + (c.bottom || 0)) + 'px');
  }
  insets();
  ['safeAreaChanged', 'contentSafeAreaChanged', 'fullscreenChanged', 'viewportChanged'].forEach(function (e) { try { tg.onEvent(e, insets); } catch (x) {} });

  document.addEventListener('DOMContentLoaded', function () {
    // Имя из профиля Telegram
    var u = tg.initDataUnsafe && tg.initDataUnsafe.user, name = document.getElementById('name');
    if (u && name && !name.value) {
      var n = [u.first_name, u.last_name].filter(Boolean).join(' ').replace(/[^A-Za-zА-Яа-яЁё\-' .]/g, '').trim();
      if (n.length >= 2) name.value = n.slice(0, 50);
    }
    // Внешние ссылки — через Telegram (иначе в WebView могут не открыться)
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      var href = a.getAttribute('href');
      if (/^https?:\/\//i.test(href) && a.host !== location.host) {
        e.preventDefault();
        if (/^https:\/\/t\.me\//i.test(href)) tg.openTelegramLink(href); else tg.openLink(href);
      }
    }, true);
    // Подтверждение закрытия, пока форма заполнена; вибро-отклик
    var form = document.getElementById('form');
    if (form) {
      form.addEventListener('input', function () { try { v('6.2') && tg.enableClosingConfirmation(); } catch (x) {} });
      form.addEventListener('change', function (e) { if (e.target.type === 'checkbox' || e.target.type === 'radio') try { tg.HapticFeedback.selectionChanged(); } catch (x) {} });
    }
  });

  // Регистрация участника (для рассылок), проверка бана и прав администратора
  function hello() {
    fetch('/api/tg/hello', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: tg.initData }) })
      .then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) return;
        if (j.banned) {
          var d = document.createElement('div'); d.className = 'tg-banned';
          d.innerHTML = '<div><b>Доступ ограничен</b><p>Онлайн-запись для вашего аккаунта недоступна.</p><a class="btn" data-phone></a></div>';
          var a = d.querySelector('a'); var c = window.GD_CONFIG && window.GD_CONFIG.business;
          if (c) { a.href = 'tel:' + c.phone; a.textContent = '📞 ' + c.phoneDisplay; } else a.remove();
          document.body.appendChild(d); return;
        }
        if (j.isAdmin && !document.querySelector('.tg-admin-btn')) {
          var b = document.createElement('a'); b.href = '/admin.html'; b.className = 'tg-admin-btn'; b.textContent = '⚙️ Админ';
          document.body.appendChild(b);
        }
        // Разрешение писать в личку — чтобы приходили статусы записи и рассылки
        var u = tg.initDataUnsafe && tg.initDataUnsafe.user;
        if (u && u.allows_write_to_pm === false && v('6.9') && !localStorage.getItem('gd_wa')) {
          localStorage.setItem('gd_wa', '1'); try { tg.requestWriteAccess(); } catch (e) {}
        }
      }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello); else hello();

  window.tgBookingDone = function () {
    try { tg.HapticFeedback.notificationOccurred('success'); v('6.2') && tg.disableClosingConfirmation(); } catch (e) {}
  };
  window.tgBookingFail = function () { try { tg.HapticFeedback.notificationOccurred('error'); } catch (e) {} };
})();
