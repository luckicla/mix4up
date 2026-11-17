'use strict';
// Arranque de Mix4Up y lo que une las piezas: la barra de arriba, el menú,
// la búsqueda, el mini reproductor, el botón «atrás» del móvil…

const App = (() => {
  const { h, icon, $, $$, api, toast, Settings, ANDROID, DESKTOP, go } = M4;

  /* ---------- menú lateral ---------- */
  $('#btnMenu').onclick = () => {
    if (innerWidth <= 760 || document.body.classList.contains('watching')) toggleSide();
    else { document.body.classList.toggle('mini-side'); M4.store.set('miniSide', document.body.classList.contains('mini-side')); }
  };
  let sideClose = null;
  function toggleSide(force) {
    const on = force != null ? force : !document.body.classList.contains('side-open');
    document.body.classList.toggle('side-open', on);
    $('#scrim').hidden = !on;
    if (on) sideClose = M4.pushClose(() => toggleSide(false)); else if (sideClose) { sideClose(); sideClose = null; }
  }
  $('#scrim').onclick = () => toggleSide(false);
  if (M4.store.get('miniSide')) document.body.classList.add('mini-side');
  $('.brand').addEventListener('click', () => toggleSide(false));

  M4.on('route', r => {
    toggleSide(false);
    M4.closePop();
    const sec = r.path === '/' ? 'home' : r.path.slice(1).split('/')[0];
    $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === sec || (sec === 'history' || sec === 'later' || sec === 'likes' || sec === 'lists' || sec === 'downloads') && a.dataset.nav === 'library' && innerWidth <= 760));
    if (r.path !== '/watch') {
      document.body.classList.remove('watching');
      document.title = 'Mix4Up';
      showMini();
    }
    document.body.classList.remove('searching');
    $('#suggest').hidden = true;
  });

  /* ---------- búsqueda (con sugerencias) ---------- */
  const q = $('#q'), sug = $('#suggest');
  let sel = -1, sugT = 0;
  $('#searchForm').onsubmit = e => {
    e.preventDefault();
    const v = q.value.trim();
    if (!v) return;
    q.blur(); sug.hidden = true;
    // un enlace de YouTube pegado: directo al vídeo / canal / lista
    const id = (v.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/) || [])[1];
    if (id) { go('/watch?v=' + id); return; }
    const list = (v.match(/[?&]list=([\w-]+)/) || [])[1];
    if (list) { go('/playlist?list=' + list); return; }
    const ch = (v.match(/youtube\.com\/(@[\w.-]+|channel\/UC[\w-]{22})/) || [])[1];
    if (ch) { go('/channel/' + ch.replace('channel/', '')); return; }
    go('/search?q=' + encodeURIComponent(v));
  };
  q.addEventListener('input', () => {
    clearTimeout(sugT);
    const v = q.value.trim();
    if (!v) { sug.hidden = true; return; }
    sugT = setTimeout(async () => {
      const list = await YT.suggest(v);
      if (q.value.trim() !== v || document.activeElement !== q) return;
      sel = -1;
      sug.replaceChildren(...list.slice(0, 10).map(s => h('button', { type: 'button', onmousedown: e => e.preventDefault(), onclick: () => { q.value = s; $('#searchForm').requestSubmit(); } }, icon('search'), s)));
      sug.hidden = !list.length;
    }, 180);
  });
  q.addEventListener('keydown', e => {
    const bs = $$('button', sug);
    if (sug.hidden || !bs.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length;
      bs.forEach((b, i) => b.classList.toggle('sel', i === sel));
      q.value = bs[sel].textContent;
    } else if (e.key === 'Escape') sug.hidden = true;
  });
  q.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 150));
  $('#btnSearchM').onclick = () => { document.body.classList.add('searching'); setTimeout(() => q.focus(), 30); searchClose = M4.pushClose(closeSearch); };
  let searchClose = null;
  const closeSearch = () => { document.body.classList.remove('searching'); if (searchClose) { searchClose(); searchClose = null; } };
  $('#searchBack').onclick = closeSearch;
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); q.select(); }
    if (e.key === 'Escape') M4.closeTop();
  });

  /* ---------- la cuenta ---------- */
  async function paintAccount() {
    const c = await YT.account();
    const b = $('#btnAccount');
    b.classList.toggle('on', !!c.connected);
    b.title = c.connected ? 'Cuenta de YouTube conectada' : 'Conectar con YouTube';
  }
  $('#btnAccount').onclick = async () => {
    const c = await YT.getCfg();
    M4.popMenu($('#btnAccount'), c.connected
      ? [{ icon: 'user', label: 'Cuenta conectada', fn: () => go('/settings') }, { icon: 'refresh', label: 'Volver a conectar', fn: SettingsPage.connect }, '-', { icon: 'gear', label: 'Ajustes', fn: () => go('/settings') }, { icon: 'close', label: 'Desconectar', fn: SettingsPage.disconnect }]
      : [{ icon: 'user', label: 'Conectar con YouTube', fn: SettingsPage.connect }, '-', { icon: 'palette', label: 'Aspecto', fn: () => go('/settings') }, { icon: 'gear', label: 'Ajustes', fn: () => go('/settings') }]);
  };
  M4.on('account', () => { paintAccount(); Views.sideSubs(); });

  /* ---------- mini reproductor ---------- */
  const mini = $('#mini');
  const miniHost = h('div.playhost');
  const miniTitle = h('b'), miniSub = h('small');
  const miniPlay = h('button.ib', { 'aria-label': 'Pausar', onclick: e => { e.stopPropagation(); Player.toggle(); paintMini(); } }, icon('pause'));
  mini.append(miniHost, h('div.mbar', null, h('div.t', { onclick: () => expand() }, miniTitle, miniSub), miniPlay,
    h('button.ib', { 'aria-label': 'Cerrar', onclick: e => { e.stopPropagation(); Player.close(); mini.hidden = true; } }, icon('close'))));
  function showMini() {
    if (!Player.item) { mini.hidden = true; return; }
    Player.mount(miniHost);
    mini.hidden = false;
    paintMini();
  }
  function paintMini() {
    const it = Player.item;
    if (!it) return;
    miniTitle.textContent = it.title || '';
    miniSub.textContent = it.channel || '';
    miniPlay.replaceChildren(icon(Player.playing ? 'pause' : 'play'));
  }
  function expand() {
    const it = Player.item;
    if (!it) return;
    if (it.src === 'local' && !it._yt) go(it.remote ? '/watch?pc=' + encodeURIComponent(it.lid) : '/watch?lid=' + encodeURIComponent(it.lid));
    else go('/watch?v=' + (it._yt || it.id));
  }
  M4.on('player:expand', expand);
  Player.video.addEventListener('play', paintMini); Player.video.addEventListener('pause', paintMini);
  Player.audio.addEventListener('play', paintMini); Player.audio.addEventListener('pause', paintMini);

  // deslizar el vídeo hacia abajo: se hace pequeño (y sigue sonando)
  M4.on('player:minimize', () => { if (history.length > 1) history.back(); else go('/'); });

  // en el móvil, como YouTube: la barra de arriba se esconde al bajar y vuelve al subir
  let lastY = 0;
  $('#main').addEventListener('scroll', () => {
    const y = $('#main').scrollTop;
    if (innerWidth > 760) return;
    if (y > lastY + 6 && y > 120) document.body.classList.add('top-hidden');
    else if (y < lastY - 6 || y < 60) document.body.classList.remove('top-hidden');
    lastY = y;
  }, { passive: true });
  M4.on('route', () => document.body.classList.remove('top-hidden'));
  // el móvil sabe si estás viendo un vídeo: al salir con «inicio», ventanita (como YouTube)
  const tellWatching = () => { if (!ANDROID) return; try { Mix4UpAndroid.setWatching(location.hash.startsWith('#/watch') && Settings.get().autoPip !== false); } catch {} };
  M4.on('route', tellWatching); M4.on('watching', tellWatching);

  /* ---------- gestos y vibración del móvil ---------- */
  // tocar la pestaña en la que ya estás: arriba del todo (y otra vez: refrescar)
  $$('#tabs a').forEach(a => a.addEventListener('click', e => {
    M4.haptic('tap');
    if (a.classList.contains('on')) {
      e.preventDefault();
      if ($('#main').scrollTop > 10) $('#main').scrollTo({ top: 0, behavior: 'smooth' }); else M4.render();
    }
  }));
  // mantener pulsado un vídeo: su menú
  let lpT = 0, lpX = 0, lpY = 0, lpFired = false;
  document.addEventListener('touchstart', e => {
    const c = e.target.closest('#view .card, #mini');
    lpFired = false;
    if (!c || c.id === 'mini' || e.target.closest('.player')) return;
    const t = e.touches[0]; lpX = t.clientX; lpY = t.clientY;
    clearTimeout(lpT);
    lpT = setTimeout(() => { const m = c.querySelector('.more'); if (m) { lpFired = true; m.click(); } }, 520);
  }, { passive: true });
  document.addEventListener('touchmove', e => { const t = e.touches[0]; if (Math.abs(t.clientX - lpX) > 10 || Math.abs(t.clientY - lpY) > 10) clearTimeout(lpT); }, { passive: true });
  document.addEventListener('touchend', () => clearTimeout(lpT), { passive: true });
  document.addEventListener('click', e => { if (lpFired && e.target.closest('#view .card')) { e.preventDefault(); e.stopPropagation(); lpFired = false; } }, true);
  document.addEventListener('contextmenu', e => { if (e.target.closest('#view .card')) e.preventDefault(); });
  // tirar hacia abajo para refrescar (inicio, suscripciones, mis vídeos…)
  const ptr = h('div.ptr', null, icon('refresh'));
  document.body.append(ptr);
  let pY = null, pD = 0;
  const main = $('#main');
  main.addEventListener('touchstart', e => { if (main.scrollTop <= 0 && !document.body.classList.contains('watching') && !e.target.closest('.chips,.hscroll,.subrow')) pY = e.touches[0].clientY; else pY = null; pD = 0; }, { passive: true });
  main.addEventListener('touchmove', e => {
    if (pY == null) return;
    pD = Math.max(0, e.touches[0].clientY - pY);
    if (main.scrollTop > 0) { pY = null; return; }
    const k = Math.min(1, pD / 110);
    ptr.style.opacity = k; ptr.style.transform = `translateY(${pD * 0.5 - 50}px) rotate(${pD * 2}deg) scale(${0.6 + k * 0.4})`;
    if (pD > 110 && !ptr.dataset.armed) { ptr.dataset.armed = '1'; M4.haptic('tick'); }
  }, { passive: true });
  main.addEventListener('touchend', () => {
    if (pY == null) return;
    pY = null;
    if (pD > 110) {
      ptr.classList.add('go'); M4.haptic('confirm');
      Promise.resolve(M4.render()).finally(() => setTimeout(() => { ptr.classList.remove('go'); ptr.style.opacity = 0; ptr.style.transform = ''; }, 400));
    } else { ptr.style.opacity = 0; ptr.style.transform = ''; }
    delete ptr.dataset.armed;
  }, { passive: true });

  /* ---------- «atrás» (botón del móvil) ---------- */
  // devuelve true si se ha encargado; false: la app se va al fondo
  window.M4back = () => {
    if (document.body.classList.contains('pip')) return false;
    if (M4.closeTop()) return true;
    if (location.hash && location.hash !== '#/' && history.length > 1) { history.back(); return true; }
    if (location.hash && location.hash !== '#/') { go('/'); return true; }
    return false;
  };
  window.M4remote = cmd => Player.remote(cmd);
  window.M4pip = on => Player.onPip(on);
  // un enlace compartido a Mix4Up desde YouTube (en el móvil)
  window.M4shared = () => {
    let t = '';
    try { t = Mix4UpAndroid.consumeShared(); } catch {}
    if (!t) return;
    q.value = t;
    $('#searchForm').requestSubmit();
  };

  /* ---------- la barra de arriba de la app de escritorio ---------- */
  // (la ventana no lleva la de Windows: flechas, lo que suena, minimizar/maximizar/cerrar)
  const SH = window.Mix4UpShell;
  if (SH && typeof SH.win === 'function') {
    document.documentElement.classList.add('tb');
    $('#wctl').hidden = false;
    const paintWin = w => { if (!w) return; document.documentElement.classList.toggle('tb-max', !!w.max); document.documentElement.classList.toggle('tb-full', !!w.full); $('#tbMax').title = w.max ? 'Restaurar' : 'Maximizar'; };
    SH.win('').then(paintWin).catch(() => {});
    SH.onWin(paintWin);
    $('#tbMin').onclick = () => SH.win('min');
    $('#tbMax').onclick = () => SH.win('max').then(paintWin);
    $('#tbClose').onclick = () => SH.win('close');
    $('#top').addEventListener('dblclick', e => { if (!e.target.closest('button,a,input,form')) SH.win('max').then(paintWin); });
    $('#tbBack').onclick = () => history.back();
    $('#tbFwd').onclick = () => history.forward();
    $('#tbPlay').onclick = () => { Player.toggle(); paintTB(); };
    $('#tbTitle').onclick = () => expand();
  }
  function paintTB() {
    if (!SH || !SH.win) return;
    const it = Player.item;
    $('#tbNow').hidden = !it || document.body.classList.contains('watching');
    if (!it) return;
    $('#tbTitle').textContent = it.title || '';
    $('#tbTitle').title = (it.title || '') + (it.channel ? ' — ' + it.channel : '');
    $('#tbPlay').replaceChildren(icon(Player.playing ? 'pause' : 'play'));
  }
  M4.on('route', () => setTimeout(paintTB, 0));
  M4.on('player:open', paintTB);
  for (const m of [Player.video, Player.audio]) { m.addEventListener('play', paintTB); m.addEventListener('pause', paintTB); }

  /* ---------- vivo ---------- */
  setInterval(() => fetch('/api/ping', { cache: 'no-store' }).catch(() => {}), 20000);
  fetch('/api/ping').catch(() => {});

  // errores de la página: al registro (para las pruebas y para mirar problemas)
  addEventListener('error', e => { try { if (ANDROID) Mix4UpAndroid.diag('error: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno); } catch {} });

  async function boot() {
    await M4.Settings.load();
    await Journal.load();
    M4.emit('ready');
    const info = await api('/api/info').catch(() => ({}));
    $('#verLabel').textContent = info.version ? 'Versión ' + info.version.split('.').slice(0, 3).join('.') : '';
    await YT.account();
    if (!location.hash || location.hash === '#/') Views.preloadHome();
    YT.warm();
    paintAccount();
    Views.sideSubs();
    Sync.start();
    M4.render();
    setTimeout(M4.applyLook, 0);
    if (ANDROID) setTimeout(() => window.M4shared(), 1500);
    // la primera vez: dónde está cada cosa
    if (!M4.store.get('welcomed') && !YT.connected()) {
      M4.store.set('welcomed', 1);
      setTimeout(() => toast('Bienvenido a Mix4Up: YouTube sin Shorts y tus vídeos. Conecta tu cuenta para ver tus recomendaciones.', { action: 'Conectar', fn: SettingsPage.connect, ms: 9000 }), 1200);
    }
    window.M4ready = true;
  }
  boot().catch(e => { console.error(e); M4.failView(e, () => location.reload()); });

  return { toggleSide, showMini, expand };
})();
