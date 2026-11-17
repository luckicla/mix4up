'use strict';
// Las páginas de Mix4Up: inicio, búsqueda, vídeo, canal, listas, tus vídeos…

const Views = (() => {
  const { h, icon, $, api, toast, dur, ago, route, go, Settings, ANDROID, DESKTOP, errorBox } = M4;
  const view = () => $('#view');

  /* ---------- tus vídeos (los de este aparato) ---------- */
  let local = { videos: [], folders: [], downloads: '' }, localAt = 0;
  async function loadLocal(force) {
    if (!force && Date.now() - localAt < 15000 && local.videos.length) return local;
    try { local = await api('/api/videos' + (force ? '?rescan=1' : '')); localAt = Date.now(); } catch (e) { if (!local.videos.length) throw e; }
    return local;
  }
  const ytIdRe = /\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/;
  function localCopy(id) { return local.videos.find(v => { const m = v.file.match(ytIdRe); return m && m[1] === id; }); }
  function localItem(v) {
    const m = v.file.match(ytIdRe);
    return { type: 'video', src: 'local', lid: v.id, key: m ? 'yt:' + m[1] : v.key, title: v.title.replace(/\s*\[[A-Za-z0-9_-]{11}\]$/, ''), channel: v.folder,
      thumb: '/thumb/' + v.id + (v.thumb ? '' : '?n=' + v.mtime), dur: v.dur, durText: v.dur ? dur(v.dur) : '', native: v.native, published: ago(v.mtime), size: v.size, file: v.file, _v: v };
  }

  // miniaturas de tus vídeos: un fotograma, sacado aquí mismo y guardado en Mix4Up
  const thumbQ = [];
  let thumbBusy = false;
  function wantThumb(it, img) { if (thumbQ.some(x => x.it.lid === it.lid)) return; thumbQ.push({ it, img }); pumpThumbs(); }
  function pumpThumbs() {
    if (thumbBusy || !thumbQ.length) return;
    thumbBusy = true;
    const { it, img } = thumbQ.shift();
    const v = h('video', { muted: true, preload: 'metadata', src: '/video/' + it.lid });
    v.muted = true;
    let done = false;
    const finish = () => { if (done) return; done = true; v.removeAttribute('src'); v.load(); thumbBusy = false; setTimeout(pumpThumbs, 50); };
    const timer = setTimeout(finish, 15000);
    v.addEventListener('loadedmetadata', () => { v.currentTime = Math.min(30, (v.duration || 10) * 0.15); });
    v.addEventListener('seeked', () => {
      try {
        const c = h('canvas', { width: 480, height: Math.round(480 * (v.videoHeight || 9) / (v.videoWidth || 16)) });
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob(b => {
          clearTimeout(timer);
          if (b) { fetch('/thumb/' + it.lid, { method: 'PUT', body: b }).then(() => { if (img && img.isConnected) { img.src = '/thumb/' + it.lid + '?t=' + Date.now(); img.hidden = false; img.nextSibling && img.nextSibling.classList && img.nextSibling.classList.contains('ph') && img.nextSibling.remove(); } it._v && (it._v.thumb = true); }).catch(() => {}); }
          finish();
        }, 'image/jpeg', 0.8);
      } catch { clearTimeout(timer); finish(); }
    }, { once: true });
    v.addEventListener('error', () => { clearTimeout(timer); finish(); });
  }

  /* ---------- tarjetas ---------- */
  function watchHref(it, list) {
    if (it.src === 'local' && !it.remote) return '#/watch?lid=' + encodeURIComponent(it.lid);
    if (it.remote) return '#/watch?pc=' + encodeURIComponent(it.lid);
    return '#/watch?v=' + it.id + (list ? '&list=' + encodeURIComponent(list) : '');
  }
  function card(it, opts = {}) {
    if (it.type === 'channel') {
      const cc = h('a.chan-card', { href: '#/channel/' + it.id }, h('img', { src: it.thumb, alt: '', loading: 'lazy' }),
        h('div', null, h('h3', null, it.title), h('div.muted', null, [it.handle, it.subs].filter(Boolean).join(' · ')), it.desc ? h('div.muted', { style: { fontSize: '12px', marginTop: '6px' } }, it.desc) : ''));
      cc._menu = a => channelMenu(it.id, it.title, a);
      return cc;
    }
    if (it.type === 'playlist') {
      const href = it.local ? '#/list/' + it.id : '#/playlist?list=' + encodeURIComponent(it.id);
      const pc = h('div.card.pl-stack', null,
        h('a.thumb', { href }, it.thumb ? h('img', { src: it.thumb, alt: '', loading: 'lazy' }) : h('div.ph', null, icon('list')), h('div.count', null, icon('list'), h('div', null, it.count || ''))),
        h('div.meta', null, h('div.t', null, h('a', { href }, h('h3', null, it.title || 'Lista')), h('div.sub', null, it.channel || (it.local ? 'Lista de Mix4Up' : 'Lista')))));
      pc._menu = a => M4.popMenu(a, [{ icon: 'list', label: 'Abrir la lista', fn: () => { location.hash = href; } },
        !it.local ? { icon: 'link', label: 'Copiar enlace', fn: () => M4.copy('https://www.youtube.com/playlist?list=' + it.id) } : null]);
      return pc;
    }
    const key = it.key || (it.src === 'local' ? it.key : 'yt:' + it.id);
    const w = Journal.watched(key);
    const href = watchHref(it, opts.list);
    const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', src: it.thumb || '', hidden: !it.thumb });
    img.onerror = () => {
      img.hidden = true;
      if (!img.nextSibling || !img.nextSibling.classList || !img.nextSibling.classList.contains('ph')) img.after(h('div.ph', null, icon('film')));
      // sin miniatura todavía: un fotograma, sacado aquí mismo
      if (it.src === 'local' && it.native !== false && !it.remote) wantThumb(it, img);
    };
    const th = h('a.thumb', { href }, img, !it.thumb ? h('div.ph', null, icon('film')) : '',
      it.live ? h('span.dur.live', null, 'EN DIRECTO') : it.durText || it.dur ? h('span.dur', null, it.durText || dur(it.dur)) : '',
      w ? h('div.prog', { style: { width: Math.max(4, w * 100) + '%' } }) : '',
      it.src === 'local' && !it.native ? h('span.badge', null, (it._v && it._v.ext || '').toUpperCase()) : '');
    const chLink = it.chId ? h('a', { href: '#/channel/' + it.chId, onclick: e => e.stopPropagation() }, it.channel) : h('span', null, it.channel || '');
    const subline = [it.views, it.published].filter(Boolean).join(' · ');
    const more = h('button.ib.more', { 'aria-label': 'Más opciones', onclick: e => { e.preventDefault(); e.stopPropagation(); itemMenu(it, more, opts); } }, icon('more'));
    const card = h('div.card', { 'data-key': key },
      th,
      h('div.meta', null,
        it.ava && !opts.noAva ? h('a', { href: it.chId ? '#/channel/' + it.chId : href }, h('img.ava', { src: it.ava, alt: '', loading: 'lazy' })) : '',
        h('div.t', null, h('a', { href }, h('h3', { title: it.title }, it.title)), h('div.sub', null, chLink, subline ? h('span.sl', null, subline) : ''),
          it.desc && opts.desc ? h('div.desc', null, it.desc) : '')),
      more);
    card._menu = a => itemMenu(it, a && a.x != null ? { ...a, closest: sel => card.closest(sel) } : a || more, { ...opts, ctx: true });
    if (it.src === 'yt' && it.id) {
      // el ratón encima (o el dedo): se prepara, y al entrar empieza al momento
      let t = 0;
      const prep = () => { clearTimeout(t); t = setTimeout(() => prepare(it.id), 220); };
      card.addEventListener('mouseenter', prep);
      card.addEventListener('mouseleave', () => clearTimeout(t));
      card.addEventListener('touchstart', () => prepare(it.id), { passive: true });
    }
    return card;
  }
  const prepared = new Set();
  function prepare(id) {
    if (!id || prepared.has(id)) return;
    prepared.add(id);
    fetch('/api/yt/video?prep=1&id=' + id).catch(() => {});
  }
  function grid(items, opts) { return h('div.grid', null, items.map(it => card(it, opts))); }
  function skeleton(n = 12) {
    return h('div.grid.skel', null, Array.from({ length: n }, () => h('div.card', null, h('div.thumb'), h('div.line', { style: { width: '90%' } }), h('div.line', { style: { width: '60%' } }))));
  }

  // un feed con scroll infinito (y aviso claro si falla)
  function infinite(box, f, opts = {}) {
    const g = opts.rows ? h('div.row-list') : h('div.grid');
    const sentinel = h('div.loadmore', null, h('div.spin'));
    // (mientras llega la primera tanda: tarjetas grises con la forma de los vídeos)
    const sk = opts.skel ? skeleton(opts.skel) : null;
    if (sk) box.append(sk);
    box.append(g, sentinel);
    let busy = false, count = 0, dead = false;
    async function more() {
      if (busy || dead || f.done) return;
      busy = true;
      try {
        const items = await f.more();
        if (!g.isConnected) return;
        for (const it of items) g.append(card(it, opts));
        if (!count && opts.onFirst) opts.onFirst();
        count += items.length;
        if (f.done || !items.length) {
          sentinel.replaceChildren(count ? h('span.muted', null, opts.endText || '') : opts.empty ? opts.empty() : h('div.notice', null, h('h2', null, 'Nada por aquí'), h('p', null, opts.emptyText || 'No hay vídeos que enseñar.')));
          io.disconnect();
        }
      } catch (e) {
        console.warn(e);
        sentinel.replaceChildren(errorBox(e, () => { sentinel.replaceChildren(h('div.spin')); more(); }, count ? 'No se pudieron cargar más' : 'No se pudo cargar'));
      } finally {
        busy = false;
        if (sk && sk.isConnected) sk.remove();
        // si aún se ve el final, otra tanda
        if (g.isConnected && !f.done && sentinel.querySelector('.spin')) {
          const r = sentinel.getBoundingClientRect();
          if (r.top < innerHeight + 600) setTimeout(more, 50);
        }
      }
    }
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: $('#main'), rootMargin: '900px' });
    io.observe(sentinel);
    more();
    return { stop: () => { dead = true; io.disconnect(); } };
  }

  /* ---------- menú de un vídeo ---------- */
  function itemMenu(it, anchor, opts = {}) {
    const key = it.key || (it.src === 'local' ? it.key : 'yt:' + it.id);
    const m = Journal.meta(it);
    const items = [];
    if (opts.ctx) {
      // (con clic derecho o manteniendo pulsado: también abrirlo)
      items.push({ icon: 'play', label: 'Ver ahora', fn: () => { location.hash = watchHref(it, opts.list); } });
      if (Player.item && it.src === 'yt') items.push({ icon: 'next', label: 'Ver después del que suena', fn: () => { Player.queueNext && Player.queueNext(it); toast('Lo verás después de este'); } });
      items.push('-');
    }
    if (it.src !== 'local' || it.key.startsWith('yt:')) {
      items.push({ icon: 'later', label: Journal.isOn('wl', key) ? 'Quitar de Ver más tarde' : 'Guardar en Ver más tarde', fn: () => toggleLater(it) });
    }
    items.push({ icon: 'addlist', label: 'Guardar en una lista', fn: () => saveToList(it) });
    if (it.src === 'yt') items.push({ icon: 'download', label: 'Descargar', fn: () => download(it) });
    if (it.src === 'yt') items.push({ icon: 'link', label: 'Copiar enlace', fn: () => M4.copy('https://youtu.be/' + it.id) });
    if (it.chId) items.push({ icon: 'user', label: 'Ir al canal', fn: () => go('/channel/' + it.chId) });
    if (Journal.pos(key)) items.push({ icon: 'history', label: 'Marcar como no visto', fn: () => { Journal.add('pos', key, null, { p: 0, d: 0 }); Journal.add('hist', key, 'del'); refreshCard(key); } });
    if (opts.list && opts.listLocal) items.push('-', { icon: 'trash', label: 'Quitar de esta lista', fn: () => { Journal.setInList(opts.list, m, false); M4.render(); } });
    if (opts.later) items.push('-', { icon: 'trash', label: 'Quitar de Ver más tarde', fn: () => { Journal.add('wl', key, 'del'); M4.render(); } });
    if (opts.history) items.push('-', { icon: 'trash', label: 'Quitar del historial', fn: () => { Journal.add('hist', key, 'del'); M4.render(); } });
    if (it.src === 'yt') items.push('-', { icon: 'hide', label: 'No me interesa', fn: () => hideItem(it, anchor) });
    if (it.src === 'local' && !it.remote) {
      items.push('-');
      if (DESKTOP) items.push({ icon: 'folder', label: 'Mostrar en la carpeta', fn: () => api('/api/reveal?id=' + it.lid, { method: 'POST' }) });
      items.push({ icon: 'trash', label: 'Borrar del disco…', fn: () => deleteLocal(it) });
    }
    M4.popMenu(anchor, items);
  }
  function channelMenu(id, title, anchor) {
    M4.popMenu(anchor, [{ icon: 'user', label: 'Ir al canal' + (title ? ' ' + title : ''), fn: () => go('/channel/' + id) },
      { icon: 'link', label: 'Copiar enlace del canal', fn: () => M4.copy('https://www.youtube.com/' + (id.startsWith('@') ? id : 'channel/' + id)) }]);
  }
  function refreshCard(key) {
    for (const c of document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"] .prog`)) c.remove();
  }
  function hideItem(it, anchor) {
    const key = 'yt:' + it.id;
    Journal.add('hide', key, 'add', Journal.meta(it));
    M4.haptic('confirm');
    const c = anchor.closest('.card');
    if (c) c.style.display = 'none';
    toast('Vídeo oculto', { action: 'Deshacer', fn: () => { Journal.add('hide', key, 'del'); if (c) c.style.display = ''; } });
  }
  async function toggleLater(it) {
    const key = it.key || 'yt:' + it.id;
    const on = Journal.toggle('wl', key, Journal.meta(it));
    M4.haptic('confirm');
    toast(on ? 'Guardado en Ver más tarde' : 'Quitado de Ver más tarde');
    if (YT.connected() && it.id) YT.watchLater(it.id, on).catch(e => console.warn('ver más tarde en YouTube:', e.message));
  }
  async function saveToList(it) {
    const m = Journal.meta(it);
    M4.modal((box, close) => {
      const paint = () => {
        const lists = Journal.lists();
        box.replaceChildren(h('h2', null, 'Guardar en…'),
          ...lists.map(l => {
            const cb = h('input', { type: 'checkbox', checked: Journal.inList(l.id, m.key) });
            cb.onchange = () => { Journal.setInList(l.id, m, cb.checked); toast(cb.checked ? 'Guardado en «' + l.name + '»' : 'Quitado de «' + l.name + '»'); };
            return h('label.opt', null, cb, h('span', null, l.name), h('small.muted', { style: { marginLeft: 'auto' } }, l.items.length));
          }),
          lists.length ? '' : h('p', null, 'Aún no tienes listas.'),
          h('div.btns', null, h('button.btn', { onclick: async () => { const n = await M4.prompt('Nombre de la lista nueva', '', 'Crear'); if (n) { const id = Journal.newList(n); Journal.setInList(id, m, true); toast('Guardado en «' + n + '»'); paint(); } } }, icon('addlist'), 'Lista nueva'),
            h('button.btn.acc', { onclick: () => close() }, 'Hecho')));
      };
      paint();
    });
  }
  function download(it) {
    M4.modal((box, close) => {
      const opts = [['', 'La mejor calidad'], ['1080', '1080p (Full HD)'], ['720', '720p (HD)'], ['480', '480p'], ['360', '360p (ocupa poco)'], ['audio', 'Solo el sonido']];
      box.append(h('h2', null, 'Descargar'), h('p', null, it.title),
        ...opts.map(([q, label]) => h('button.opt', { onclick: async () => {
          close();
          try {
            await api('/api/download', { json: { id: it.id, q, title: it.title } });
            toast('Descargando «' + (it.title || 'vídeo') + '»', { action: 'Ver', fn: () => go('/downloads') });
          } catch (e) { toast('No se pudo descargar: ' + e.message); }
        } }, icon(q === 'audio' ? 'vol' : 'download'), h('span', null, label))),
        h('p', { style: { fontSize: '12px' } }, 'Se guarda en ' + (local.downloads || 'tu carpeta de vídeos') + ' y aparece en «Mis vídeos».'),
        h('div.btns', null, h('button.btn.ghost', { onclick: () => close() }, 'Cancelar')));
    });
  }
  async function deleteLocal(it) {
    if (!await M4.confirm('¿Borrar este vídeo del disco?', `«${it.file || it.title}» se borrará para siempre.`, 'Borrar', true)) return;
    try { await api('/api/delete?id=' + it.lid, { method: 'POST' }); toast('Borrado'); localAt = 0; M4.render(); }
    catch (e) { toast(e.message); }
  }

  /* ---------- «Seguir viendo» ---------- */
  function continueItems(filter) {
    const out = [];
    for (const e of Journal.all('hist')) {
      const p = Journal.pos(e.k);
      if (!p || !p.d || p.p < 10 || p.p > p.d - 20 || !e.v) continue;
      const v = e.v;
      if (filter && !filter(v)) continue;
      if (v.src === 'local') {
        const lv = local.videos.find(x => x.id === v.lid || x.key === v.key);
        if (!lv) continue;
        out.push(localItem(lv));
      } else if (v.id) out.push({ type: 'video', src: 'yt', id: v.id, key: e.k, title: v.title, channel: v.ch, chId: v.chId, thumb: v.thumb || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, dur: v.dur, durText: v.dur ? dur(v.dur) : '' });
      if (out.length >= 8) break;
    }
    return out;
  }
  const fromMeta = v => v.src === 'local'
    ? (local.videos.find(x => x.id === v.lid || x.key === v.key) ? localItem(local.videos.find(x => x.id === v.lid || x.key === v.key)) : null)
    : { type: 'video', src: 'yt', id: v.id, key: v.key, title: v.title, channel: v.ch, chId: v.chId, thumb: v.thumb || `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, dur: v.dur, durText: v.dur ? dur(v.dur) : '' };

  function setView(cls, ...kids) { const v = view(); v.className = cls || ''; v.replaceChildren(...kids); $('#main').scrollTop = 0; return v; }
  const head = (title, ...right) => h('div.pagehead', null, h('h1', null, title), ...right);

  /* ---------- inicio ---------- */
  route(/^\/$/, async ({ alive }) => {
    const acct = await YT.account();
    YT.warm();
    const localP = loadLocal().catch(() => {});
    const box = setView('home');
    const connected = YT.connected();
    const mob = innerWidth <= 760;

    // un saludo (con tu nombre si has conectado la cuenta)
    const hr = new Date().getHours();
    const greet = hr < 6 ? 'Buenas noches' : hr < 14 ? 'Buenos días' : hr < 21 ? 'Buenas tardes' : 'Buenas noches';
    const me = connected ? YT.meCached() : null;
    const first = n => String(n || '').trim().split(/\s+/)[0];
    const hiName = h('span', null, me && me.name ? ', ' + first(me.name) : '');
    if (connected && !me) YT.me().then(m => { if (m && m.name && hiName.isConnected) hiName.textContent = ', ' + first(m.name); }).catch(() => {});
    const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
    box.append(h('div.hello', null, h('small', null, today), h('h1', null, greet, hiName)));

    if (!connected) {
      box.append(h('div.banner', null, icon('user'), h('p', null, h('b', null, 'Conecta tu cuenta de YouTube'), h('br'), h('span.muted', null, 'Y aquí verás lo mismo que te recomienda YouTube, sin un solo Short. Mientras tanto, te enseño cosas parecidas a lo que ves.')),
        h('button.btn.acc', { onclick: () => SettingsPage.connect() }, 'Conectar')));
    }

    // accesos rápidos (en el PC ya están en el menú de la izquierda)
    if (mob) {
      const quick = h('div.quick');
      const paintQuick = () => {
        const n = x => x ? h('small', null, x) : '';
        const tile = (href, ic, label, count) => h('a', { href }, h('i', null, icon(ic)), h('span', null, label), n(count));
        quick.replaceChildren(
          tile('#/later', 'later', 'Ver más tarde', Journal.all('wl').length),
          tile('#/history', 'history', 'Historial', Journal.all('hist').length),
          tile('#/local', 'folder', 'Mis vídeos', (local.videos || []).length),
          tile('#/lists', 'list', 'Listas', Journal.lists().length),
          tile('#/downloads', 'download', 'Descargas'),
          tile('#/likes', 'like', 'Me gusta', Journal.all('like').length));
      };
      paintQuick();
      localP.then(() => { if (quick.isConnected) paintQuick(); });
      box.append(quick);
    }

    // tus canales, en una fila de caritas (como YouTube)
    if (mob && connected) {
      const subs = h('div.subrow.homesubs', { hidden: true });
      box.append(subs);
      YT.guideSubs().then(list => {
        if (!list || !list.length || !subs.isConnected) return;
        subs.replaceChildren(...list.slice(0, 20).map(c => h('a', { href: '#/channel/' + c.id }, c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy' }) : h('span.ph0', null, icon('user')), h('span', null, c.title))),
          h('a.all', { href: '#/subs' }, h('span.ph0', null, icon('subs')), h('span', null, 'Todas')));
        subs.hidden = false;
      }).catch(() => {});
    }

    // seguir viendo: en el móvil, una fila que se desliza (no una miniatura que ocupa toda la pantalla)
    const cont = continueItems();
    if (cont.length) {
      const sh = (title, ic, body, more) => h('section.shelf', null, h('div.shelfhead', null, h('h2', null, icon(ic), title), more || ''), body);
      box.append(sh('Seguir viendo', 'history', mob ? h('div.hscroll', null, cont.map(it => card(it))) : grid(cont), h('a.more2', { href: '#/history' }, 'Ver todo')));
    }

    // las recomendaciones, con sus temas encima (se quedan pegados arriba al bajar)
    const chipsRow = h('div.chips', { hidden: true });
    const forYou = h('div.shelfhead.foryou', null, h('h2', null, icon('home'), connected ? 'Para ti' : 'Te puede gustar'));
    const feedBox = h('div');
    box.append(forYou, chipsRow, feedBox);
    const empty = () => h('div.notice', null, icon('search', 'big'), h('h2', null, connected ? 'YouTube no ha dado recomendaciones' : 'Empieza buscando algo'),
      h('p', null, connected ? 'Prueba a refrescar. Si sigue igual, vuelve a conectar tu cuenta en Ajustes.' : 'Busca un vídeo arriba o conecta tu cuenta: según lo que veas, aquí aparecerán recomendaciones.'),
      h('div.btns', null, h('button.btn.acc', { onclick: () => M4.render() }, icon('refresh'), 'Reintentar'), !connected ? h('button.btn', { onclick: () => SettingsPage.connect() }, 'Conectar con YouTube') : ''));
    let cur = null;
    const start = f => {
      if (cur) cur.stop();
      feedBox.replaceChildren();
      cur = infinite(feedBox, f, { empty, skel: mob ? 3 : 8, onFirst: () => paintChips(f) });
    };
    const home = takeHome() || YT.home();
    let chipsDone = false;
    function paintChips(f) {
      if (chipsDone || !alive()) return;
      const list = (f.chips || []).filter(c => c.token);
      if (!list.length) return;
      chipsDone = true;
      chipsRow.hidden = false;
      const all = h('button.chip.on', null, 'Todo');
      const set = b => { chipsRow.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b)); b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); };
      // al cambiar de tema: a donde empiezan las recomendaciones (no arriba del todo)
      const toFeed = () => { const m = $('#main'), y = chipsRow.offsetTop - 2; if (m.scrollTop > y) m.scrollTop = y; };
      all.onclick = () => { set(all); toFeed(); start(YT.home()); };
      chipsRow.replaceChildren(all, ...list.filter(c => !/^todo|^all$/i.test(c.label)).map(c => {
        const b = h('button.chip', null, c.label);
        b.onclick = () => { M4.haptic('tick'); set(b); toFeed(); start(YT.chipFeed(c.token)); };
        return b;
      }));
    }
    start(home);
  });
  // el inicio se empieza a pedir nada más abrir Mix4Up (para que salga ya)
  let homePre = null, homePreAt = 0;
  function preloadHome() {
    homePre = YT.home(); homePreAt = Date.now();
    const m = homePre.more.bind(homePre);
    const first = m().catch(e => { throw e; });
    let used = false;
    homePre.more = () => { if (!used) { used = true; return first; } return m(); };
  }
  function takeHome() { const f = homePre && Date.now() - homePreAt < 120e3 ? homePre : null; homePre = null; return f; }

  /* ---------- búsqueda ---------- */
  route(/^\/search$/, async ({ q }) => {
    const query = q.get('q') || '';
    const filter = q.get('f') || '';
    $('#q').value = query;
    const box = setView('');
    const chip = (f, label) => h('a.chip' + (filter === f ? '.on' : ''), { href: '#/search?q=' + encodeURIComponent(query) + (f ? '&f=' + f : '') }, label);
    box.append(h('div.chips', null, chip('', 'Todo'), chip('video', 'Vídeos'), chip('channel', 'Canales'), chip('playlist', 'Listas'), chip('local', 'Mis vídeos')));
    await loadLocal().catch(() => {});
    const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const words = norm(query).split(/\s+/).filter(Boolean);
    const mine = local.videos.filter(v => words.every(w => norm(v.title + ' ' + v.folder).includes(w))).map(localItem);
    if (filter === 'local') { box.append(mine.length ? h('div.row-list', null, mine.map(it => card(it, { desc: true }))) : h('div.notice', null, h('h2', null, 'Ninguno de tus vídeos coincide'))); return; }
    if (mine.length && !filter) box.append(h('section.shelf', null, h('h2', null, icon('folder'), 'En tus vídeos'), h('div.row-list', null, mine.slice(0, 4).map(it => card(it)))));
    // en el móvil, como YouTube: resultados con la miniatura grande
    infinite(box, YT.search(query, filter), { rows: innerWidth > 760, desc: true, emptyText: 'No hay resultados para «' + query + '».' });
  });

  /* ---------- suscripciones ---------- */
  route(/^\/subs$/, async () => {
    await YT.getCfg();
    const box = setView('');
    box.append(head('Suscripciones'));
    const chans = await YT.guideSubs().catch(() => []);
    if (chans.length) box.append(h('div.subrow', null, chans.slice(0, 60).map(c => h('a', { href: '#/channel/' + c.id }, c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy' }) : h('span.ph0', null, icon('user')), h('span', null, c.title)))));
    if (!YT.connected() && !Journal.all('sub').length) {
      box.append(h('div.notice', null, icon('subs', 'big'), h('h2', null, 'Aún no sigues a nadie'), h('p', null, 'Conecta tu cuenta de YouTube para ver tus suscripciones, o suscríbete a canales desde Mix4Up.'),
        h('div.btns', null, h('button.btn.acc', { onclick: () => SettingsPage.connect() }, 'Conectar con YouTube'))));
      return;
    }
    infinite(box, YT.subscriptions());
  });

  /* ---------- canal ---------- */
  route(/^\/channel\/([^/?]+)$/, async ({ m, q, alive }) => {
    const box = setView('', h('div.spin'));
    const info = await YT.channel(decodeURIComponent(m[1]));
    if (!alive()) return;
    const tab = q.get('tab') || 'videos';
    const subBtn = h('button.btn.fg');
    const localSub = () => Journal.isOn('sub', info.id);
    let subbed = info.subscribed || localSub();
    const paintSub = () => { subBtn.textContent = subbed ? 'Suscrito' : 'Suscribirse'; subBtn.className = 'btn ' + (subbed ? '' : 'fg'); };
    paintSub();
    subBtn.onclick = async () => {
      subbed = !subbed; paintSub();
      Journal.add('sub', info.id, subbed ? 'add' : 'del', { n: info.title, a: info.ava });
      if (YT.connected()) try { await YT.subscribe(info.id, subbed); } catch (e) { toast('YouTube no aceptó el cambio: ' + e.message); }
      sideSubs();
    };
    box.replaceChildren(
      info.banner ? h('div.chanbanner', { style: { backgroundImage: `url("${info.banner}")` } }) : '',
      h('div.chanhead', null, info.ava ? h('img', { src: info.ava, alt: '' }) : '', h('div', { style: { flex: 1, minWidth: '200px' } }, h('h1', null, info.title), h('div.muted', null, [info.handle, info.subs].filter(Boolean).join(' · ')),
        info.desc ? h('div.muted', { style: { marginTop: '6px', maxWidth: '760px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, info.desc) : ''), subBtn),
      h('div.chips', null, ...[['videos', 'Vídeos'], ['streams', 'Directos'], ['playlists', 'Listas']].filter(([t]) => info.tabs.some(x => x.url.endsWith('/' + t))).map(([t, l]) => h('a.chip' + (tab === t ? '.on' : ''), { href: '#/channel/' + info.id + '?tab=' + t }, l))));
    const f = YT.channelTab(info, tab);
    if (f) infinite(box, f);
    else box.append(grid(info.first));
  });

  /* ---------- listas de YouTube ---------- */
  route(/^\/playlist$/, async ({ q, alive }) => {
    const id = q.get('list');
    const box = setView('', h('div.spin'));
    const pl = await YT.playlist(id);
    if (!alive()) return;
    const first = pl.items.find(x => x.type === 'video');
    box.replaceChildren(head(pl.title || 'Lista', first ? h('a.btn.acc', { href: watchHref(first, id) }, icon('play'), 'Ver todo') : ''));
    const g = h('div.row-list');
    box.append(g);
    pl.items.forEach(it => g.append(card(it, { list: id })));
    infinite(box, pl, { list: id, rows: true, endText: '' });
  });

  /* ---------- tus listas, historial, ver más tarde, me gusta ---------- */
  function metaList(title, entries, opts = {}, ...right) {
    const items = entries.map(e => fromMeta({ ...(e.v || {}), key: e.k })).filter(Boolean);
    const box = setView('');
    box.append(head(title, ...right));
    if (!items.length) { box.append(h('div.notice', null, h('h2', null, opts.emptyTitle || 'Nada por aquí'), h('p', null, opts.empty || ''))); return box; }
    box.append(h('div.row-list', null, items.map(it => card(it, { ...opts, desc: false }))));
    return box;
  }
  function tabs(cur, list) { return h('div.chips', null, list.map(([k, label, href]) => h('a.chip' + (cur === k ? '.on' : ''), { href }, label))); }

  route(/^\/history$/, async ({ q }) => {
    await loadLocal().catch(() => {});
    const which = q.get('de') || 'mix4up';
    if (which === 'youtube' && YT.connected()) {
      const box = setView('');
      box.append(head('Historial'), tabs(which, [['mix4up', 'En Mix4Up', '#/history'], ['youtube', 'En YouTube', '#/history?de=youtube']]));
      infinite(box, YT.history(), { rows: true });
      return;
    }
    const box = metaList('Historial', Journal.all('hist'), { history: true, empty: 'Lo que veas aparecerá aquí (también lo que veas en el móvil, si los conectas).' },
      h('button.btn', { onclick: async () => { if (await M4.confirm('¿Borrar todo el historial de Mix4Up?', 'Se borra en este aparato y en los conectados. No toca tu historial de YouTube.', 'Borrar', true)) { for (const e of Journal.all('hist')) Journal.add('hist', e.k, 'del'); M4.render(); } } }, icon('trash'), 'Borrar historial'));
    if (YT.connected()) box.insertBefore(tabs(which, [['mix4up', 'En Mix4Up', '#/history'], ['youtube', 'En YouTube', '#/history?de=youtube']]), box.children[1]);
  });
  route(/^\/later$/, async ({ q }) => {
    await loadLocal().catch(() => {});
    const which = q.get('de') || 'mix4up';
    if (which === 'youtube' && YT.connected()) {
      const box = setView('');
      box.append(head('Ver más tarde'), tabs(which, [['mix4up', 'En Mix4Up', '#/later'], ['youtube', 'En YouTube', '#/later?de=youtube']]));
      const pl = await YT.playlist('WL');
      const g = h('div.row-list'); box.append(g); pl.items.forEach(it => g.append(card(it, { list: 'WL' })));
      infinite(box, pl, { rows: true, list: 'WL' });
      return;
    }
    const box = metaList('Ver más tarde', Journal.all('wl'), { later: true, empty: 'Guarda vídeos con el menú ⋮ → «Guardar en Ver más tarde».' });
    if (YT.connected()) box.insertBefore(tabs(which, [['mix4up', 'En Mix4Up', '#/later'], ['youtube', 'En YouTube', '#/later?de=youtube']]), box.children[1]);
  });
  route(/^\/likes$/, async ({ q }) => {
    await loadLocal().catch(() => {});
    const which = q.get('de') || 'mix4up';
    if (which === 'youtube' && YT.connected()) {
      const box = setView('');
      box.append(head('Me gusta'), tabs(which, [['mix4up', 'En Mix4Up', '#/likes'], ['youtube', 'En YouTube', '#/likes?de=youtube']]));
      const pl = await YT.playlist('LL');
      const g = h('div.row-list'); box.append(g); pl.items.forEach(it => g.append(card(it, { list: 'LL' })));
      infinite(box, pl, { rows: true, list: 'LL' });
      return;
    }
    const box = metaList('Me gusta', Journal.all('like'), { empty: 'Los vídeos que te gusten (👍 debajo del vídeo) aparecerán aquí.' });
    if (YT.connected()) box.insertBefore(tabs(which, [['mix4up', 'En Mix4Up', '#/likes'], ['youtube', 'En YouTube', '#/likes?de=youtube']]), box.children[1]);
  });
  route(/^\/lists$/, async () => {
    await loadLocal().catch(() => {});
    const box = setView('');
    box.append(head('Listas', h('button.btn', { onclick: async () => { const n = await M4.prompt('Nombre de la lista', '', 'Crear'); if (n) { Journal.newList(n); M4.render(); } } }, icon('addlist'), 'Lista nueva')));
    const mine = Journal.lists().map(l => ({ type: 'playlist', local: true, id: l.id, title: l.name, count: l.items.length + ' vídeos', thumb: (l.items[0] && (l.items[0].thumb || (l.items[0].id ? `https://i.ytimg.com/vi/${l.items[0].id}/hqdefault.jpg` : ''))) || '', channel: 'Mix4Up' }));
    box.append(h('section.shelf', null, h('h2', null, 'Mis listas de Mix4Up'), mine.length ? grid(mine) : h('p.muted', null, 'Aún no has hecho ninguna. Se sincronizan con el móvil y el PC.')));
    if (YT.connected()) {
      const s = h('section.shelf', null, h('h2', null, 'Mis listas de YouTube'));
      box.append(s);
      infinite(s, YT.myPlaylists(), { emptyText: 'No tienes listas en YouTube.' });
    }
  });
  route(/^\/list\/([\w-]+)$/, async ({ m }) => {
    await loadLocal().catch(() => {});
    const l = Journal.lists().find(x => x.id === m[1]);
    if (!l) { setView('', h('div.notice', null, h('h2', null, 'Esa lista ya no existe'))); return; }
    const items = l.items.map(v => fromMeta(v)).filter(Boolean);
    const box = setView('');
    box.append(head(l.name,
      items[0] ? h('a.btn.acc', { href: watchHref(items[0]) + (items[0].src === 'yt' ? '&mlist=' + l.id : '') }, icon('play'), 'Ver todo') : '',
      h('button.btn', { onclick: async () => { const n = await M4.prompt('Nuevo nombre', l.name, 'Cambiar'); if (n) { Journal.renameList(l.id, n); M4.render(); } } }, 'Cambiar nombre'),
      h('button.btn', { onclick: async () => { if (await M4.confirm('¿Borrar la lista «' + l.name + '»?', 'Los vídeos no se borran.', 'Borrar', true)) { Journal.deleteList(l.id); go('/lists'); } } }, icon('trash'), 'Borrar')));
    box.append(items.length ? h('div.row-list', null, items.map(it => card(it, { list: l.id, listLocal: true }))) : h('div.notice', null, h('h2', null, 'Lista vacía'), h('p', null, 'Añade vídeos con el menú ⋮ → «Guardar en una lista».')));
  });
  route(/^\/library$/, async () => {
    await loadLocal().catch(() => {});
    await YT.account();
    const box = setView('');
    const conn = YT.connected();
    const me = conn ? YT.meCached() : null;
    const ava = h('div.ava' + (me ? '.face' : ''), null, me ? h('img', { src: me.photo, alt: '', referrerpolicy: 'no-referrer' }) : icon('user'));
    const nm = h('h1', null, me && me.name ? me.name : 'Tú'), hd = h('small', null, conn ? (me && me.handle ? me.handle + ' · ' : '') + 'Cuenta de YouTube conectada' : 'Sin cuenta de YouTube');
    if (conn && !me) YT.me().then(m => { if (!m || !ava.isConnected) return; ava.classList.add('face'); ava.replaceChildren(h('img', { src: m.photo, alt: '', referrerpolicy: 'no-referrer' })); nm.textContent = m.name || 'Tú'; hd.textContent = (m.handle ? m.handle + ' · ' : '') + 'Cuenta de YouTube conectada'; });
    box.append(h('div.you', null, ava, h('div', null, nm, hd,
      !conn ? h('div', { style: { marginTop: '6px' } }, h('button.btn.acc', { onclick: () => SettingsPage.connect() }, 'Conectar con YouTube')) : '')));
    const hist = Journal.all('hist').slice(0, 15).map(e => fromMeta({ ...(e.v || {}), key: e.k })).filter(Boolean);
    const shelf = (title, href, items) => h('section.shelf', null, h('div.pagehead', { style: { margin: '14px 12px 10px' } }, h('h2', { style: { flex: 1 } }, title), href ? h('a.btn.ghost', { href }, 'Ver todo') : ''),
      items.length ? h('div.hscroll', null, items.map(it => card(it))) : h('p.muted', { style: { margin: '0 12px' } }, 'Aún no hay nada.'));
    box.append(shelf('Historial', '#/history', hist));
    const lists = Journal.lists().map(l => ({ type: 'playlist', local: true, id: l.id, title: l.name, count: l.items.length + ' vídeos', thumb: (l.items[0] && (l.items[0].thumb || (l.items[0].id ? `https://i.ytimg.com/vi/${l.items[0].id}/hqdefault.jpg` : ''))) || '', channel: 'Mix4Up' }));
    box.append(shelf('Listas', '#/lists', lists));
    const row = (href, ic, label, n) => h('a.yrow', { href }, icon(ic), h('span', null, label), n != null ? h('small', null, n) : '');
    box.append(h('div', { style: { marginTop: '6px' } },
      row('#/local', 'folder', 'Mis vídeos', (local.videos || []).length),
      row('#/later', 'later', 'Ver más tarde', Journal.all('wl').length || null),
      row('#/likes', 'like', 'Vídeos que me gustan', Journal.all('like').length || null),
      row('#/downloads', 'download', 'Descargas'),
      row('#/subs', 'subs', 'Suscripciones'),
      h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', margin: '6px 0' } }),
      row('#/settings', 'devices', ANDROID ? 'Conectar con el PC' : 'Conectar el móvil'),
      row('#/settings', 'palette', 'Aspecto y colores'),
      row('#/settings', 'gear', 'Ajustes')));
  });

  /* ---------- tus vídeos ---------- */
  route(/^\/local$/, async ({ q }) => {
    const box = setView('', h('div.spin'));
    await loadLocal(q.get('r') === '1');
    const folder = q.get('c') || '';
    const sort = q.get('o') || 'new';
    const pc = q.get('pc') === '1';
    const folders = [...new Set(local.videos.map(v => v.folder))].sort((a, b) => a.localeCompare(b));
    const href = (c, o, p) => '#/local?' + new URLSearchParams({ ...(c ? { c } : {}), ...(o && o !== 'new' ? { o } : {}), ...(p ? { pc: '1' } : {}) });
    const actions = [h('button.btn', { onclick: () => go('/local?r=1' + (folder ? '&c=' + encodeURIComponent(folder) : '')) }, icon('refresh'), 'Volver a leer')];
    if (DESKTOP) actions.push(h('button.btn', { onclick: SettingsPage.addFolder }, icon('folder'), 'Añadir carpeta'));
    box.replaceChildren(head('Mis vídeos', ...actions));
    const sorter = h('select.field', { style: { width: 'auto', height: '32px' }, onchange: e => go(href(folder, e.target.value, pc).slice(1)) },
      ...[['new', 'Más recientes'], ['name', 'Por nombre'], ['long', 'Más largos'], ['short', 'Más cortos']].map(([v, l]) => h('option', { value: v, selected: v === sort }, l)));
    const chipsRow = h('div.chips', null, h('a.chip' + (!folder && !pc ? '.on' : ''), { href: href('', sort) }, 'Todos'),
      ANDROID && Sync.paired() ? h('a.chip' + (pc ? '.on' : ''), { href: href('', sort, true) }, icon('devices'), 'Del PC') : '',
      ...folders.slice(0, 30).map(f => h('a.chip' + (folder === f ? '.on' : ''), { href: href(f, sort) }, icon('folder'), f)), sorter);
    box.append(chipsRow);
    if (pc) {
      const s = h('div', null, h('div.spin'));
      box.append(s);
      try { const list = await Sync.pcVideos(); s.replaceChildren(list.length ? grid(list) : h('div.notice', null, h('h2', null, 'El PC no tiene vídeos'))); }
      catch (e) { s.replaceChildren(errorBox(e, () => M4.render(), 'No se pudo hablar con el PC')); }
      return;
    }
    let list = local.videos.filter(v => !folder || v.folder === folder).map(localItem);
    if (sort === 'name') list.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === 'long') list.sort((a, b) => (b.dur || 0) - (a.dur || 0));
    else if (sort === 'short') list.sort((a, b) => (a.dur || 1e9) - (b.dur || 1e9));
    const cont = !folder ? continueItems(v => v.src === 'local') : [];
    if (cont.length) box.append(h('section.shelf', null, h('h2', null, icon('history'), 'Seguir viendo'), grid(cont)));
    if (!list.length) {
      box.append(h('div.notice', null, icon('folder', 'big'), h('h2', null, 'No hay vídeos'),
        h('p', null, ANDROID ? 'No encuentro vídeos en el móvil. Si acabas de dar permiso, pulsa «Volver a leer».' : 'Pon vídeos en tu carpeta Vídeos (' + (local.folders[0] || '') + ') o añade otra carpeta.'),
        h('div.btns', null, h('button.btn.acc', { onclick: () => go('/local?r=1') }, icon('refresh'), 'Volver a leer'), DESKTOP ? h('button.btn', { onclick: SettingsPage.addFolder }, 'Añadir carpeta') : '',
          ANDROID ? h('button.btn', { onclick: () => { try { Mix4UpAndroid.askVideoPermission(); } catch {} } }, 'Dar permiso') : '')));
      return;
    }
    box.append(h('h2', { style: { margin: '6px 0 14px' } }, list.length + (list.length === 1 ? ' vídeo' : ' vídeos')));
    // de 60 en 60 (miles de vídeos no se pintan de golpe)
    let n = 0;
    infinite(box, { done: false, async more() { const part = list.slice(n, n + 60); n += 60; if (n >= list.length) this.done = true; return part; } });
  });

  /* ---------- descargas ---------- */
  route(/^\/downloads$/, async ({ alive }) => {
    const box = setView('');
    box.append(head('Descargas', h('a.btn', { href: '#/local?c=' + encodeURIComponent('Mix4Up') }, icon('folder'), 'Ver descargados')));
    const listBox = h('div');
    box.append(listBox);
    const paint = async () => {
      if (!alive()) return;
      let jobs = [];
      try { jobs = await api('/api/download'); } catch (e) { listBox.replaceChildren(errorBox(e, paint)); return; }
      listBox.replaceChildren(...(jobs.length ? jobs.slice().reverse().map(j => h('div.dl', null,
        h('img', { src: `https://i.ytimg.com/vi/${j.id}/mqdefault.jpg`, alt: '', style: { width: '120px', aspectRatio: '16/9', objectFit: 'cover', borderRadius: '8px' } }),
        h('div.t', null, h('b', null, j.title || j.id), h('div.muted', null, j.state === 'done' ? 'Descargado · ' + (j.file || '') : j.state === 'error' ? 'Error: ' + j.error : j.state === 'queued' ? 'En cola' : 'Descargando… ' + Math.round(j.pct) + '%'),
          j.state === 'running' ? h('div.pbar', null, h('i', { style: { width: j.pct + '%' } })) : ''),
        j.state === 'done' ? h('a.btn', { href: '#/watch?v=' + j.id }, icon('play'), 'Ver') : '',
        h('button.ib', { title: j.state === 'running' ? 'Cancelar' : 'Quitar de la lista', onclick: async () => { await api('/api/download?key=' + j.key, { method: 'DELETE' }); paint(); } }, icon('close'))))
        : [h('div.notice', null, icon('download', 'big'), h('h2', null, 'Sin descargas'), h('p', null, 'En un vídeo de YouTube, pulsa «Descargar» y elige la calidad.'))]));
      if (jobs.some(j => j.state === 'running' || j.state === 'queued')) setTimeout(paint, 1500);
    };
    paint();
  });

  /* ---------- la página de un vídeo ---------- */
  let watchCtx = null, watchOff = null;
  route(/^\/watch$/, async ({ q, alive }) => {
    const id = q.get('v'), lid = q.get('lid'), pcid = q.get('pc'), list = q.get('list'), mlist = q.get('mlist');
    const t = +q.get('t') || 0;
    await loadLocal().catch(() => {});
    let it;
    if (id) {
      if (!YT.ytId(id)) throw new Error('Ese enlace de vídeo no es válido');
      it = { type: 'video', src: 'yt', id, key: 'yt:' + id };
      const prev = Player.item;
      if (prev && (prev.id === id || prev._yt === id)) it = prev;
    } else if (lid) {
      const v = local.videos.find(x => x.id === lid);
      if (!v) throw new Error('Ese vídeo ya no está en tus carpetas');
      it = localItem(v);
    } else if (pcid) {
      it = await Sync.pcVideo(pcid);
    } else { go('/'); return; }

    const theater = Settings.get().theater;
    const host = h('div.playhost');
    const titleEl = h('h1.vtitle', null, it.title || '');
    const metaEl = h('div.vmeta');
    let descText = '', descTop = '';
    const openDesc = () => M4.sheet((sh, close) => {
      const parts = descTop.split(' · ');
      sh.append(h('h3', null, titleEl.textContent),
        h('div.stats', null, ...parts.filter(Boolean).slice(0, 3).map(p0 => { const m = p0.match(/^([\d.,]+\s*(?:mil|M)?)\s*(.*)$/); return h('div', null, h('b', null, m ? m[1] : p0), h('small', null, m ? m[2] : '')); })),
        h('div.desct', null, ...linkify(descText || 'Sin descripción.')));
      sh.addEventListener('click', e => { if (e.target.closest('a[href="#"]')) close(); });
    });
    titleEl.onclick = () => { if (innerWidth <= 760) openDesc(); };
    const paintMeta = () => metaEl.replaceChildren(h('span', null, descTop), descText || descTop ? h('b', { role: 'button', onclick: openDesc }, '…más') : '');
    const ownerEl = h('div.owner');
    const actsEl = h('div.vacts');
    const descEl = h('div.desc.short', { hidden: true });
    const chapEl = h('div.chapters', { hidden: true });
    const relEl = h('div.related', null, it.src === 'yt' ? Array.from({ length: 8 }, () => h('div.card.skel', null, h('div.thumb', { style: { width: '168px' } }), h('div', { style: { flex: 1 } }, h('div.line'), h('div.line', { style: { width: '60%' } })))) : '');
    const autoSw = h('span.switch' + (Settings.get().autoplay ? '.on' : ''), { role: 'switch', onclick: () => { Settings.set({ autoplay: !Settings.get().autoplay }); autoSw.classList.toggle('on', Settings.get().autoplay); } }, h('span', null, 'Reproducción automática'), h('i'));
    const plBox = h('div', { hidden: true, style: { background: 'var(--bg2)', borderRadius: 'var(--r)', padding: '12px', marginBottom: '12px', maxHeight: '420px', overflowY: 'auto' } });
    const v = setView('wide', h('div.watch' + (theater ? '.theater' : ''), null,
      h('div.primary', null, host, h('div.info', null, titleEl, metaEl, h('div.vbar', null, ownerEl, actsEl), chapEl, descEl)),
      h('div.secondary', null, plBox, h('div.upnext', null, h('h3', null, it.src === 'local' ? 'Más de tus vídeos' : 'Siguientes'), autoSw), relEl)));
    document.body.classList.add('watching'); M4.barsFor();
    Player.mount(host);
    $('#mini').hidden = true;
    const same = Player.item && Player.keyOf(Player.item) === Player.keyOf(it) && Player.item.src === it.src;
    if (!same) Player.open(it, { start: t });
    watchCtx = { it, list, mlist };

    // los botones de debajo
    const key = Player.keyOf(it);
    const likeBtn = h('button.btn' + (Journal.isOn('like', key) ? '.on' : ''), { onclick: async () => {
      const on = Journal.toggle('like', key, Journal.meta(Player.item || it));
      M4.haptic(on ? 'confirm' : 'tap');
      likeBtn.classList.toggle('on', on);
      if (YT.connected() && it.src === 'yt') YT.like(it.id, on).catch(e => toast('YouTube no aceptó el me gusta: ' + e.message));
    } }, icon('like'), 'Me gusta');
    const laterBtn = h('button.btn', { onclick: () => toggleLater(Player.item || it) }, icon('later'), 'Más tarde');
    actsEl.append(likeBtn, laterBtn, h('button.btn', { onclick: () => saveToList(Player.item || it) }, icon('addlist'), 'Guardar'));
    if (it.src === 'yt') actsEl.append(h('button.btn', { onclick: () => download(Player.item || it) }, icon('download'), 'Descargar'),
      h('button.btn', { onclick: () => M4.copy('https://youtu.be/' + it.id) }, icon('link'), 'Compartir'));
    actsEl.append(h('button.btn', { title: 'Temporizador para dormir', onclick: () => { Player.openMenu('sleep'); } }, icon('moon'), 'Dormir'));

    const fillInfo = (inf) => {
      if (!alive()) return;
      titleEl.textContent = inf.title || it.title || '';
      document.title = (inf.title || 'Vídeo') + ' · Mix4Up';
      if (inf.description && !descEl.dataset.full) setDesc(inf.description, [inf.views ? M4.views(inf.views) : '', inf.upload ? inf.upload.replace(/(\d{4})(\d{2})(\d{2})/, '$3/$2/$1') : ''].filter(Boolean).join(' · '));
      if (inf.chapters && inf.chapters.length) {
        chapEl.hidden = false;
        chapEl.replaceChildren(...inf.chapters.map(c => h('button', { onclick: () => Player.seek(c.start) }, h('b', null, dur(c.start)), c.title)));
      }
      if (!ownerEl.childElementCount && inf.channel) ownerEl.append(h('a', { href: inf.channelId ? '#/channel/' + inf.channelId : null }, h('b', null, inf.channel)));
    };
    function setDesc(text, top) {
      descText = text || ''; descTop = top || descTop; paintMeta();
      descEl.hidden = false;
      descEl.replaceChildren(top ? h('b', null, top) : '', ...linkify(text));
      descEl.onclick = e => { if (e.target.closest('a')) return; descEl.classList.toggle('short'); };
    }
    if (watchOff) watchOff();
    watchOff = M4.on('player:info', fillInfo);
    if (Player.info && same) fillInfo(Player.info);

    if (it.src === 'local') {
      titleEl.textContent = it.title;
      ownerEl.append(h('div', null, h('b', null, it.channel), h('small', null, [it.durText, it.size ? (it.size / 1048576).toFixed(0) + ' MB' : '', it._v ? it._v.ext.toUpperCase() : ''].filter(Boolean).join(' · '))));
      descTop = [it.published, it.size ? (it.size / 1048576).toFixed(0) + ' MB' : ''].filter(Boolean).join(' · '); paintMeta();
      const others = local.videos.filter(x => x.folder === (it._v && it._v.folder) && x.id !== it.lid).map(localItem);
      const rel = (others.length ? others : local.videos.filter(x => x.id !== it.lid).map(localItem)).slice(0, 40);
      relEl.replaceChildren(...rel.map(r => card(r, { noAva: true })));
      Player.setQueue(rel.filter(r => !Journal.watched(r.key)).slice(0, 5));
      return;
    }
    // YouTube: datos de la página y relacionados (sin Shorts)
    let w = null;
    try { w = await YT.watch(id, list || undefined); }
    catch (e) {
      if (!alive()) return;
      relEl.replaceChildren(errorBox(e, () => M4.render(), 'No se pudieron cargar los relacionados'));
      return;
    }
    if (!alive()) return;
    titleEl.textContent = w.title || titleEl.textContent;
    if (w.title && Player.item && Player.item.id === id && !Player.item.title) Player.item.title = w.title;
    Object.assign(it, { title: it.title || w.title, channel: it.channel || w.channel, chId: it.chId || w.chId });
    const subbed = { v: w.subscribed || Journal.isOn('sub', w.chId) };
    const subBtn = h('button.btn' + (subbed.v ? '' : '.fg'), { onclick: async () => {
      subbed.v = !subbed.v;
      M4.haptic(subbed.v ? 'confirm' : 'tap');
      subBtn.textContent = subbed.v ? 'Suscrito' : 'Suscribirse'; subBtn.className = 'btn ' + (subbed.v ? '' : 'fg');
      Journal.add('sub', w.chId, subbed.v ? 'add' : 'del', { n: w.channel, a: w.ava });
      if (YT.connected()) YT.subscribe(w.chId, subbed.v).catch(e => toast('YouTube no aceptó el cambio: ' + e.message));
      sideSubs();
    } }, subbed.v ? 'Suscrito' : 'Suscribirse');
    ownerEl.replaceChildren(h('a', { href: '#/channel/' + w.chId }, w.ava ? h('img.ava', { src: w.ava, alt: '' }) : h('div.ava')),
      h('div', { style: { minWidth: 0 } }, h('a', { href: '#/channel/' + w.chId }, h('b', null, w.channel)), h('small', null, w.subs)), w.chId ? subBtn : '');
    if (w.liked && !likeBtn.classList.contains('on')) likeBtn.classList.add('on');
    if (w.desc) { descEl.dataset.full = '1'; setDesc(w.desc, [w.views, w.date].filter(Boolean).join(' · ')); }
    // la lista en la que estás
    let queue = [];
    if (w.playlist && w.playlist.items.length) {
      const idx = w.playlist.items.findIndex(x => x.id === id);
      plBox.hidden = false;
      plBox.replaceChildren(h('b', null, w.playlist.title), h('div.related', { style: { marginTop: '8px' } }, w.playlist.items.map(x => card(x, { list, noAva: true }))));
      queue = w.playlist.items.slice(idx + 1);
    } else if (mlist) {
      const l = Journal.lists().find(x => x.id === mlist);
      if (l) { const items = l.items.map(fromMeta).filter(Boolean); const idx = items.findIndex(x => x.id === id); queue = items.slice(idx + 1); plBox.hidden = false; plBox.replaceChildren(h('b', null, l.name), h('div.related', { style: { marginTop: '8px' } }, items.map(x => card(x, { noAva: true })))); }
    }
    relEl.replaceChildren(...w.related.map(r => card(r)));
    if (!w.related.length) relEl.append(h('p.muted', null, 'YouTube no dio relacionados para este vídeo.'));
    let cont = w.relCont;
    const relMore = h('div.loadmore');
    relEl.append(relMore);
    const io = new IntersectionObserver(async es => {
      if (!es.some(e => e.isIntersecting) || !cont) return;
      const c = cont; cont = null;
      try { const r = await YT.moreRelated(c); cont = r.cont; r.items.forEach(x => relEl.insertBefore(card(x), relMore)); } catch {}
    }, { root: $('#main'), rootMargin: '400px' });
    io.observe(relMore);
    if (!queue.length) queue = w.related.filter(x => x.type === 'video' && !Journal.watched('yt:' + x.id)).slice(0, 3);
    if (Player.item && Player.keyOf(Player.item) === key) Player.setQueue(queue.map(x => ({ ...x, _list: list || '', _mlist: mlist || '' })));
    // el siguiente, preparado (empezará al momento)
    if (queue[0] && queue[0].id) setTimeout(() => prepare(queue[0].id), 4000);
  });

  // lo siguiente: a su página
  M4.on('player:next', n => {
    if (n.src === 'local') go('/watch?lid=' + encodeURIComponent(n.lid));
    else go('/watch?v=' + n.id + (n._list ? '&list=' + encodeURIComponent(n._list) : '') + (n._mlist ? '&mlist=' + n._mlist : ''));
  });

  function linkify(text) {
    const out = [];
    const re = /(https?:\/\/[^\s]+)|(\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(text.slice(last, m.index));
      if (m[1]) {
        const u = m[1];
        const yid = (u.match(/(?:youtu\.be\/|v=)([A-Za-z0-9_-]{11})/) || [])[1];
        out.push(h('a', { href: yid ? '#/watch?v=' + yid : u, target: yid ? null : '_blank', rel: 'noopener' }, u.length > 60 ? u.slice(0, 57) + '…' : u));
      } else {
        const s = M4.parseDur(m[2]);
        out.push(h('a', { href: '#', onclick: e => { e.preventDefault(); e.stopPropagation(); Player.seek(s); $('#main').scrollTop = 0; } }, m[2]));
      }
      last = re.lastIndex;
    }
    out.push(text.slice(last));
    return out;
  }

  // los canales del menú lateral
  async function sideSubs() {
    const box = $('#sideSubs');
    if (!box) return;
    const list = await YT.guideSubs().catch(() => []);
    box.replaceChildren(...(list.length ? [h('h4', null, 'Suscripciones'), ...list.slice(0, 12).map(c => h('a.sub', { href: '#/channel/' + c.id }, c.thumb ? h('img', { src: c.thumb, alt: '', loading: 'lazy' }) : icon('user'), h('span', null, c.title))), h('hr')] : []));
  }

  return { preloadHome, card, grid, infinite, skeleton, loadLocal, localCopy, localItem, download, itemMenu, channelMenu, sideSubs, toggleLater, saveToList, watchCtx: () => watchCtx, local: () => local };
})();
