'use strict';
// Mix4Up — lo básico que usan todas las partes de la página.
// OJO: todos los archivos comparten el mismo espacio global. Cada archivo
// define UN solo nombre global (M4, Journal, YT, Player, Views, SettingsPage,
// Sync, App) y todo lo demás va dentro de su propia función.

const M4 = (() => {
  const ANDROID = !!window.Mix4UpAndroid;
  const DESKTOP = !!window.Mix4UpShell;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /* ---------- eventos ---------- */
  const handlers = {};
  const on = (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); return () => { handlers[ev] = handlers[ev].filter(f => f !== fn); }; };
  const emit = (ev, ...a) => (handlers[ev] || []).slice().forEach(fn => { try { fn(...a); } catch (e) { console.warn('[' + ev + ']', e); } });

  /* ---------- servidor ---------- */
  async function api(path, opts = {}) {
    const o = { cache: 'no-store', ...opts };
    if (o.json !== undefined) { o.body = JSON.stringify(o.json); o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) }; delete o.json; if (!o.method) o.method = 'POST'; }
    const r = await fetch(path, o);
    if (!r.ok) {
      let t = '';
      try { t = (await r.text()).trim(); } catch {}
      const e = new Error(t && t.length < 400 ? t : 'Error ' + r.status);
      e.status = r.status;
      throw e;
    }
    if (r.status === 204) return null;
    const ct = r.headers.get('content-type') || '';
    return ct.includes('json') ? r.json() : r.text();
  }

  /* ---------- ajustes (en la carpeta de datos, no en la página) ---------- */
  const DEFAULTS = {
    theme: 'dark', accent: '#ff2e88', accent2: '#c8ff00', radius: 12, density: 'normal', font: 'system', cardStyle: 'round',
    autoplay: true, quality: 'auto', qualityCap: ANDROID ? 720 : 1080, speed: 1, subs: false, subLang: 'es', subSize: 100,
    strictShorts: true, volume: 1, muted: false, autoUpdate: true, theater: false, resume: true, markWatched: true,
    syncLook: false, gestures: true, haptics: true, navStyle: 'float', navAlpha: 72, homeSource: 'auto', sleepAction: 'pause', bgPlay: true, autoPip: true, fillScreen: true, lookVer: 0,
  };
  let settings = { ...DEFAULTS }, saveT = 0;
  const Settings = {
    async load() {
      try { const s = await api('/api/settings'); settings = { ...DEFAULTS, ...(s || {}) }; } catch {}
      applyLook();
    },
    get: () => settings,
    set(patch, quiet) {
      settings = { ...settings, ...patch };
      clearTimeout(saveT);
      saveT = setTimeout(() => api('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }).catch(() => {}), 400);
      if (!quiet) emit('settings', patch);
    },
    defaults: DEFAULTS,
  };

  /* ---------- aspecto ---------- */
  const FONTS = {
    system: 'system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    rounded: '"Nunito", "Varela Round", "Segoe UI", system-ui, sans-serif',
    serif: 'Georgia, "Times New Roman", serif',
    mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    narrow: '"Arial Narrow", "Roboto Condensed", "Segoe UI", sans-serif',
  };
  // las miniaturas crecen con la ventana (en pantalla grande caben más y más grandes)
  const CARDW = { compact: 'clamp(200px, 9vw + 60px, 300px)', normal: 'clamp(250px, 11vw + 90px, 400px)', big: 'clamp(320px, 15vw + 110px, 540px)' };
  function contrastText(hex) {
    const n = parseInt(String(hex).replace('#', '').padEnd(6, '0').slice(0, 6), 16);
    const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111' : '#fff';
  }
  function applyLook() {
    const s = settings, d = document.documentElement;
    d.dataset.theme = s.theme;
    d.dataset.nav = s.navStyle || 'float';
    const vars = {
      '--acc': s.accent, '--acc2': s.accent2, '--accfg': contrastText(s.accent),
      '--r': (+s.radius || 0) + 'px', '--navA': Math.max(20, Math.min(100, +s.navAlpha || 72)) + '%', '--cardw': CARDW[s.density] || CARDW.normal, '--font': FONTS[s.font] || FONTS.system,
    };
    const css = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    d.setAttribute('style', css);
    try { localStorage.setItem('m4.look', JSON.stringify({ css, theme: s.theme, nav: s.navStyle || 'float' })); } catch {}
    if (ANDROID) try { Mix4UpAndroid.setBars(getComputedStyle(d).getPropertyValue('--bg').trim() || '#0f0f13', s.theme === 'light'); } catch {}
  }
  on('settings', p => { if (['theme', 'accent', 'accent2', 'radius', 'density', 'font', 'navStyle', 'navAlpha'].some(k => k in p)) applyLook(); });

  /* ---------- vibración (en el móvil) ---------- */
  // tap: un toque corto · tick: muy suave (al deslizar) · long: pulsación larga · confirm: hecho · reject: no se puede
  let lastHap = 0;
  function haptic(kind = 'tap') {
    if (!ANDROID || settings.haptics === false) return;
    const now = Date.now();
    if (kind === 'tick' && now - lastHap < 40) return;
    lastHap = now;
    try { window.Mix4UpAndroid.haptic(kind); } catch {}
  }

  /* ---------- crear elementos ---------- */
  function h(tag, attrs, ...kids) {
    const [t, ...cls] = tag.split('.');
    const el = document.createElement(t || 'div');
    if (cls.length) el.className = cls.join(' ');
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
    return el;
  }
  const icon = (name, cls) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); if (cls) s.setAttribute('class', cls); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#i-' + name); s.append(u); return s; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- formatos ---------- */
  function dur(s) {
    s = Math.max(0, Math.floor(+s || 0));
    const hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
    return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0');
  }
  function parseDur(t) { // "1:02:03" → s
    if (!t) return 0;
    const p = String(t).trim().split(':').map(Number);
    if (p.some(isNaN)) return 0;
    return p.reduce((a, b) => a * 60 + b, 0);
  }
  function views(n) {
    n = +n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace('.', ',').replace(',0', '') + ' mil M visualizaciones';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',').replace(',0', '') + ' M visualizaciones';
    if (n >= 1e3) return Math.round(n / 1e3) + ' mil visualizaciones';
    return n + ' visualizaciones';
  }
  function ago(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'ahora mismo';
    if (s < 3600) return 'hace ' + Math.floor(s / 60) + ' min';
    if (s < 86400) return 'hace ' + Math.floor(s / 3600) + ' h';
    if (s < 86400 * 30) { const d = Math.floor(s / 86400); return 'hace ' + d + (d === 1 ? ' día' : ' días'); }
    if (s < 86400 * 365) { const m = Math.floor(s / 86400 / 30); return 'hace ' + m + (m === 1 ? ' mes' : ' meses'); }
    const y = Math.floor(s / 86400 / 365); return 'hace ' + y + (y === 1 ? ' año' : ' años');
  }

  /* ---------- avisos ---------- */
  function toast(msg, opts = {}) {
    const box = $('#toasts');
    const t = h('div.toast', null, h('span', null, msg));
    if (opts.action) t.append(h('button', { onclick: () => { t.remove(); opts.fn && opts.fn(); } }, opts.action));
    box.append(t);
    while (box.children.length > 3) box.firstChild.remove();
    setTimeout(() => t.remove(), opts.ms || (opts.action ? 6000 : 3200));
    return t;
  }

  /* ---------- ventanas ---------- */
  const layer = () => $('#layer');
  function modal(build, { onClose } = {}) {
    const m = h('div.modal');
    const box = h('div.box');
    m.append(box);
    const close = v => { m.remove(); stack = stack.filter(x => x !== close); onClose && onClose(v); };
    m.addEventListener('pointerdown', e => { if (e.target === m) close(); });
    build(box, close);
    layer().append(m);
    stack.push(close);
    const f = box.querySelector('input,button.acc');
    if (f) setTimeout(() => f.focus(), 30);
    return close;
  }
  let stack = []; // lo que se cierra con «atrás» / Esc
  const closeTop = () => { const c = stack[stack.length - 1]; if (c) { c(); return true; } return false; };
  const pushClose = fn => { stack.push(fn); return () => { stack = stack.filter(x => x !== fn); }; };

  const confirm = (title, text, ok = 'Aceptar', danger) => new Promise(res => {
    modal((box, close) => {
      box.append(h('h2', null, title), text ? h('p', null, text) : '',
        h('div.btns', null, h('button.btn.ghost', { onclick: () => close(false) }, 'Cancelar'),
          h('button.btn.acc', { onclick: () => close(true), style: danger ? { background: '#e5484d', color: '#fff' } : null }, ok)));
    }, { onClose: v => res(!!v) });
  });
  const prompt = (title, value = '', ok = 'Aceptar', placeholder = '') => new Promise(res => {
    modal((box, close) => {
      const inp = h('input', { type: 'text', value, placeholder });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') close(inp.value.trim()); });
      box.append(h('h2', null, title), inp,
        h('div.btns', null, h('button.btn.ghost', { onclick: () => close(null) }, 'Cancelar'), h('button.btn.acc', { onclick: () => close(inp.value.trim()) }, ok)));
    }, { onClose: v => res(v == null ? null : v) });
  });

  /* ---------- menús emergentes ---------- */
  function popMenu(anchor, items) {
    closePop();
    const pop = h('div.pop', { role: 'menu' });
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { pop.append(h('hr')); continue; }
      pop.append(h('button', { role: 'menuitem', onclick: () => { closePop(); it.fn && it.fn(); } }, it.icon ? icon(it.icon) : '', h('span', null, it.label)));
    }
    document.body.append(pop);
    if (innerWidth <= 760) {
      // en el móvil, como YouTube: una hoja que sube desde abajo
      pop.classList.add('sheet-pop');
      haptic('long');
      const scrim = h('div.sheet-scrim', { onclick: () => closePop() });
      document.body.insertBefore(scrim, pop);
      popClose = pushClose(closePop);
      curPop = { pop, outside: () => {}, scrim };
      return;
    }
    let x, y;
    if (anchor && anchor.getBoundingClientRect) {
      const r = anchor.getBoundingClientRect();
      x = r.right - pop.offsetWidth; y = r.bottom + 4;
      if (x < 8) x = r.left;
    } else { x = anchor.x; y = anchor.y; }
    x = Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8));
    if (y + pop.offsetHeight > innerHeight - 8) y = Math.max(8, (anchor.getBoundingClientRect ? anchor.getBoundingClientRect().top : y) - pop.offsetHeight - 4);
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
    popClose = pushClose(closePop);
    setTimeout(() => addEventListener('pointerdown', outside, true), 0);
    function outside(e) { if (!pop.contains(e.target)) closePop(); }
    curPop = { pop, outside };
  }
  let curPop = null, popClose = null;
  // en el móvil las hojas bajan antes de irse
  function leave(...els) {
    if (innerWidth > 760) { els.forEach(x => x && x.remove()); return; }
    els.forEach(x => { if (!x) return; x.style.transform = ''; x.classList.add('out'); x.style.pointerEvents = 'none'; setTimeout(() => x.remove(), 210); });
  }
  function closePop() {
    if (!curPop) return;
    removeEventListener('pointerdown', curPop.outside, true);
    leave(curPop.pop, curPop.scrim); curPop = null;
    popClose && popClose(); popClose = null;
  }

  // una hoja que sube desde abajo (móvil) o una ventana (PC)
  function sheet(build) {
    if (innerWidth > 760) return modal((box, close) => build(box, close));
    const scrim = h('div.sheet-scrim');
    const sh = h('div.sheet', null, h('div.grab'));
    let closeFn;
    let gone = false;
    const close = () => { if (gone) return; gone = true; leave(scrim, sh); if (closeFn) closeFn(); };
    scrim.onclick = close;
    // deslizar hacia abajo la cierra
    let y0 = null;
    sh.addEventListener('touchstart', e => { if (sh.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    sh.addEventListener('touchmove', e => { if (y0 != null) { const d = e.touches[0].clientY - y0; if (d > 0) { sh.style.transition = 'none'; sh.style.transform = `translateY(${d}px)`; } } }, { passive: true });
    sh.addEventListener('touchend', e => { if (y0 != null) { const d = e.changedTouches[0].clientY - y0; y0 = null; sh.style.transition = ''; if (d > 90) close(); else sh.style.transform = ''; } });
    build(sh, close);
    document.body.append(scrim, sh);
    closeFn = pushClose(close);
    return close;
  }

  /* ---------- rutas (#/inicio, #/watch?v=…) ---------- */
  const routes = [];
  const route = (pattern, fn) => routes.push({ pattern, fn });
  function parseHash() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = raw.split('?');
    return { path, q: new URLSearchParams(qs || ''), raw };
  }
  let renderSeq = 0, lastPath = '', enterT = 0;
  const tabIndex = p => p === '/' ? 0 : p === '/subs' ? 1 : p === '/local' ? 2 : /^\/(library|history|later|likes|lists|downloads)$/.test(p) ? 3 : -1;
  async function render() {
    const r = parseHash();
    const seq = ++renderSeq;
    for (const { pattern, fn } of routes) {
      const m = r.path.match(pattern);
      if (m) {
        const v = $('#view'), was = lastPath;
        lastPath = r.path;
        if (v && innerWidth <= 760 && !(r.path === '/watch' && was === '/watch')) {
          // entre pestañas de abajo, la página entra por el lado hacia el que vas
          const a = tabIndex(was), b = tabIndex(r.path);
          v.dataset.dir = a >= 0 && b >= 0 && a !== b ? (b > a ? 'r' : 'l') : '';
          v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
          clearTimeout(enterT); enterT = setTimeout(() => v.classList.remove('enter'), 450);
        }
        emit('route', r);
        try { await fn({ ...r, m, alive: () => seq === renderSeq }); }
        catch (e) { console.error(e); if (seq === renderSeq) failView(e, render); }
        return;
      }
    }
    go('/');
  }
  const go = (path, replace) => { const h2 = '#' + path; if (replace) location.replace(h2); else if (location.hash !== h2) location.hash = h2; else render(); };
  addEventListener('hashchange', render);

  // la vista que falla: un aviso claro con «Reintentar», nunca en blanco
  function failView(e, retry, where = $('#view')) {
    where.className = '';
    where.replaceChildren(errorBox(e, retry));
  }
  function errorBox(e, retry, title = 'No se pudo cargar') {
    let msg = (e && e.message) || String(e || '');
    if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) msg = 'Mix4Up no contesta o no hay conexión. Mira tu internet y vuelve a intentarlo.';
    return h('div.notice', null, icon('refresh', 'big'), h('h2', null, title), h('p', null, msg),
      h('div.btns', null, retry ? h('button.btn.acc', { onclick: retry }, icon('refresh'), 'Reintentar') : ''));
  }

  /* ---------- aparato ---------- */
  let dev = '';
  try { dev = localStorage.getItem('m4.dev') || ''; } catch {}
  if (!dev) { dev = (ANDROID ? 'm' : 'p') + Math.random().toString(36).slice(2, 8); try { localStorage.setItem('m4.dev', dev); } catch {} }
  const deviceName = () => { try { return ANDROID ? Mix4UpAndroid.deviceName() : 'PC'; } catch { return ANDROID ? 'Móvil' : 'PC'; } };

  const store = {
    get(k, d) { try { const v = localStorage.getItem('m4.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('m4.' + k, JSON.stringify(v)); } catch {} },
  };

  const copy = async text => {
    try { await navigator.clipboard.writeText(text); toast('Enlace copiado'); }
    catch { try { if (ANDROID) { Mix4UpAndroid.share(text); return; } } catch {} prompt('Copia el enlace', text, 'Hecho'); }
  };

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  return {
    ANDROID, DESKTOP, $, $$, on, emit, haptic, api, Settings, h, icon, esc, dur, parseDur, views, ago, toast, modal, confirm, prompt,
    popMenu, closePop, sheet, closeTop, pushClose, route, go, render, parseHash, failView, errorBox, dev, deviceName, store, copy, debounce, applyLook,
  };
})();
