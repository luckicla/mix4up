'use strict';
// El registro: cada cosa que importa entre el móvil y el PC, apuntada con
// cuándo y en qué aparato. Se guarda en un archivo (journal.json, en la
// carpeta de datos) y al sincronizar se juntan los dos registros: para cada
// cosa manda el cambio más reciente, venga de donde venga. Así lo borrado no
// vuelve, lo nuevo se copia (y se avisa), y el punto donde te quedaste es el
// último que viste, en el aparato que sea.
//
// Cada apunte: { i: "<aparato>:<n>", t: ms, d: aparato, y: tipo, k: clave, op?, v? }
//   y: 'pos'  (k: vídeo; v: {p: segundos, d: duración})   dónde te quedaste
//      'hist' (k: vídeo; op add/del; v: datos del vídeo)  lo que has visto
//      'wl'   ver más tarde · 'like' me gusta · 'hide' no me interesa (ocultos)
//      'pl'   (k: lista; op new/name/del; v: {n: nombre}) · 'plv' (k: "lista|vídeo"; op add/del; v: vídeo)
//      'sub'  (k: canal; op add/del; v: {n, a})  suscripciones sin cuenta
// La clave de un vídeo: "yt:<id>" (YouTube) o "lv:<nombre>|<tamaño>" (un vídeo tuyo).

const Journal = (() => {
  let doc = { dev: '', seq: 0, events: [] };
  let latest = new Map(); // y\u0001k → apunte
  let ready = false, saveT = 0;
  const early = [];
  const keyOf = e => e.y + '\u0001' + e.k;
  const newer = (a, b) => a.t > b.t || (a.t === b.t && a.i > b.i);

  function index(e) { const k = keyOf(e), p = latest.get(k); if (!p || newer(e, p)) latest.set(k, e); }
  function reindex() { latest = new Map(); for (const e of doc.events) index(e); }

  async function load() {
    try {
      const d = await M4.api('/api/journal');
      if (d && Array.isArray(d.events)) doc = { dev: d.dev || '', seq: +d.seq || 0, events: d.events };
    } catch {}
    if (!doc.dev) doc.dev = M4.dev;
    for (const e of doc.events) if (e.d === doc.dev) doc.seq = Math.max(doc.seq, +String(e.i).split(':')[1] || 0);
    reindex();
    ready = true;
    for (const e of early.splice(0)) push(e);
    M4.emit('journal');
  }
  function save(now) {
    clearTimeout(saveT);
    const go = () => { saveT = 0; return fetch('/api/journal', { method: 'PUT', body: JSON.stringify(doc), keepalive: doc.events.length < 2000 }).catch(() => {}); };
    if (now) return go();
    saveT = setTimeout(go, 800);
  }
  addEventListener('pagehide', () => { if (saveT) save(true); });

  function push(e) {
    if (!ready) { early.push({ ...e, t: e.t || Date.now() }); return; }
    doc.seq++;
    const ev = { i: doc.dev + ':' + doc.seq, t: e.t || Date.now(), d: doc.dev, ...e };
    doc.events.push(ev);
    index(ev);
    if (doc.events.length > 30000) { doc.events = [...latest.values()].sort((a, b) => a.t - b.t).slice(-25000); reindex(); }
    save();
    M4.emit('journal', ev);
  }

  const add = (y, k, op, v) => push(op ? { y, k, op, v } : { y, k, v });
  const get = (y, k) => latest.get(y + '\u0001' + k);
  const isOn = (y, k) => { const e = get(y, k); return !!e && e.op === 'add'; };
  const toggle = (y, k, v) => { const on = !isOn(y, k); add(y, k, on ? 'add' : 'del', v); return on; };

  // todos los apuntes vivos de un tipo, el más reciente primero
  function all(y) {
    const out = [];
    for (const e of latest.values()) if (e.y === y && e.op === 'add') out.push(e);
    return out.sort((a, b) => b.t - a.t);
  }

  /* ---------- dónde te quedaste ---------- */
  const lastPos = {};
  function setPos(key, p, d, force) {
    if (!key || !(d > 0)) return;
    const prev = lastPos[key];
    // como mucho cada 15 s (y siempre al pausar o salir)
    if (!force && prev && Math.abs(prev - p) < 15) return;
    lastPos[key] = p;
    add('pos', key, null, { p: Math.round(p), d: Math.round(d) });
  }
  function pos(key) { const e = get('pos', key); return e && e.v ? { p: e.v.p, d: e.v.d, t: e.t } : null; }
  // para la barrita roja de las miniaturas: lo visto (0..1), si se empezó
  function watched(key) {
    const p = pos(key);
    if (!p || !(p.d > 0) || p.p < 5) return 0;
    return Math.min(1, p.p / p.d > 0.95 ? 1 : p.p / p.d);
  }

  /* ---------- listas ---------- */
  function lists() {
    const out = [];
    for (const e of latest.values()) {
      if (e.y !== 'pl' || e.op === 'del') continue;
      out.push({ id: e.k, name: (e.v && e.v.n) || 'Lista', t: e.t, items: [] });
    }
    const by = new Map(out.map(l => [l.id, l]));
    for (const e of latest.values()) {
      if (e.y !== 'plv' || e.op !== 'add') continue;
      const [lid] = e.k.split('|');
      const l = by.get(lid);
      if (l) l.items.push({ ...(e.v || {}), _t: e.t });
    }
    for (const l of out) l.items.sort((a, b) => a._t - b._t);
    return out.sort((a, b) => b.t - a.t);
  }
  function newList(name) {
    const id = 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    add('pl', id, 'new', { n: name });
    return id;
  }
  const renameList = (id, name) => add('pl', id, 'name', { n: name });
  const deleteList = id => add('pl', id, 'del');
  const inList = (lid, key) => isOn('plv', lid + '|' + key);
  const setInList = (lid, meta, on) => add('plv', lid + '|' + meta.key, on ? 'add' : 'del', meta);

  /* ---------- lo que llega del otro aparato ---------- */
  function absorb(events) {
    if (!Array.isArray(events)) return 0;
    const have = new Set(doc.events.map(e => e.i));
    let n = 0;
    for (const e of events) {
      if (!e || !e.i || !e.y || have.has(e.i)) continue;
      have.add(e.i);
      doc.events.push(e);
      index(e);
      n++;
    }
    if (n) { save(); M4.emit('journal'); }
    return n;
  }
  // lo nuevo que hizo otro aparato desde `since` (para avisar)
  function freshFrom(since) {
    const out = { lists: 0, later: 0, likes: 0, seen: 0 };
    for (const e of latest.values()) {
      if (e.d === doc.dev || e.t <= since || e.op !== 'add') continue;
      if (e.y === 'plv') out.lists++;
      else if (e.y === 'wl') out.later++;
      else if (e.y === 'like') out.likes++;
      else if (e.y === 'hist') out.seen++;
    }
    return out;
  }

  // los datos de un vídeo que se guardan con él (para enseñarlo sin preguntar a nadie)
  function meta(v) {
    return { key: v.key || (v.id ? 'yt:' + v.id : ''), id: v.id || '', lid: v.lid || '', title: v.title || '', ch: v.channel || v.ch || '',
      chId: v.channelId || v.chId || '', thumb: v.thumb || '', dur: v.dur || v.duration || 0, src: v.src || (v.lid ? 'local' : 'yt') };
  }

  return { load, add, get, isOn, toggle, all, setPos, pos, watched, lists, newList, renameList, deleteList, inList, setInList,
    absorb, freshFrom, meta, events: () => doc.events, dev: () => doc.dev, saveNow: () => save(true) };
})();
