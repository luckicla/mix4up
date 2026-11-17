'use strict';
// Móvil ↔ PC por la WiFi de casa: el registro (lo visto, dónde te quedaste,
// listas, ocultos…), el aspecto si se quiere, y «Seguir aquí» (lo que ves en
// un aparato, sigue en el otro en el mismo punto).
//
// El PC abre una puerta en la red (solo si lo pides) y enseña un QR con un
// código de un solo uso; el móvil lo escanea (o lo escribe) y se queda con una
// clave para las siguientes veces.

const Sync = (() => {
  const { h, icon, api, toast, Settings, ANDROID } = M4;
  const pc = () => Settings.get().pc || null;
  const paired = () => !!(ANDROID && pc() && pc().token);

  /* ---------- el móvil habla con el PC ---------- */
  let host = null; // la dirección del PC que contestó la última vez
  async function lan(path, opts = {}, timeout = 6000) {
    const p = pc();
    if (!p) throw new Error('No hay ningún PC conectado');
    const hosts = host ? [host, ...p.hosts.filter(x => x !== host)] : p.hosts;
    let last;
    for (const hh of hosts) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(`http://${hh}:${p.port}${path}`, { ...opts, signal: ctl.signal, headers: { Authorization: 'Bearer ' + p.token, ...(opts.headers || {}) } });
        clearTimeout(t);
        if (r.status === 401) throw Object.assign(new Error('El PC ya no reconoce este móvil. Vuelve a conectarlo.'), { unpaired: true });
        if (!r.ok) throw new Error('El PC contestó ' + r.status);
        host = hh;
        return r.status === 204 ? null : r.headers.get('content-type')?.includes('json') ? r.json() : r.text();
      } catch (e) { clearTimeout(t); last = e; if (e.unpaired) throw e; }
    }
    throw last && last.name === 'AbortError' ? new Error('No encuentro el PC. ¿Está encendido, con Mix4Up abierto y en la misma WiFi?') : last;
  }

  let syncing = false, lastSync = 0;
  async function syncNow(manual) {
    if (!paired() || syncing) return;
    syncing = true;
    try {
      const before = Date.now();
      const since = M4.store.get('syncAt', Date.now() - 864e5);
      const theirs = await lan('/lan/journal');
      Journal.absorb(theirs.events || []);
      await lan('/lan/journal', { method: 'PUT', body: JSON.stringify({ events: Journal.events() }), headers: { 'Content-Type': 'application/json' } }, 20000);
      // el aspecto
      if (Settings.get().syncLook) {
        const st = await lan('/lan/state');
        const look = st.look || {};
        if ((look.lookVer || 0) > (Settings.get().lookVer || 0)) Settings.set(look);
        else if ((Settings.get().lookVer || 0) > (look.lookVer || 0)) {
          const mine = {}; for (const k of ['theme', 'accent', 'accent2', 'radius', 'density', 'font', 'lookVer']) mine[k] = Settings.get()[k];
          await lan('/lan/state', { method: 'PUT', body: JSON.stringify({ look: mine }), headers: { 'Content-Type': 'application/json' } });
        }
      }
      lastSync = before;
      M4.store.set('syncAt', before);
      announce(since);
      if (manual) toast('Sincronizado con ' + (pc().name || 'el PC'));
      M4.emit('synced');
    } catch (e) {
      if (manual) toast(e.message, { ms: 5000 });
      if (e.unpaired) { Settings.set({ pc: null }); }
    } finally { syncing = false; }
  }
  // lo nuevo que llegó del otro lado, dicho
  function announce(since) {
    const f = Journal.freshFrom(since);
    const parts = [];
    if (f.lists) parts.push(f.lists + (f.lists === 1 ? ' vídeo nuevo en tus listas' : ' vídeos nuevos en tus listas'));
    if (f.later) parts.push(f.later + ' en Ver más tarde');
    if (f.likes) parts.push(f.likes + ' con me gusta');
    if (parts.length) toast((ANDROID ? 'Del PC: ' : 'Del móvil: ') + parts.join(', '), { ms: 5000 });
  }

  async function pair(hosts, port, code, name) {
    for (const hh of hosts) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
        const r = await fetch(`http://${hh}:${port}/lan/pair`, { method: 'POST', body: JSON.stringify({ code, name: M4.deviceName() }), signal: ctl.signal, headers: { 'Content-Type': 'application/json' } });
        clearTimeout(t);
        if (!r.ok) { toast((await r.text()).trim() || 'El PC no aceptó el código', { ms: 5000 }); return false; }
        const j = await r.json();
        Settings.set({ pc: { hosts, port, token: j.token, name: j.name || name || 'PC' } });
        host = hh;
        toast('¡Conectado con ' + (j.name || 'el PC') + '!');
        syncNow();
        return true;
      } catch {}
    }
    toast('No encuentro el PC en esta WiFi. Mira que los dos estén en la misma red.', { ms: 6000 });
    return false;
  }
  const parseCode = text => {
    const p = String(text).trim().split(';');
    if (p[0] !== 'MIX4UP1' || p.length < 4) return null;
    return { hosts: p[1].split(',').filter(Boolean), port: +p[2], code: p[3], name: p.slice(4).join(';') };
  };
  function loadScript(src) { return new Promise((ok, ko) => { if (document.querySelector(`script[src="${src}"]`)) return ok(); const s = h('script', { src }); s.onload = ok; s.onerror = ko; document.head.append(s); }); }

  async function scan() {
    let stream, stop = false;
    const video = h('video', { playsinline: true, muted: true, style: { width: '100%', borderRadius: '12px', background: '#000' } });
    const msg = h('p', null, 'Apunta al código QR que sale en el PC (Ajustes → Conectar el móvil).');
    const close = M4.modal((box, c) => { box.append(h('h2', null, 'Escanear el código del PC'), video, msg, h('div.btns', null, h('button.btn.ghost', { onclick: () => c() }, 'Cancelar'))); },
      { onClose: () => { stop = true; stream && stream.getTracks().forEach(t => t.stop()); } });
    try {
      await loadScript('vendor/jsQR.js');
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch { msg.textContent = 'No puedo usar la cámara. Dale permiso a Mix4Up o escribe el código.'; return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const c = document.createElement('canvas'), x = c.getContext('2d', { willReadFrequently: true });
    const tick = async () => {
      if (stop) return;
      if (video.videoWidth) {
        const w = 480, hh = Math.round(video.videoHeight * w / video.videoWidth);
        c.width = w; c.height = hh;
        x.drawImage(video, 0, 0, w, hh);
        const hit = window.jsQR(x.getImageData(0, 0, w, hh).data, w, hh, { inversionAttempts: 'dontInvert' });
        const info = hit && parseCode(hit.data);
        if (info) { stop = true; msg.textContent = 'Conectando…'; await pair(info.hosts, info.port, info.code, info.name); close(); return; }
      }
      requestAnimationFrame(tick);
    };
    tick();
  }
  async function typeCode() {
    const t = await M4.prompt('Escribe lo que pone en el PC', '', 'Conectar', 'Ej.: 192.168.1.20 482913');
    if (!t) return;
    const m = t.match(/(\d{1,3}(?:\.\d{1,3}){3})\D+(\d{6})/);
    if (!m) { toast('Pon la dirección y el código de 6 cifras, como sale en el PC', { ms: 4000 }); return; }
    pair([m[1]], 47824, m[2], '');
  }

  /* ---------- el PC ---------- */
  async function lanState(q) { return api('/api/lan' + (q ? '?do=' + q : ''), q ? { method: 'POST' } : {}); }
  async function openPair(box) {
    let st;
    try { st = await lanState('pair'); } catch (e) { toast(e.message || 'No se pudo abrir la conexión', { ms: 5000 }); return; }
    if (!st.ips.length) { toast('Este PC no está conectado a ninguna red'); await lanState('cancel'); return; }
    await loadScript('vendor/qrcode.js');
    const q = qrcode(0, 'M'); q.addData(`MIX4UP1;${st.ips.join(',')};${st.port};${st.code};${st.name}`); q.make();
    const n0 = st.devices.length;
    let poll = 0;
    const close = M4.modal((b, c) => {
      b.append(h('h2', null, 'Conectar el móvil'), h('p', null, 'En Mix4Up del móvil: Ajustes → Conectar con el PC → Escanear. O escribe esto:'),
        h('div.qr', { html: q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) }), h('div.code', null, st.ips[0] + '  ·  ' + st.code),
        h('p', { style: { fontSize: '12px' } }, 'Si Windows pregunta por el cortafuegos, pulsa «Permitir» (redes privadas).'),
        h('div.btns', null, h('button.btn.ghost', { onclick: () => c() }, 'Cancelar')));
    }, { onClose: done => { clearInterval(poll); if (!done) lanState('cancel').catch(() => {}); paintSettings(box); } });
    poll = setInterval(async () => {
      try {
        const s = await lanState();
        if (s.devices.length > n0) { clearInterval(poll); close(true); toast('¡Conectado con ' + s.devices[s.devices.length - 1].name + '!'); }
        else if (!s.code) { clearInterval(poll); close(); toast('El código ha caducado'); }
      } catch {}
    }, 1500);
  }

  async function paintSettings(box) {
    if (ANDROID) {
      const p = pc();
      box.replaceChildren(p
        ? h('div.set', null, h('span', null, 'Conectado con ' + p.name, h('small', null, lastSync ? 'Última sincronización: ' + M4.ago(lastSync) : 'Se sincroniza solo cuando estáis en la misma WiFi')),
          h('div.btns', null, h('button.btn.acc', { onclick: () => syncNow(true) }, 'Sincronizar ahora'), h('button.btn.ghost', { onclick: async () => { if (await M4.confirm('¿Olvidar el PC?', '', 'Olvidar')) { Settings.set({ pc: null }); paintSettings(box); } } }, 'Olvidar')))
        : h('div.set', null, h('span', null, 'Ningún PC conectado', h('small', null, 'En el PC: Mix4Up → Ajustes → Conectar el móvil.')),
          h('div.btns', null, h('button.btn.acc', { onclick: scan }, 'Escanear el código'), h('button.btn', { onclick: typeCode }, 'Escribirlo'))));
      return;
    }
    let st;
    try { st = await lanState(); } catch (e) { box.replaceChildren(h('p.muted', null, e.message)); return; }
    box.replaceChildren(...st.devices.map((d, i) => h('div.set', null, h('span', null, d.name, h('small', null, Date.now() / 1000 - d.seen < 300 ? 'Conectado ahora' : 'Visto ' + M4.ago(d.seen * 1000))),
      h('button.btn.ghost', { onclick: async () => { if (await M4.confirm('¿Olvidar este móvil?', 'Dejará de sincronizarse con este PC.', 'Olvidar')) { await lanState('forget&i=' + i); paintSettings(box); } } }, 'Olvidar'))),
      h('div.set', null, h('span', null, st.devices.length ? 'Conectar otro móvil' : 'Ningún móvil conectado', h('small', null, 'Instala Mix4Up en el móvil (la web de Mix4Up tiene el APK) y escanea el código.')),
        h('button.btn.acc', { onclick: () => openPair(box) }, 'Conectar un móvil')));
  }

  // el PC: el móvil cambió algo → se trae aquí
  let lanVer = null;
  async function watchPC() {
    try {
      const st = await lanState();
      if (lanVer !== null && st.ver !== lanVer) {
        const since = M4.store.get('syncAt', Date.now() - 864e5);
        const j = await api('/api/journal');
        Journal.absorb(j.events || []);
        M4.store.set('syncAt', Date.now());
        announce(since);
        const s = await api('/api/settings');
        if (Settings.get().syncLook && (s.lookVer || 0) > (Settings.get().lookVer || 0)) {
          const look = {}; for (const k of ['theme', 'accent', 'accent2', 'radius', 'density', 'font', 'lookVer']) if (k in s) look[k] = s[k];
          Settings.set(look);
        }
        M4.emit('synced');
      }
      lanVer = st.ver;
      return st.devices.length > 0;
    } catch { return false; }
  }

  /* ---------- «Seguir aquí» ---------- */
  let others = null, pausedAck = 0;
  function myNow() {
    const it = Player.item;
    if (!it) return null;
    return { src: it.src, id: it.id || it._yt || '', lid: it.lid || '', key: Player.keyOf(it), title: it.title || '', thumb: it.thumb || '', channel: it.channel || '',
      t: Math.floor(Player.time), dur: Math.floor(Player.duration), playing: Player.playing, at: Date.now(), from: M4.deviceName() };
  }
  async function reportNow() {
    const now = myNow();
    if (!now) return;
    const body = JSON.stringify({ dev: M4.dev, now });
    try {
      if (ANDROID) { if (paired()) await lan('/lan/now', { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } }, 4000); }
      else await api('/api/now', { method: 'PUT', body });
    } catch {}
  }
  async function readNow() {
    let map = {};
    try { map = ANDROID ? (paired() ? await lan('/lan/now', {}, 4000) : {}) : await api('/api/now'); } catch { return; }
    // ¿me piden que pare? (sigue en el otro aparato)
    const pr = map[M4.dev + '#pause'];
    if (pr && pr.at > pausedAck) { pausedAck = pr.at; if (Player.playing && Date.now() - pr.at < 60000) { Player.pause(); toast('Sigues viéndolo en ' + (pr.from || 'el otro aparato')); } }
    const cand = Object.entries(map).filter(([d, n]) => !d.includes('#') && d !== M4.dev && n && n.at && Date.now() - n.at < 3 * 3600e3).sort((a, b) => b[1].at - a[1].at)[0];
    others = cand ? { dev: cand[0], ...cand[1] } : null;
    const b = document.getElementById('btnHandoff');
    if (b) {
      const show = others && !(Player.item && Player.keyOf(Player.item) === others.key);
      b.hidden = !show;
      if (show) b.title = 'Seguir aquí: «' + others.title + '» (' + M4.dur(others.t) + ', en ' + (others.from || 'el otro aparato') + ')';
    }
  }
  async function continueHere() {
    const o = others;
    if (!o) return;
    const body = JSON.stringify({ dev: o.dev + '#pause', now: { at: Date.now(), from: M4.deviceName() } });
    try { if (ANDROID) await lan('/lan/now', { method: 'PUT', body, headers: { 'Content-Type': 'application/json' } }); else await api('/api/now', { method: 'PUT', body }); } catch {}
    const t = o.t || 0;
    if (o.src === 'yt' || o.id) { M4.go('/watch?v=' + o.id + '&t=' + t); return; }
    // un vídeo de los tuyos: ¿está también aquí?
    const loc = await Views.loadLocal().catch(() => ({ videos: [] }));
    const here = loc.videos.find(v => v.key === o.key);
    if (here) { M4.go('/watch?lid=' + encodeURIComponent(here.id) + '&t=' + t); return; }
    if (ANDROID && paired()) { M4.go('/watch?pc=' + encodeURIComponent(o.lid) + '&t=' + t); return; }
    toast('Ese vídeo está solo en el móvil');
  }

  // los vídeos del PC, vistos desde el móvil
  let pcList = null;
  async function pcVideos() {
    const st = await lan('/lan/state', {}, 8000);
    const p = pc();
    pcList = (st.videos || []).map(v => ({ ...Views.localItem(v), remote: `http://${host}:${p.port}/lan/video/${v.id}?t=${p.token}`, thumb: v.thumb ? `http://${host}:${p.port}/lan/thumb/${v.id}?t=${p.token}` : '', channel: 'En ' + (st.name || 'el PC') }));
    return pcList;
  }
  async function pcVideo(lid) {
    if (!pcList) await pcVideos();
    const v = pcList.find(x => x.lid === lid);
    if (!v) throw new Error('Ese vídeo ya no está en el PC');
    return v;
  }

  function start() {
    document.getElementById('btnHandoff')?.addEventListener('click', continueHere);
    if (ANDROID) {
      setTimeout(() => syncNow(), 4000);
      setInterval(() => syncNow(), 90e3);
      M4.on('journal', M4.debounce(() => syncNow(), 8000));
    } else {
      watchPC();
      setInterval(watchPC, 8000);
    }
    setInterval(() => { if (Player.playing) reportNow(); }, 10000);
    M4.on('player:open', () => setTimeout(reportNow, 3000));
    setInterval(readNow, 15000);
    setTimeout(readNow, 3000);
  }

  // la sesión de YouTube del PC pasa al móvil (solo entre tus aparatos, por tu WiFi)
  async function pullAccount() {
    let text;
    try { text = await lan('/lan/account', {}, 8000); }
    catch (e) { if (/ 404$/.test(e.message)) throw new Error('En el PC aún no has conectado YouTube. Conéctalo allí primero.'); throw e; }
    if (!text || !/youtube\.com/.test(text)) throw new Error('En el PC aún no has conectado YouTube. Conéctalo allí primero.');
    const r = await api('/api/yt/cookies', { method: 'POST', body: text });
    if (r && r.connected === false) throw new Error('La sesión del PC no sirvió. Vuelve a conectar YouTube en el PC.');
  }

  return { start, syncNow, paired, paintSettings, pcVideos, pcVideo, continueHere, pullAccount };
})();
