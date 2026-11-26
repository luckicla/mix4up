'use strict';
// Pestañas dentro de Mix4Up, como en el navegador: clic con la rueda del ratón
// (o Ctrl + clic) en un vídeo, un canal o una lista, o ⋮ → «Abrir en una
// pestaña nueva», y se abre en otra pestaña sin dejar lo que estabas viendo.
// La barra de pestañas solo aparece cuando hay más de una. Cada pestaña
// recuerda dónde estaba (la página y hasta dónde habías bajado).

const Tabs = (() => {
  const { h, icon, $, toast, store, on, ANDROID } = M4;
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const here = () => location.hash || '#/';

  let tabs = store.get('tabs', null);
  if (!Array.isArray(tabs) || !tabs.length || !tabs.every(t => t && t.id && t.hash)) tabs = [{ id: newId(), hash: here(), title: '' }];
  let active = store.get('tabActive', '');
  if (!tabs.some(t => t.id === active)) active = tabs[0].id;
  cur().hash = here(); // al abrir la app, la pestaña elegida es donde estás
  let pendingScroll = null;

  function cur() { return tabs.find(t => t.id === active) || tabs[0]; }
  function save() { store.set('tabs', tabs.map(({ id, hash, title }) => ({ id, hash, title }))); store.set('tabActive', active); }

  const NAMES = { '/': 'Inicio', '/subs': 'Suscripciones', '/local': 'Mis vídeos', '/history': 'Historial', '/later': 'Ver más tarde', '/likes': 'Me gusta',
    '/lists': 'Listas', '/downloads': 'Descargas', '/settings': 'Ajustes', '/library': 'Tú', '/cola': 'Tu cola' };
  const ICONS = { '/': 'home', '/subs': 'subs', '/local': 'folder', '/history': 'history', '/later': 'later', '/likes': 'like', '/lists': 'list',
    '/downloads': 'download', '/settings': 'gear', '/library': 'user', '/cola': 'queue', '/search': 'search', '/watch': 'play', '/playlist': 'list' };
  const pathOf = hash => hash.replace(/^#/, '').split('?')[0] || '/';
  function guessTitle(hash) {
    const p = pathOf(hash), q = new URLSearchParams(hash.split('?')[1] || '');
    if (p === '/search') return 'Buscar: ' + (q.get('q') || '');
    if (p === '/watch') return 'Vídeo';
    if (p.startsWith('/channel/')) return 'Canal';
    if (p === '/playlist' || p.startsWith('/list/')) return 'Lista';
    return NAMES[p] || 'Mix4Up';
  }
  const iconFor = hash => { const p = pathOf(hash); return ICONS[p] || (p.startsWith('/channel/') ? 'user' : p.startsWith('/list/') ? 'list' : 'film'); };

  /* ---------- la barra ---------- */
  const bar = h('div', { id: 'apptabs', hidden: true, role: 'tablist', 'aria-label': 'Pestañas' });
  $('#main').prepend(bar);
  function paint() {
    const many = tabs.length > 1;
    bar.hidden = !many;
    document.body.classList.toggle('has-tabs', many);
    if (!many) { bar.replaceChildren(); return; }
    bar.replaceChildren(...tabs.map(t => {
      const el = h('div.atab' + (t.id === active ? '.on' : ''), { role: 'tab', title: t.title || guessTitle(t.hash), 'aria-selected': t.id === active ? 'true' : 'false',
        onclick: () => activate(t.id),
        onauxclick: e => { if (e.button === 1) { e.preventDefault(); close(t.id); } },
        onmousedown: e => { if (e.button === 1) e.preventDefault(); } },
        icon(iconFor(t.hash)), h('span', null, t.title || guessTitle(t.hash)),
        h('button.ax', { 'aria-label': 'Cerrar pestaña', title: 'Cerrar pestaña', onclick: e => { e.stopPropagation(); close(t.id); } }, icon('close')));
      return el;
    }), h('button.anew', { 'aria-label': 'Pestaña nueva', title: 'Pestaña nueva', onclick: () => open('#/', 'Inicio', { focus: true, quiet: true }) }, icon('addtab')));
    const on1 = bar.querySelector('.atab.on');
    if (on1) on1.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ---------- abrir, cambiar, cerrar ---------- */
  function open(hash, title, opts = {}) {
    if (!hash || !hash.startsWith('#/')) return;
    const t = { id: newId(), hash, title: title || '' };
    tabs.splice(tabs.indexOf(cur()) + 1, 0, t);
    M4.haptic('tick');
    if (opts.focus) activate(t.id);
    else {
      save(); paint();
      if (!opts.quiet) toast('Abierto en una pestaña nueva', { action: 'Ir', fn: () => activate(t.id) });
    }
    return t.id;
  }
  function activate(id) {
    const t = tabs.find(x => x.id === id);
    if (!t) return;
    if (id !== active) {
      cur().scroll = $('#main').scrollTop;
      active = id;
      pendingScroll = t.scroll || 0;
    }
    save(); paint();
    if (here() !== t.hash) location.hash = t.hash; else M4.render();
  }
  function close(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0 || tabs.length < 2) return;
    tabs.splice(i, 1);
    if (id === active) {
      active = '';
      activate((tabs[i] || tabs[i - 1]).id);
    } else { save(); paint(); }
  }

  /* ---------- la pestaña elegida sigue lo que haces ---------- */
  on('route', () => {
    const t = cur();
    if (t.hash !== here()) { t.hash = here(); t.title = ''; t.scroll = 0; }
    if (!t.title) t.title = guessTitle(t.hash);
    save(); paint();
  });
  // ya pintada: el nombre de verdad (el del vídeo, el canal…) y volver a donde habías bajado
  on('rendered', () => {
    const t = cur();
    const name = () => {
      const v = $('#view');
      const tt = (v && (v.querySelector('.vtitle') || v.querySelector('h1'))) || null;
      const txt = tt && tt.textContent.trim();
      if (txt && txt !== 'Tú' && cur() === t && t.title !== txt) { t.title = txt; save(); paint(); }
    };
    name(); setTimeout(name, 1200);
    if (pendingScroll != null) {
      const want = pendingScroll; pendingScroll = null;
      let n = 0;
      const tryScroll = () => {
        const m = $('#main');
        m.scrollTop = want;
        if (Math.abs(m.scrollTop - want) > 4 && n++ < 15) setTimeout(tryScroll, 120); // (lo de abajo aún se está cargando)
      };
      if (want) requestAnimationFrame(tryScroll);
    }
  });
  on('player:info', inf => {
    const t = cur();
    if (pathOf(t.hash) === '/watch' && inf && inf.title) { t.title = inf.title; save(); paint(); }
  });

  /* ---------- clic con la rueda (o Ctrl + clic) en un enlace de dentro ---------- */
  function linkOf(e) {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || el.closest('#apptabs, #tabs, #side, .pop')) return null;
    const a = el.closest('a[href^="#/"]');
    const card = el.closest('.card, .chan-card');
    if (!a && !card) return null;
    const href = (a && a.getAttribute('href')) || (card.querySelector('a.thumb[href^="#/"], a[href^="#/"]') || {}).getAttribute?.('href');
    if (!href) return null;
    const title = (card && card.querySelector('h3') && card.querySelector('h3').textContent.trim()) || (a && (a.title || a.textContent.trim())) || '';
    return { href, title: title.slice(0, 120) };
  }
  document.addEventListener('mousedown', e => { if (e.button === 1 && linkOf(e)) e.preventDefault(); }, true); // (sin la flecha de desplazar)
  document.addEventListener('auxclick', e => {
    if (e.button !== 1) return;
    const l = linkOf(e);
    if (!l) return;
    e.preventDefault(); e.stopPropagation();
    open(l.href, l.title);
  }, true);
  document.addEventListener('click', e => {
    if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return;
    const l = linkOf(e);
    if (!l) return;
    e.preventDefault(); e.stopPropagation();
    open(l.href, l.title);
  }, true);
  // Ctrl+Tab / Ctrl+Mayús+Tab: a la pestaña siguiente / anterior
  document.addEventListener('keydown', e => {
    if (!e.ctrlKey || e.key !== 'Tab' || tabs.length < 2) return;
    e.preventDefault();
    const i = tabs.indexOf(cur());
    activate(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id);
  });

  paint();
  return { open, activate, close, list: () => tabs.slice(), count: () => tabs.length };
})();
