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

  // la pastilla de la pestaña elegida se desliza de una a otra
  const tabInd = h('i.tabind');
  $('#tabs').prepend(tabInd);
  let tabX = null;
  function moveTabInd(instant) {
    const on = $('#tabs a.on');
    if (!on || !$('#tabs').offsetWidth) { tabInd.style.opacity = '0'; return; }
    const x = on.offsetLeft + on.offsetWidth / 2;
    // la pastilla, centrada justo detrás del icono (con cualquier estilo de barra: flotante, mini, clásica…)
    const ic = on.querySelector('svg, img');
    if (ic) {
      const tb = $('#tabs'), r = ic.getBoundingClientRect(), t = tb.getBoundingClientRect();
      const mid = r.top - t.top - tb.clientTop + r.height / 2;
      tabInd.style.top = Math.round(mid - tabInd.offsetHeight / 2) + 'px';
    }
    tabInd.style.opacity = '1';
    tabInd.style.transform = `translateX(${x}px) translateX(-50%)`;
    // de una pestaña a otra: la pastilla se estira hacia donde va y luego se recoge (como una gota)
    if (!instant && tabX != null && tabX !== x && tabInd.animate) {
      const w = tabInd.offsetWidth, d = x - tabX, mid = tabX + d * 0.5, stretch = 1 + Math.min(1.6, Math.abs(d) / w * 0.55);
      tabInd.animate([
        { transform: `translateX(${tabX}px) translateX(-50%) scaleX(1)` },
        { transform: `translateX(${mid}px) translateX(-50%) scaleX(${stretch}) scaleY(.86)`, offset: 0.45 },
        { transform: `translateX(${x + d * 0.04}px) translateX(-50%) scaleX(.92) scaleY(1.06)`, offset: 0.8 },
        { transform: `translateX(${x}px) translateX(-50%) scaleX(1)` },
      ], { duration: 420, easing: 'cubic-bezier(.3,.7,.3,1)' });
    }
    tabX = x;
  }
  let tabFirst = true;
  addEventListener('resize', () => moveTabInd(true));
  // al cambiar el estilo de la barra en Ajustes, la pastilla se recoloca
  M4.on('settings', p => { if ('navStyle' in p) setTimeout(() => moveTabInd(true), 60); });
  M4.on('route', r => {
    setTimeout(() => { moveTabInd(tabFirst); tabFirst = false; }, 0);
    toggleSide(false);
    M4.closePop();
    const sec = r.path === '/' ? 'home' : r.path.slice(1).split('/')[0];
    $$('[data-nav]').forEach(a => a.classList.toggle('on', a.dataset.nav === sec || (sec === 'history' || sec === 'cola' || sec === 'later' || sec === 'likes' || sec === 'lists' || sec === 'downloads') && a.dataset.nav === 'library' && innerWidth <= 760));
    if (r.path !== '/watch') {
      document.body.classList.remove('watching');
      document.title = 'Mix4Up';
      showMini();
    }
    document.body.classList.remove('searching');
    if (searchClose) { searchClose(); searchClose = null; }
    // en el móvil, en los resultados: arriba sale lo que has buscado (como YouTube)
    document.body.classList.toggle('insearch', r.path === '/search');
    if (r.path !== '/search') $('#q').value = '';
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
    remember(v);
    go('/search?q=' + encodeURIComponent(v));
  };
  // lo último que has buscado (sale al tocar el buscador, antes de escribir)
  const recent = () => M4.store.get('recentQ', []);
  function remember(v) { M4.store.set('recentQ', [v, ...recent().filter(x => x.toLowerCase() !== v.toLowerCase())].slice(0, 12)); }
  function showRecent() {
    const list = recent();
    if (q.value.trim() || !list.length) { if (!q.value.trim()) sug.hidden = true; return; }
    sel = -1;
    sug.replaceChildren(...list.map(s => h('button.rec', { type: 'button', onmousedown: e => e.preventDefault(), onclick: () => { q.value = s; $('#searchForm').requestSubmit(); } },
      icon('history'), h('span', null, s),
      h('i.del', { title: 'Quitar', onmousedown: e => e.preventDefault(), onclick: e => { e.stopPropagation(); M4.store.set('recentQ', recent().filter(x => x !== s)); showRecent(); } }, icon('close')))));
    sug.hidden = false;
  }
  q.addEventListener('focus', () => {
    // en el móvil, tocar la búsqueda de arriba (en los resultados) la abre a pantalla completa
    if (innerWidth <= 760 && !document.body.classList.contains('searching')) openSearch(false);
    if (!q.value.trim()) showRecent();
  });
  q.addEventListener('input', () => {
    clearTimeout(sugT);
    const v = q.value.trim();
    if (!v) { showRecent(); return; }
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
  q.addEventListener('blur', () => setTimeout(() => { if (!document.body.classList.contains('searching')) sug.hidden = true; }, 150));
  let searchClose = null;
  function openSearch(focus) {
    document.body.classList.add('searching');
    if (!searchClose) searchClose = M4.pushClose(closeSearch);
    if (focus) setTimeout(() => { q.focus(); q.select(); }, 30);
  }
  $('#btnSearchM').onclick = () => openSearch(true);
  function closeSearch() {
    document.body.classList.remove('searching'); sug.hidden = true;
    if (searchClose) { searchClose(); searchClose = null; }
    // (en los resultados vuelve a salir lo que habías buscado)
    if (document.body.classList.contains('insearch')) q.value = new URLSearchParams(location.hash.split('?')[1] || '').get('q') || q.value;
    q.blur();
  }
  // la flecha: cierra la búsqueda; en los resultados, vuelve a donde estabas
  $('#searchBack').onclick = () => {
    if (document.body.classList.contains('searching')) closeSearch();
    else if (history.length > 1) history.back(); else go('/');
  };
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); q.select(); }
    if (e.key === 'Escape') M4.closeTop();
  });

  /* ---------- la cuenta ---------- */
  // con la cuenta conectada, tu foto de perfil (en la barra de arriba y en «Tú»)
  function paintFace(me) {
    const b = $('#btnAccount'), tab = $('#tabs a[data-nav="library"]');
    const face = cls => { const i = h('img.face' + (cls ? '.' + cls : ''), { src: me.photo, alt: '', referrerpolicy: 'no-referrer' }); i.onerror = () => { YT.forgetMe(); paintFace(null); }; return i; };
    if (me && me.photo) {
      b.replaceChildren(face()); b.classList.add('hasface');
      b.title = (me.name || 'Tu cuenta') + (me.handle ? ' · ' + me.handle : '');
      tab.replaceChildren(face('tface'), h('span', null, 'Tú'));
    } else {
      b.replaceChildren(icon('user')); b.classList.remove('hasface');
      tab.replaceChildren(icon('user'), h('span', null, 'Tú'));
    }
  }
  async function paintAccount() {
    const c = await YT.account();
    const b = $('#btnAccount');
    b.classList.toggle('on', !!c.connected);
    b.title = c.connected ? 'Cuenta de YouTube conectada' : 'Conectar con YouTube';
    if (!c.connected) { paintFace(null); return; }
    paintFace(YT.meCached());
  }
  M4.on('me', me => { if (YT.connected()) paintFace(me); });
  $('#btnAccount').onclick = async () => {
    const c = await YT.getCfg();
    const me = YT.meCached();
    M4.popMenu($('#btnAccount'), c.connected
      ? [{ icon: 'user', label: me && me.name ? me.name + (me.handle ? ' · ' + me.handle : '') : 'Cuenta conectada', fn: () => go('/library') }, { icon: 'refresh', label: 'Volver a conectar', fn: SettingsPage.connect }, '-', { icon: 'gear', label: 'Ajustes', fn: () => go('/settings') }, { icon: 'close', label: 'Desconectar', fn: SettingsPage.disconnect }]
      : [{ icon: 'user', label: 'Conectar con YouTube', fn: SettingsPage.connect }, '-', { icon: 'palette', label: 'Aspecto', fn: () => go('/settings') }, { icon: 'gear', label: 'Ajustes', fn: () => go('/settings') }]);
  };
  M4.on('account', () => { YT.forgetMe(); paintAccount(); Views.sideSubs(); });

  /* ---------- mini reproductor ---------- */
  const mini = $('#mini');
  const miniHost = h('div.playhost');
  const miniTitle = h('b'), miniSub = h('small');
  const miniPlay = h('button.ib', { 'aria-label': 'Pausar', onclick: e => { e.stopPropagation(); Player.toggle(); paintMini(); } }, icon('pause'));
  // la barra del tiempo, fina y a lo ancho abajo del todo (la grande no sale aquí: molesta)
  const miniProg = h('div.mprog', null, h('i'));
  const closeMini = () => { Player.close(); mini.hidden = true; mini.style.transform = ''; mini.style.opacity = ''; };
  mini.append(miniHost, h('div.mbar', null, h('div.t', { onclick: () => expand() }, miniTitle, miniSub), miniPlay,
    h('button.ib', { 'aria-label': 'Cerrar', onclick: e => { e.stopPropagation(); closeMini(); } }, icon('close'))), miniProg);
  const paintProg = () => { if (mini.hidden) return; const d = Player.duration; miniProg.firstChild.style.width = (d ? Math.min(100, Player.time / d * 100) : 0) + '%'; };
  for (const m of [Player.video, Player.audio]) m.addEventListener('timeupdate', paintProg);
  // deslizar el mini reproductor a un lado: se cierra (como YouTube)
  let mx0 = null, mdx = 0;
  mini.addEventListener('touchstart', e => { if (e.target.closest('button')) { mx0 = null; return; } mx0 = e.touches[0].clientX; mdx = 0; mini.style.transition = 'none'; }, { passive: true });
  mini.addEventListener('touchmove', e => { if (mx0 == null) return; mdx = e.touches[0].clientX - mx0; if (Math.abs(mdx) > 8) { mini.style.transform = `translateX(${mdx}px)`; mini.style.opacity = String(1 - Math.min(.8, Math.abs(mdx) / innerWidth)); } }, { passive: true });
  mini.addEventListener('touchend', () => {
    if (mx0 == null) return;
    mx0 = null; mini.style.transition = 'transform .2s ease, opacity .2s';
    if (Math.abs(mdx) > innerWidth * 0.3) { mini.style.transform = `translateX(${mdx > 0 ? innerWidth : -innerWidth}px)`; mini.style.opacity = '0'; M4.haptic('tick'); setTimeout(() => { mini.style.transition = ''; closeMini(); }, 200); }
    else { mini.style.transform = ''; mini.style.opacity = ''; setTimeout(() => { mini.style.transition = ''; }, 220); }
  }, { passive: true });
  function showMini() {
    if (!Player.item) { mini.hidden = true; return; }
    Player.mount(miniHost);
    mini.hidden = false;
    paintMini(); paintProg();
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

  // recién actualizada: avisar (y en el móvil, además, llega una notificación)
  function updatedNotice(ver) {
    if (!ver) return;
    const short = ver.split('.').slice(0, 3).join('.'), seen = M4.store.get('seenVer');
    M4.store.set('seenVer', short);
    if (seen && seen !== short) setTimeout(() => toast('Mix4Up se ha actualizado a la versión ' + short, { ms: 6000 }), 1500);
  }
  // deslizar el vídeo hacia abajo: se hace pequeño (y sigue sonando)
  // (vuelve a la última página que no era un vídeo, nunca al vídeo anterior)
  let lastPage = '/';
  const seen = [];
  M4.on('route', r => { seen.push(r.raw); if (seen.length > 50) seen.shift(); if (r.path !== '/watch') lastPage = r.raw; });
  M4.on('player:minimize', () => {
    const before = seen[seen.length - 2];
    if (before && before === lastPage && history.length > 1) history.back();
    else go(lastPage || '/');
  });

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
  // (viendo un vídeo, la barra de arriba del móvil en negro, como el vídeo)
  M4.on('route', () => setTimeout(M4.barsFor, 30));
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
  // menús de cada cosa: clic derecho en el PC, mantener pulsado en el móvil
  // (vídeos, listas, canales, el mini reproductor y el propio vídeo)
  function menuFor(t) {
    for (let x = t; x && x !== document.body; x = x.parentElement) {
      if (x._menu) return x._menu;
      if (x.matches && x.matches('a[href^="#/channel/"]') && !x.closest('.card')) {
        const id = decodeURIComponent(x.getAttribute('href').slice(10).split(/[/?]/)[0]);
        return a => Views.channelMenu(id, (x.textContent || '').trim().slice(0, 40), a);
      }
    }
    return null;
  }
  mini._menu = a => M4.popMenu(a, [{ icon: 'expand', label: 'Ver en grande', fn: expand }, { icon: Player.playing ? 'pause' : 'play', label: Player.playing ? 'Pausar' : 'Seguir viendo', fn: () => { Player.toggle(); paintMini(); } },
    { icon: 'next', label: 'Siguiente', fn: () => Player.next() }, '-', { icon: 'close', label: 'Cerrar', fn: closeMini }]);
  let lastTouchAt = 0;
  document.addEventListener('contextmenu', e => {
    if (e.target.closest('input,textarea,[contenteditable]')) return;
    // el vídeo: su propio menú (calidad, velocidad, temporizador…)
    if (e.target.closest('.player') && !e.target.closest('#mini')) {
      e.preventDefault();
      if (Date.now() - lastTouchAt > 1000 && Player.item) Player.openMenu('main');
      return;
    }
    const fn = menuFor(e.target);
    if (!fn) return;
    e.preventDefault();
    if (Date.now() - lastTouchAt < 1000) return; // en el móvil ya se encarga «mantener pulsado»
    fn({ x: e.clientX, y: e.clientY });
  });
  let lpT = 0, lpX = 0, lpY = 0, lpFired = false, lpEl = null, lpAt = 0;
  document.addEventListener('touchstart', e => {
    lastTouchAt = Date.now();
    lpFired = false;
    clearTimeout(lpT);
    if (e.touches.length > 1 || (e.target.closest('.player') && !e.target.closest('#mini')) || e.target.closest('button:not(.more),input,.chips,.mprog')) return;
    const fn = menuFor(e.target);
    if (!fn) return;
    const t = e.touches[0]; lpX = t.clientX; lpY = t.clientY;
    lpEl = e.target.closest('.card,.chan-card,#mini,a') || e.target;
    lpEl.classList.add('lp-arm');
    lpT = setTimeout(() => { lpFired = true; lpAt = Date.now(); lpEl.classList.remove('lp-arm'); lpEl.classList.add('lp-go'); setTimeout(() => lpEl && lpEl.classList.remove('lp-go'), 300); fn({ x: lpX, y: lpY }); }, 480);
  }, { passive: true });
  const lpCancel = () => { clearTimeout(lpT); if (lpEl) lpEl.classList.remove('lp-arm'); };
  document.addEventListener('touchmove', e => { const t = e.touches[0]; if (Math.abs(t.clientX - lpX) > 10 || Math.abs(t.clientY - lpY) > 10) lpCancel(); }, { passive: true });
  document.addEventListener('touchend', lpCancel, { passive: true });
  document.addEventListener('touchcancel', lpCancel, { passive: true });
  document.addEventListener('click', e => { if (lpFired || Date.now() - lpAt < 700) { e.preventDefault(); e.stopPropagation(); lpFired = false; } }, true);
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
  window.M4bg = on => Player.setBg(on);
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
  // En el Mac los botones de la ventana son los de colores del sistema (a la izquierda): la página no pinta los suyos
  const SH = window.Mix4UpShell;
  const MAC = !!SH && SH.platform === 'darwin';
  if (SH && typeof SH.win === 'function') {
    document.documentElement.classList.add('tb');
    document.documentElement.classList.toggle('tb-mac', MAC);
    $('#wctl').hidden = MAC;
    const paintWin = w => {
      if (!w) return;
      document.documentElement.classList.toggle('tb-max', !!w.max);
      // en pantalla completa del Mac la barra se queda (y sin hueco para los botones, que se esconden)
      document.documentElement.classList.toggle(MAC ? 'tb-macfull' : 'tb-full', !!w.full);
      $('#tbMax').title = w.max ? 'Restaurar' : 'Maximizar';
    };
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
    updatedNotice(info.version);
    await YT.account();
    if (!location.hash || location.hash === '#/') Views.preloadHome();
    // la cuenta sigue guardada pero YouTube ya no la reconoce: avisar (si no, el inicio sale genérico sin saber por qué)
    YT.warm().then(c => {
      if (c && c.connected && c.ok && c.loggedIn === false) toast('YouTube ha cerrado tu sesión en este aparato. Vuelve a conectar tu cuenta para ver tus recomendaciones.', { action: 'Conectar', fn: SettingsPage.connect, ms: 12000 });
    }).catch(() => {});
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
