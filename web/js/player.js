'use strict';
// El reproductor de Mix4Up: tus vídeos y los de YouTube (sin anuncios).
//
// Los vídeos de YouTube en buena calidad vienen en dos partes (la imagen por
// un lado y el sonido por otro): Mix4Up las reproduce a la vez, con el sonido
// mandando y la imagen siguiéndolo. Con la pantalla apagada o en segundo plano
// solo sigue el sonido (ahorra batería y datos) y al volver la imagen se pone
// en su sitio.

const Player = (() => {
  const { h, icon, dur, Settings, api, toast, ANDROID, DESKTOP } = M4;
  const A = window.Mix4UpAndroid;

  /* ---------- la pieza ---------- */
  const video = h('video', { playsinline: true, preload: 'auto', crossorigin: 'anonymous' });
  const audio = h('audio', { preload: 'auto' });
  video.setAttribute('playsinline', '');
  video.disableRemotePlayback = true;
  const poster = h('div.poster');
  const big = h('div.big', null, icon('play'));
  const loading = h('div.loading');
  const ripL = h('div.ripple.l'), ripR = h('div.ripple.r');
  const hud = h('div.hud');
  const ptitle = h('div.ptitle');
  const audioMode = h('div.audiomode', null, icon('vol'), h('b', null, 'Solo sonido'), h('small', null, 'Toca para ver la imagen'));
  const fill = h('div.fill'), buf = h('div.buf'), knob = h('div.knob'), tip = h('div.tip'), abBand = h('div.ab', { hidden: true });
  const track = h('div.track', null, buf, abBand, fill);
  const bar = h('div.bar', null, track, knob, tip);
  const bPlay = h('button.ib', { 'aria-label': 'Reproducir', title: 'Reproducir (k)' }, icon('play'));
  const bNext = h('button.ib', { 'aria-label': 'Siguiente', title: 'Siguiente (Mayús+N)' }, icon('next'));
  const bMute = h('button.ib', { 'aria-label': 'Silenciar', title: 'Silenciar (m)' }, icon('vol'));
  const volIn = h('input', { type: 'range', min: 0, max: 1, step: 0.02, value: 1, 'aria-label': 'Volumen' });
  const time = h('span.time', null, '0:00 / 0:00');
  const tagTimer = h('span.tag.timer', { hidden: true, title: 'Temporizador para dormir' });
  const tagAB = h('span.tag', { hidden: true, title: 'Repetir un tramo' }, 'A-B');
  const tagSpeed = h('span.tag', { hidden: true, title: 'Velocidad' });
  const bCC = h('button.ib.hide-mini', { 'aria-label': 'Subtítulos', title: 'Subtítulos (c)' }, icon('cc'));
  const bGear = h('button.ib', { 'aria-label': 'Ajustes del vídeo', title: 'Calidad, velocidad, temporizador…' }, icon('gear'));
  const bPip = h('button.ib.hide-mini', { 'aria-label': 'Imagen dentro de imagen', title: 'Imagen dentro de imagen (i)' }, icon('pip'));
  const bTheater = h('button.ib.hide-mini', { 'aria-label': 'Modo cine', title: 'Modo cine (t)' }, h('span', { style: { fontSize: '12px', fontWeight: 800 } }, '▭'));
  const bFS = h('button.ib.hide-mini.fsb', { 'aria-label': 'Pantalla completa', title: 'Pantalla completa (f)' }, icon('fs'));
  const row = h('div.row', null, bPlay, bNext, h('span.volwrap', null, bMute, h('span.vol', null, volIn)), time,
    h('span.grow'), tagTimer, tagAB, tagSpeed, bCC, bGear, bPip, bTheater, bFS);
  const ctrls = h('div.ctrls', null, bar, row);
  const menu = h('div.menu', { hidden: true });
  // en el móvil, como YouTube: los botones grandes en el centro, subtítulos y ajustes arriba,
  // y una rayita del progreso siempre a la vista
  const mBack = h('button.ib.mc', { 'aria-label': 'Vídeo anterior' }, icon('prev'));
  const mPlay = h('button.ib.mc.mbig', { 'aria-label': 'Reproducir' }, icon('play'));
  const mNext = h('button.ib.mc', { 'aria-label': 'Siguiente' }, icon('next'));
  const center = h('div.mcenter', null, mBack, mPlay, mNext);
  const mCC = h('button.ib', { 'aria-label': 'Subtítulos' }, icon('cc'));
  const mGear = h('button.ib', { 'aria-label': 'Ajustes del vídeo' }, icon('gear'));
  const mAuto = h('button.ib.mauto', { 'aria-label': 'Reproducción automática', title: 'Reproducción automática' }, h('span.sw2'));
  const topR = h('div.mtop', null, mAuto, mCC, mGear);
  const thin = h('div.thin', null, h('i'));
  const x2 = h('div.x2', null, h('b', null, '2×'), h('span.chev', null, h('i'), h('i'), h('i')));
  const ripIn = side => h('div', null, h('span.chev' + (side < 0 ? '.rev' : ''), null, h('i'), h('i'), h('i')), h('b'));
  ripL.append(ripIn(-1)); ripR.append(ripIn(1));
  const el = h('div.player.paused', { tabindex: 0 }, video, poster, audioMode, h('div.shade.topshade'), h('div.shade'), ripL, ripR, ptitle, big, loading, hud, center, topR, ctrls, thin, x2, menu);
  el.append(audio);
  audio.hidden = true;

  /* ---------- estado ---------- */
  let item = null;        // lo que suena
  let info = null;        // lo que yt-dlp dijo del vídeo de YouTube
  let split = false;      // imagen y sonido por separado
  let compat = false, offset = 0; // un vídeo pasado a MP4 al vuelo (los AVI…): empieza en offset
  let want = false;       // la persona quiere que suene
  let qual = null;        // { v: formato de imagen, a: formato de sonido, label }
  let ab = { a: null, b: null };
  let queue = [];         // lo siguiente
  let tries = 0, loadSeq = 0, histDone = false, ytMarked = false, startedAt = 0;
  let audioOnly = false, subsOn = false, subTracks = [], curSub = null;
  let sleep = null;       // { end: ms | 'video', action }
  let twin = false;       // en segundo plano: el sonido sigue por su cuenta (el vídeo, en pausa)
  let pendingStart = 0;
  const backStack = [];   // lo que viste antes (botón «anterior»)
  let goingBack = false;
  const master = () => split ? audio : video;

  const keyOf = it => it ? (it.src === 'local' ? it.key : 'yt:' + it.id) : '';
  const now = () => compat ? offset + video.currentTime : master().currentTime;
  const total = () => { const d = compat ? 0 : master().duration; return isFinite(d) && d > 0 ? d : (item && item.dur) || (info && info.duration) || 0; };

  /* ---------- abrir ---------- */
  async function open(it, opts = {}) {
    const seq = ++loadSeq;
    if (item && !goingBack && keyOf(item) !== keyOf(it)) { backStack.push(item); if (backStack.length > 30) backStack.shift(); }
    goingBack = false;
    stopAll();
    item = { ...it };
    info = null; split = false; twin = false; pendingStart = 0; compat = false; cacheP = 0; offset = 0; tries = 0; histDone = false; ytMarked = false; startedAt = 0;
    ab = { a: null, b: null }; updateAB();
    clearErr(); hideResume(); hideNextUp();
    el.classList.remove('started');
    el.classList.add('waiting');
    poster.style.backgroundImage = item.thumb ? `url("${item.thumb}")` : '';
    ptitle.textContent = item.title || '';
    want = opts.autoplay !== false;
    setPlayIcon();
    mediaSession();
    let start = opts.start || 0;
    const p = Journal.pos(keyOf(item));
    let resumed = false;
    if (!opts.start && Settings.get().resume && p && p.p > 10 && p.d && p.p < p.d - 20) { start = p.p; resumed = true; }
    try {
      if (item.src === 'local') await loadLocal(start);
      else await loadYT(start, seq);
    } catch (e) {
      if (seq !== loadSeq) return;
      showErr(e.message || String(e));
      return;
    }
    if (seq !== loadSeq) return;
    if (resumed) showResume(start);
    M4.emit('player:open', item);
  }

  function stopAll() {
    want = false;
    for (const m of [video, audio]) { try { m.pause(); m.removeAttribute('src'); m.load(); } catch {} }
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    subTracks = []; curSub = null;
  }

  // un vídeo tuyo
  async function loadLocal(start) {
    const lid = item.lid;
    let native = item.native !== false;
    if (item.remote) { // del PC, viéndolo en el móvil
      video.src = item.remote; setStart(start); playMaybe(); twinIfHidden(); return;
    }
    if (native) {
      video.src = '/video/' + lid;
      setStart(start);
      playMaybe();
      twinIfHidden();
    } else startCompat(start);
    // subtítulos de al lado o de dentro
    api('/api/subs/' + lid).then(list => {
      subTracks = (list || []).map(s => ({ label: s.name, lang: s.lang || '', url: `/subfile/${lid}/${encodeURIComponent(s.id)}` }));
      addTracks();
    }).catch(() => {});
  }
  function startCompat(t) {
    if (ANDROID) throw new Error('Este formato no se puede ver en el móvil. Pásalo a MP4 o ábrelo con otra app.');
    compat = true; offset = t || 0;
    video.src = '/compat/' + item.lid + '?t=' + offset.toFixed(1);
    playMaybe();
  }

  // un vídeo de YouTube
  async function loadYT(start, seq) {
    // ¿descargado? entonces del archivo (sin internet)
    const local = Views.localCopy && Views.localCopy(item.id);
    if (local) {
      const li = Views.localItem(local);
      item = { ...item, src: 'local', lid: local.id, key: 'yt:' + item.id, native: local.native, _yt: item.id, title: item.title || li.title, thumb: item.thumb || li.thumb, dur: local.dur };
      ptitle.textContent = item.title;
      setTimeout(() => M4.emit('player:info', { title: item.title, channel: item.channel || '', description: 'Lo estás viendo desde tu copia descargada (sin internet).' }), 0);
      return loadLocal(start);
    }
    info = await api('/api/yt/video?id=' + item.id + (tries > 1 ? '&fresh=1' : ''));
    if (seq !== loadSeq) return;
    item.title = item.title || info.title; item.channel = item.channel || info.channel; item.chId = item.chId || info.channelId;
    item.dur = info.duration || item.dur; item.thumb = item.thumb || info.thumb;
    ptitle.textContent = item.title;
    mediaSession();
    M4.emit('player:info', info);
    if (info.live) throw new Error('Los directos aún no se pueden ver con el reproductor de Mix4Up.');
    qual = pickQuality(Settings.get().quality);
    applyQuality(start);
    subTracks = (info.subs || []).map(s => ({ label: (s.name || s.lang) + (s.auto ? ' (automáticos)' : ''), lang: s.lang.replace('-orig', ''), auto: s.auto,
      url: `/api/yt/sub?id=${item.id}&lang=${encodeURIComponent(s.lang)}&auto=${s.auto ? 1 : 0}` }));
    addTracks();
  }

  const canPlay = t => { try { return !!video.canPlayType(t); } catch { return false; } };
  const codecOK = f => {
    const c = (f.vcodec || '').split('.')[0];
    if (c === 'avc1') return true;
    if (c === 'vp09' || c === 'vp9') return canPlay('video/webm; codecs="vp9"');
    if (c === 'av01') return canPlay('video/mp4; codecs="av01.0.05M.08"');
    return false;
  };
  const codecRank = (f, height) => {
    const c = (f.vcodec || '').split('.')[0];
    if (height <= 1080) return c === 'avc1' ? 0 : c.startsWith('vp') ? 1 : 2;
    return c.startsWith('vp') ? 0 : c === 'av01' ? 1 : 2;
  };
  function heights() {
    if (!info) return [];
    const hs = new Set();
    for (const f of info.formats) if ((f.kind === 'v' || f.kind === 'av') && f.h && codecOK(f)) hs.add(f.h);
    return [...hs].sort((a, b) => b - a);
  }
  function bestAudio() {
    const as = info.formats.filter(f => f.kind === 'a' && (f.ext === 'm4a' || (f.ext === 'webm' && canPlay('audio/webm; codecs="opus"'))));
    if (!as.length) return null;
    const orig = as.filter(f => /original|default/i.test(f.note || ''));
    const pool = orig.length ? orig : as.filter(f => !f.lang || f.lang.startsWith('es')).length ? as.filter(f => !f.lang || f.lang.startsWith('es')) : as;
    // (en el móvil, el más ligero de los buenos)
    return pool.sort((a, b) => (ANDROID ? (a.ext === 'm4a' ? -1 : 1) - (b.ext === 'm4a' ? -1 : 1) : 0) || (b.tbr || 0) - (a.tbr || 0))[0];
  }
  function pickQuality(q) {
    const hs = heights();
    let target;
    if (q === 'auto' || !q) {
      const want2 = Math.max(360, Math.round((el.clientHeight || 400) * (devicePixelRatio || 1)));
      const cap = +Settings.get().qualityCap || 1080;
      target = hs.filter(x => x <= cap).sort((a, b) => a - b).find(x => x >= Math.min(want2, cap)) || hs.filter(x => x <= cap)[0] || hs[hs.length - 1];
    } else target = hs.filter(x => x <= +q)[0] || hs[hs.length - 1];
    const a = bestAudio();
    const vs = info.formats.filter(f => f.kind === 'v' && f.h === target && codecOK(f)).sort((x, y) => codecRank(x, target) - codecRank(y, target) || (y.fps || 0) - (x.fps || 0) || (y.tbr || 0) - (x.tbr || 0));
    const muxed = info.formats.filter(f => f.kind === 'av' && codecOK(f)).sort((x, y) => (y.h || 0) - (x.h || 0));
    if (vs.length && a) return { v: vs[0], a, h: target, auto: q === 'auto' || !q };
    if (muxed.length) return { v: muxed[0], a: null, h: muxed[0].h, auto: false };
    throw new Error('YouTube no dio ninguna calidad que se pueda ver aquí.');
  }
  function applyQuality(start, keepTime) {
    cacheP = 0;
    const t = keepTime ? now() : start;
    const wasSplit = split && !twin;
    twin = false;
    split = !!qual.a;
    const vs = '/ytstream/' + item.id + '/' + qual.v.id;
    if (split) {
      video.muted = true;
      const as = '/ytstream/' + item.id + '/' + qual.a.id;
      if (!wasSplit || !audio.src.endsWith(as)) { audio.src = as; audio.currentTime = t || 0; }
      video.src = vs;
      setStart(t, video);
    } else {
      video.muted = !!Settings.get().muted;
      audio.removeAttribute('src'); audio.load();
      video.src = vs;
      setStart(t);
    }
    applyVolume(); applySpeed();
    playMaybe();
    if (!split) twinIfHidden();
  }
  function setStart(t, m = video) {
    if (m === video) pendingStart = t || 0;
    if (!t) return;
    const go = () => { try { m.currentTime = t; } catch {} };
    if (m.readyState >= 1) go(); else m.addEventListener('loadedmetadata', go, { once: true });
  }
  function playMaybe() {
    if (!want) return;
    const p = master().play();
    if (p && p.catch) p.catch(e => { if (e.name === 'NotAllowedError') { want = false; setPlayIcon(); } });
    if (split && !audioOnly && !bgHidden()) video.play().catch(() => {});
  }

  // con la app en segundo plano (o la pantalla apagada), el móvil para los
  // vídeos: el sonido pasa a seguir solo y la imagen se pone al día al volver
  function goTwin() {
    if (split || compat || !item || !video.getAttribute('src')) return;
    const t = video.readyState >= 1 ? video.currentTime : pendingStart;
    twin = true; split = true;
    audio.src = video.getAttribute('src');
    setStart(t, audio);
    applyVolume(); applySpeed();
    if (want) audio.play().catch(() => {});
    holding = false;
    video.pause();
  }
  function twinIfHidden() { if (ANDROID && bgHidden() && Settings.get().bgPlay !== false) goTwin(); }

  /* ---------- subtítulos ---------- */
  function addTracks() {
    for (const t of [...video.querySelectorAll('track')]) t.remove();
    subTracks.forEach((s, i) => {
      const tr = h('track', { kind: 'subtitles', label: s.label, srclang: s.lang || 'xx', src: s.url });
      tr.dataset.i = i;
      video.append(tr);
    });
    bCC.hidden = !subTracks.length;
    mCC.hidden = !subTracks.length;
    for (const tt of video.textTracks) tt.mode = 'disabled';
    if (Settings.get().subs && subTracks.length) {
      const lang = Settings.get().subLang || 'es';
      const i = Math.max(0, subTracks.findIndex(s => s.lang.startsWith(lang) && !s.auto), subTracks.findIndex(s => s.lang.startsWith(lang)));
      setSub(i >= 0 ? i : 0);
    } else setSub(-1);
  }
  function setSub(i) {
    curSub = i >= 0 ? i : null;
    [...video.textTracks].forEach((tt, k) => { tt.mode = k === i ? 'showing' : 'disabled'; });
    bCC.classList.toggle('on', i >= 0);
    mCC.classList.toggle('on', i >= 0);
  }
  function toggleSubs() {
    if (!subTracks.length) { toast('Este vídeo no tiene subtítulos'); return; }
    if (curSub != null) { setSub(-1); Settings.set({ subs: false }); }
    else { const lang = Settings.get().subLang || 'es'; const i = subTracks.findIndex(s => s.lang.startsWith(lang)); setSub(i >= 0 ? i : 0); Settings.set({ subs: true }); }
  }

  /* ---------- sincronizar imagen y sonido ---------- */
  let holding = false; // el sonido espera a que la imagen esté lista
  const bgHidden = () => document.hidden && !document.pictureInPictureElement && !document.body.classList.contains('pip');
  // un solo «director» cada 200 ms: el sonido manda, la imagen lo sigue
  setInterval(() => {
    if (!split || !item) return;
    const showVideo = !audioOnly && !bgHidden();
    if (!want) {
      holding = false;
      if (!audio.paused) audio.pause();
      if (!video.paused) video.pause();
      return;
    }
    if (showVideo && video.readyState < 3 && !video.ended) {
      // la imagen aún no puede seguir: el sonido espera (sin perder el sitio)
      if (!audio.paused) { holding = true; audio.pause(); }
      if (video.paused) video.play().catch(() => {});
      if (Math.abs(video.currentTime - audio.currentTime) > 0.5) try { video.currentTime = audio.currentTime; } catch {}
      return;
    }
    if (audio.paused && !audio.ended) { holding = false; audio.play().catch(() => {}); }
    if (!showVideo) { if (!video.paused) video.pause(); return; }
    if (audio.readyState < 3) { if (!video.paused) video.pause(); return; }
    if (video.paused && !video.ended) video.play().catch(() => {});
    const d = video.currentTime - audio.currentTime;
    const rate = audio.playbackRate;
    if (Math.abs(d) > 0.45) { try { video.currentTime = audio.currentTime + 0.08; } catch {} video.playbackRate = rate; }
    else if (Math.abs(d) > 0.05) video.playbackRate = rate * (d > 0 ? 0.94 : 1.06);
    else if (video.playbackRate !== rate) video.playbackRate = rate;
  }, 200);
  // en segundo plano solo el sonido; al volver, la imagen en su sitio
  document.addEventListener('visibilitychange', () => {
    if (!split && want) twinIfHidden();
    if (!split || audioOnly) return;
    if (bgHidden()) { holding = false; video.pause(); }
    else if (want) { try { video.currentTime = audio.currentTime; } catch {} video.play().catch(() => {}); }
  });

  /* ---------- eventos del que manda ---------- */
  for (const m of [video, audio]) {
    m.addEventListener('playing', () => { if (m !== master()) return; el.classList.add('started'); el.classList.remove('waiting'); setPlayIcon(); if (!startedAt) { startedAt = Date.now(); if (!el.classList.contains('idle')) wake(2500); } nativeNow(); });
    m.addEventListener('pause', () => { if (m !== master() || holding) return; setPlayIcon(); savePos(true); nativeNow(); });
    m.addEventListener('waiting', () => { if (m === master()) el.classList.add('waiting'); });
    m.addEventListener('canplay', () => { if (m === master()) el.classList.remove('waiting'); });
    m.addEventListener('timeupdate', () => { if (m === master()) tick(); });
    m.addEventListener('ended', () => { if (m === master()) ended(); });
    m.addEventListener('error', () => onError(m));
    m.addEventListener('progress', () => { if (m === master()) paintBuf(); });
    m.addEventListener('loadedmetadata', () => { if (m === master()) paint(); });
  }
  video.addEventListener('loadeddata', () => { if (!split) el.classList.add('started'); });

  function onError(m) {
    if (!item || !m.getAttribute('src')) return;
    if (twin && m === audio) { console.warn('segundo plano: el sonido solo no pudo seguir'); return; }
    const code = m.error ? m.error.code : 0;
    console.warn('error del vídeo', code, m.error && m.error.message);
    if (item.src === 'local' && !compat && !item.remote) {
      if (!ANDROID) { toast('Este vídeo no se abre tal cual: lo convierto mientras lo ves…'); startCompat(now()); return; }
      showErr('Este vídeo no se puede ver en el móvil (formato no compatible).');
      return;
    }
    if (item.src === 'yt' && info) {
      tries++;
      const t = now();
      if (tries === 1 && split && !twin) { // con imagen y sonido juntos (360p)
        const mux = info.formats.filter(f => f.kind === 'av' && codecOK(f)).sort((x, y) => (y.h || 0) - (x.h || 0))[0];
        if (mux) { qual = { v: mux, a: null, h: mux.h }; applyQuality(t); return; }
      }
      if (tries <= 2) { const seq = loadSeq; loadYT(t, seq).catch(e => showErr(e.message)); return; }
      showErr('YouTube no deja ver este vídeo ahora mismo.' + (m.error && m.error.message ? ' (' + m.error.message.slice(0, 120) + ')' : ''));
    }
  }

  /* ---------- pintar ---------- */
  function setPlayIcon() {
    const playing = want && (!master().paused || holding);
    el.classList.toggle('paused', !playing);
    bPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
    mPlay.replaceChildren(icon(playing ? 'pause' : 'play'));
    bPlay.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    if (ANDROID) try { A.setKeepScreenOn(playing && !audioOnly); } catch {}
  }
  function paint() {
    const t = now(), d = total();
    const pct = d ? Math.min(100, t / d * 100) : 0;
    if (!dragging) { fill.style.width = pct + '%'; knob.style.left = pct + '%'; }
    thin.firstChild.style.width = pct + '%';
    time.textContent = dur(t) + ' / ' + dur(d);
  }
  // lo que ya está bajado entero (Mix4Up se baja el vídeo en segundo plano, como YouTube)
  let cacheP = 0;
  setInterval(async () => {
    if (!item || item.src !== 'yt' || !qual || cacheP >= 1) return;
    try {
      const p = await api('/api/yt/cache?id=' + item.id);
      const v = p[qual.v.id] || 0, a = qual.a ? (p[qual.a.id] || 0) : v;
      cacheP = Math.min(v, a);
      paintBuf();
    } catch {}
  }, 1500);
  function paintBuf() {
    if (item && item.src === 'yt' && cacheP > 0) {
      const m0 = master(), d0 = total();
      let e0 = 0;
      for (let i = 0; i < m0.buffered.length; i++) if (m0.buffered.start(i) <= m0.currentTime + 1) e0 = Math.max(e0, m0.buffered.end(i));
      buf.style.width = Math.max(cacheP * 100, d0 ? e0 / d0 * 100 : 0) + '%';
      return;
    }
    const m = master(), d = total();
    if (!d || !m.buffered.length) return;
    let end = 0;
    for (let i = 0; i < m.buffered.length; i++) if (m.buffered.start(i) <= m.currentTime + 1) end = Math.max(end, m.buffered.end(i));
    buf.style.width = Math.min(100, ((compat ? offset : 0) + end) / d * 100) + '%';
  }
  let lastTick = 0;
  function tick() {
    paint();
    const t = now(), d = total();
    // repetir un tramo
    if (ab.a != null && ab.b != null && t >= ab.b) seek(ab.a);
    // lo visto y dónde te quedaste
    const key = keyOf(item);
    if (Date.now() - lastTick > 1000) {
      lastTick = Date.now();
      savePos(false);
      if (!histDone && startedAt && Date.now() - startedAt > 10000) {
        histDone = true;
        Journal.add('hist', key, 'add', Journal.meta(item));
      }
      if (!ytMarked && item.src === 'yt' && startedAt && Date.now() - startedAt > 30000 && Settings.get().markWatched) {
        ytMarked = true;
        api('/api/yt/watched?id=' + item.id, { method: 'POST' }).catch(() => {});
      }
      sleepTick();
      if (d && d - t < 12 && d - t > 0 && Settings.get().autoplay && !sleep?.end?.toString().includes('video') && queue[0]) showNextUp(queue[0], Math.ceil(d - t));
    }
  }
  function savePos(force) {
    if (!item) return;
    const t = now(), d = total();
    if (d > 0 && t > 0) Journal.setPos(keyOf(item), t, d, force);
  }
  addEventListener('pagehide', () => savePos(true));

  function ended() {
    savePos(true);
    if (sleep && sleep.end === 'video') { fireSleep(); return; }
    if (ab.a != null && ab.b == null) { seek(ab.a); return; }
    if (Settings.get().autoplay && queue[0]) next();
    else { want = false; setPlayIcon(); }
  }

  /* ---------- mandar ---------- */
  function play() { want = true; if (sleep && sleep.end === 'paused') sleep = null; playMaybe(); setPlayIcon(); }
  function pause() { want = false; holding = false; audio.pause(); video.pause(); setPlayIcon(); }
  function toggle() { if (!item) return; M4.haptic('tap'); if (want && (!master().paused || holding)) pause(); else play(); flash(want ? 'play' : 'pause'); }
  function seek(t) {
    if (!item) return;
    const d = total();
    t = Math.max(0, Math.min(d ? d - 0.3 : t, t));
    hideResume();
    if (compat) { startCompat(t); return; }
    if (split) { audio.currentTime = t; try { video.currentTime = t; } catch {} }
    else video.currentTime = t;
    paint();
  }
  const skip = s => seek(now() + s);
  function next() {
    hideNextUp();
    const n = queue.shift();
    if (n) M4.emit('player:next', n);
  }
  // «anterior», como YouTube: al principio del vídeo o, si ya va avanzado, vuelve a empezar
  function prev() {
    if (now() > 4 || !backStack.length) { seek(0); M4.haptic('tick'); return; }
    hideNextUp();
    const p = backStack.pop();
    goingBack = true;
    M4.emit('player:next', p);
  }
  function setQueue(list) { queue = (list || []).filter(Boolean); }

  function applyVolume() {
    const s = Settings.get();
    const m = master();
    m.volume = Math.max(0, Math.min(1, +s.volume));
    m.muted = !!s.muted;
    if (split) video.muted = true;
    volIn.value = s.muted ? 0 : s.volume;
    bMute.replaceChildren(icon(s.muted || s.volume == 0 ? 'mute' : 'vol'));
  }
  function setVolume(v) { Settings.set({ volume: Math.max(0, Math.min(1, v)), muted: false }, true); applyVolume(); showHud('vol', Math.round(v * 100) + '%'); }
  function toggleMute() { Settings.set({ muted: !Settings.get().muted }, true); applyVolume(); }
  let rate = 1;
  function applySpeed() {
    for (const m of [video, audio]) { m.playbackRate = rate; m.preservesPitch = true; }
    tagSpeed.hidden = rate === 1; tagSpeed.textContent = rate + '×';
  }
  function setSpeed(r) { rate = r; applySpeed(); Settings.set({ speed: r }, true); }

  function flash(name) { big.replaceChildren(icon(name)); big.classList.remove('flash'); void big.offsetWidth; big.classList.add('flash'); }
  let hudT = 0;
  function showHud(ic, text) { hud.replaceChildren(icon(ic), h('span', null, text)); hud.classList.add('show'); clearTimeout(hudT); hudT = setTimeout(() => hud.classList.remove('show'), 900); }

  /* ---------- barra de tiempo ---------- */
  let dragging = false;
  const pctAt = e => { const r = bar.getBoundingClientRect(); return Math.max(0, Math.min(1, ((e.touches ? e.touches[0].clientX : e.clientX) - r.left) / r.width)); };
  const chapterAt = t => info && info.chapters ? (info.chapters.find(c => t >= c.start && t < c.end) || {}).title || '' : '';
  bar.addEventListener('pointermove', e => {
    const p = pctAt(e), t = p * total();
    tip.style.left = p * 100 + '%';
    const ch = chapterAt(t);
    tip.textContent = dur(t) + (ch ? ' · ' + ch : '');
    if (dragging) { fill.style.width = p * 100 + '%'; knob.style.left = p * 100 + '%'; time.textContent = dur(t) + ' / ' + dur(total()); }
  });
  bar.addEventListener('pointerdown', e => {
    e.stopPropagation();
    dragging = true; bar.classList.add('drag'); bar.setPointerCapture(e.pointerId);
    const p = pctAt(e); fill.style.width = p * 100 + '%'; knob.style.left = p * 100 + '%';
  });
  bar.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false; bar.classList.remove('drag');
    seek(pctAt(e) * total());
  });
  bar.addEventListener('pointercancel', () => { dragging = false; bar.classList.remove('drag'); });
  function paintChapters() {
    for (const c of [...track.querySelectorAll('.chap')]) c.remove();
    const d = total();
    if (!info || !info.chapters || !d) return;
    for (const c of info.chapters.slice(1)) track.append(h('div.chap', { style: { left: c.start / d * 100 + '%' } }));
  }
  M4.on('player:info', () => setTimeout(paintChapters, 50));

  /* ---------- botones ---------- */
  bPlay.onclick = e => { e.stopPropagation(); toggle(); };
  mPlay.onclick = e => { e.stopPropagation(); toggle(); wake(); };
  mBack.onclick = e => { e.stopPropagation(); prev(); wake(); };
  mNext.onclick = e => { e.stopPropagation(); M4.haptic('tap'); if (queue[0]) next(); else toast('No hay siguiente'); wake(); };
  mCC.onclick = e => { e.stopPropagation(); toggleSubs(); mCC.classList.toggle('on', curSub != null); };
  mGear.onclick = e => { e.stopPropagation(); menu.hidden ? openMenu('main') : closeMenu(); };
  const paintAuto = () => mAuto.classList.toggle('on', !!Settings.get().autoplay);
  mAuto.onclick = e => { e.stopPropagation(); Settings.set({ autoplay: !Settings.get().autoplay }); paintAuto(); toast(Settings.get().autoplay ? 'Reproducción automática activada' : 'Reproducción automática desactivada'); };
  M4.on('ready', paintAuto); M4.on('settings', p => { if ('autoplay' in p) paintAuto(); });
  bNext.onclick = e => { e.stopPropagation(); if (queue[0]) next(); else toast('No hay siguiente'); };
  bMute.onclick = e => { e.stopPropagation(); toggleMute(); };
  volIn.oninput = e => { e.stopPropagation(); setVolume(+volIn.value); };
  bCC.onclick = e => { e.stopPropagation(); toggleSubs(); };
  bFS.onclick = e => { e.stopPropagation(); toggleFS(); };
  bPip.onclick = e => { e.stopPropagation(); pip(); };
  bTheater.onclick = e => { e.stopPropagation(); Settings.set({ theater: !Settings.get().theater }); };
  bGear.onclick = e => { e.stopPropagation(); menu.hidden ? openMenu('main') : closeMenu(); };
  tagTimer.onclick = e => { e.stopPropagation(); openMenu('sleep'); };
  tagAB.onclick = e => { e.stopPropagation(); ab = { a: null, b: null }; updateAB(); toast('Tramo quitado'); };
  tagSpeed.onclick = e => { e.stopPropagation(); openMenu('speed'); };
  audioMode.onclick = e => { e.stopPropagation(); setAudioOnly(false); };
  [ctrls, menu, center, topR].forEach(x => x.addEventListener('click', e => e.stopPropagation()));

  /* ---------- menú del vídeo ---------- */
  let menuClose = null;
  function closeMenu() { menu.hidden = true; if (menuClose) { menuClose(); menuClose = null; } }
  function openMenu(which) {
    menu.replaceChildren();
    menu.hidden = false;
    if (!menuClose) menuClose = M4.pushClose(closeMenu);
    const back = title => h('h5', { onclick: () => openMenu('main') }, icon('back'), title);
    const opt = (label, sel, fn, v) => h('button', { class: sel ? 'sel' : '', onclick: fn }, h('span', null, label), v ? h('span.v', null, v) : '');
    if (which === 'main') {
      const qLabel = item && item.src === 'yt' && qual ? (qual.auto ? 'Auto (' + qual.h + 'p)' : qual.h + 'p') : (compat ? 'Convertido' : 'Original');
      menu.append(
        item && item.src === 'yt' ? opt('Calidad', false, () => openMenu('quality'), qLabel) : '',
        opt('Velocidad', false, () => openMenu('speed'), rate === 1 ? 'Normal' : rate + '×'),
        subTracks.length ? opt('Subtítulos', false, () => openMenu('subs'), curSub != null ? subTracks[curSub].label : 'No') : '',
        opt('Repetir un tramo (A-B)', false, () => { abStep(); closeMenu(); }, ab.a == null ? 'Marcar inicio' : ab.b == null ? 'Marcar final' : 'Quitar'),
        opt('Temporizador para dormir', false, () => openMenu('sleep'), sleep ? sleepLabel() : 'No'),
        split ? opt('Solo sonido', audioOnly, () => { setAudioOnly(!audioOnly); closeMenu(); }) : '',
        item && item.src === 'yt' ? opt('Descargar', false, () => { closeMenu(); Views.download(item); }) : '',
      );
    } else if (which === 'quality') {
      menu.append(back('Calidad'));
      const hs = heights();
      menu.append(opt('Automática', qual && qual.auto, () => { setQuality('auto'); closeMenu(); }));
      for (const x of hs) {
        const f = info.formats.find(f => f.h === x && (f.fps || 0) > 30);
        menu.append(opt(x + 'p' + (f ? (f.fps > 50 ? '60' : '') : '') + (x >= 2160 ? ' 4K' : x >= 1440 ? ' QHD' : x >= 720 ? ' HD' : ''), qual && !qual.auto && qual.h === x, () => { setQuality(String(x)); closeMenu(); }));
      }
    } else if (which === 'speed') {
      menu.append(back('Velocidad'));
      for (const r of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) menu.append(opt(r === 1 ? 'Normal' : r + '×', r === rate, () => { setSpeed(r); closeMenu(); }));
    } else if (which === 'subs') {
      menu.append(back('Subtítulos'), opt('No', curSub == null, () => { setSub(-1); Settings.set({ subs: false }); closeMenu(); }));
      subTracks.forEach((s, i) => menu.append(opt(s.label, curSub === i, () => { setSub(i); Settings.set({ subs: true, subLang: (s.lang || 'es').slice(0, 2) }); closeMenu(); })));
      menu.append(h('h5', null, 'Tamaño'),
        h('div', { style: { display: 'flex', gap: '6px', padding: '0 16px 8px' } }, ...[80, 100, 130, 160].map(z => h('button.tag', { style: { padding: '4px 8px' }, onclick: () => { Settings.set({ subSize: z }); applyCue(); } }, z + '%'))));
    } else if (which === 'sleep') {
      menu.append(back('Temporizador para dormir'));
      if (sleep) menu.append(opt('Quitar el temporizador (' + sleepLabel() + ')', false, () => { setSleep(null); closeMenu(); }));
      for (const m of [5, 10, 15, 30, 45, 60, 90, 120]) menu.append(opt(m + ' minutos', false, () => { setSleep(m); closeMenu(); }));
      menu.append(opt('Al acabar este vídeo', sleep && sleep.end === 'video', () => { setSleep('video'); closeMenu(); }));
      menu.append(opt('Otro tiempo…', false, async () => { closeMenu(); const v = await M4.prompt('¿Cuántos minutos?', '20', 'Poner'); const n = parseInt(v, 10); if (n > 0) setSleep(n); }));
      menu.append(h('h5', null, 'Y al acabar…'));
      const act = Settings.get().sleepAction;
      menu.append(opt('Solo parar el vídeo', act === 'pause', () => { Settings.set({ sleepAction: 'pause' }); openMenu('sleep'); }));
      menu.append(opt(ANDROID ? 'Parar y cerrar Mix4Up' : 'Parar y cerrar Mix4Up', act === 'close', () => { Settings.set({ sleepAction: 'close' }); openMenu('sleep'); }));
      if (DESKTOP) menu.append(opt('Parar y apagar el PC', act === 'shutdown', () => { Settings.set({ sleepAction: 'shutdown' }); openMenu('sleep'); }));
      if (ANDROID) menu.append(h('p', { style: { margin: '6px 16px', fontSize: '12px', color: '#bbb' } }, 'Al pararse, la pantalla del móvil se apaga sola como siempre.'));
    }
  }
  function setQuality(q) {
    Settings.set({ quality: q }, true);
    if (!info) return;
    qual = pickQuality(q);
    applyQuality(0, true);
  }
  function setAudioOnly(on) {
    audioOnly = on;
    el.classList.toggle('audio', on);
    if (on) video.pause(); else if (want) { try { video.currentTime = audio.currentTime; } catch {} video.play().catch(() => {}); }
    setPlayIcon();
  }
  function applyCue() { el.style.setProperty('--cue', (Settings.get().subSize || 100) + '%'); }
  applyCue();

  /* ---------- repetir un tramo ---------- */
  function abStep() {
    const t = now();
    if (ab.a == null) { ab.a = t; toast('Inicio del tramo: ' + dur(t) + '. Vuelve a pulsar para marcar el final.'); }
    else if (ab.b == null) { if (t <= ab.a + 0.5) { toast('El final tiene que ir después del inicio'); return; } ab.b = t; toast('Repitiendo de ' + dur(ab.a) + ' a ' + dur(ab.b)); seek(ab.a); }
    else { ab = { a: null, b: null }; toast('Tramo quitado'); }
    updateAB();
  }
  function updateAB() {
    tagAB.hidden = ab.a == null;
    tagAB.textContent = ab.b == null ? 'A…' : 'A-B';
    const d = total();
    abBand.hidden = !(ab.a != null && d);
    if (!abBand.hidden) { abBand.style.left = ab.a / d * 100 + '%'; abBand.style.width = ((ab.b ?? now()) - ab.a) / d * 100 + '%'; }
  }

  /* ---------- temporizador para dormir ---------- */
  function setSleep(m) {
    if (m == null) { sleep = null; tagTimer.hidden = true; if (item && master().volume < (+Settings.get().volume || 1)) applyVolume(); toast('Temporizador quitado'); return; }
    sleep = { end: m === 'video' ? 'video' : Date.now() + m * 60e3 };
    tagTimer.hidden = false;
    sleepTick();
    M4.haptic('confirm');
    toast(m === 'video' ? 'Se parará al acabar este vídeo' : 'Se parará dentro de ' + m + ' minutos');
  }
  function sleepLabel() {
    if (!sleep) return '';
    if (sleep.end === 'video') return 'al acabar';
    return dur(Math.max(0, (sleep.end - Date.now()) / 1000));
  }
  function sleepTick() {
    if (!sleep) return;
    tagTimer.textContent = '☾ ' + sleepLabel();
    if (sleep.end === 'video') return;
    const left = (sleep.end - Date.now()) / 1000;
    // el último medio minuto, bajando el volumen poco a poco
    if (left < 30 && left > 0) master().volume = Math.max(0, (+Settings.get().volume || 1) * left / 30);
    if (left <= 0) fireSleep();
  }
  setInterval(() => { if (sleep && sleep.end !== 'video' && (master().paused || !want)) sleepTick(); }, 1000);
  async function fireSleep() {
    sleep = null; tagTimer.hidden = true;
    pause();
    savePos(true);
    applyVolume();
    const act = Settings.get().sleepAction;
    if (ANDROID) try { A.setKeepScreenOn(false); } catch {}
    if (act === 'close') {
      await Journal.saveNow();
      try { if (ANDROID) A.quitApp(); else if (DESKTOP) Mix4UpShell.quit(); } catch {}
    } else if (act === 'shutdown' && DESKTOP) {
      try {
        await api('/api/power?do=shutdown', { method: 'POST' });
        toast('El PC se apagará en 1 minuto', { action: 'Cancelar', ms: 60000, fn: () => api('/api/power?do=cancel', { method: 'POST' }).then(() => toast('Apagado cancelado')) });
      } catch (e) { toast('No se pudo apagar el PC: ' + e.message); }
    } else toast('Buenas noches: se acabó el temporizador');
  }

  /* ---------- pantalla completa, imagen dentro de imagen ---------- */
  let fsClose = null;
  function isFS() { return el.classList.contains('cssfs') || document.fullscreenElement === el; }
  function toggleFS(force) {
    const on = force != null ? force : !isFS();
    if (ANDROID) {
      el.classList.toggle('cssfs', on);
      document.body.classList.toggle('fullscreen', on);
      const land = (video.videoWidth || 16) >= (video.videoHeight || 9);
      try { A.setFullscreen(on, land); } catch {}
      if (on) fsClose = M4.pushClose(() => toggleFS(false)); else if (fsClose) { fsClose(); fsClose = null; }
    } else if (on) el.requestFullscreen().catch(() => { el.classList.add('cssfs'); document.body.classList.add('fullscreen'); fsClose = M4.pushClose(() => toggleFS(false)); });
    else if (document.fullscreenElement) document.exitFullscreen();
    else { el.classList.remove('cssfs'); document.body.classList.remove('fullscreen'); if (fsClose) { fsClose(); fsClose = null; } }
    setTimeout(updateFSIcon, 100);
  }
  function updateFSIcon() { const on = isFS(); el.classList.toggle('fs', on); bFS.replaceChildren(icon(on ? 'fsx' : 'fs')); }
  document.addEventListener('fullscreenchange', () => { updateFSIcon(); if (qual && qual.auto && info) { const q = pickQuality('auto'); if (q.h > qual.h) { qual = q; applyQuality(0, true); } } });
  async function pip() {
    if (ANDROID) { try { A.enterPip((video.videoWidth || 16), (video.videoHeight || 9)); } catch {} return; }
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else { if (audioOnly) setAudioOnly(false); if (video.paused && want) await video.play(); await video.requestPictureInPicture(); }
    } catch (e) { toast('La imagen dentro de imagen no está disponible aquí'); }
  }
  video.addEventListener('leavepictureinpicture', () => { if (split && bgHidden()) video.pause(); });
  function onPip(on) { document.body.classList.toggle('pip', !!on); }

  /* ---------- toques y ratón ---------- */
  const coarse = matchMedia('(pointer: coarse)').matches || ANDROID;
  let idleT = 0;
  // los botones se quedan a la vista un buen rato (como YouTube) y se van con calma
  function wake(ms) { el.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(() => { if (menu.hidden && !dragging) el.classList.add('idle'); else wake(); }, ms || (coarse ? 4500 : 2600)); }
  function hideCtl() { clearTimeout(idleT); el.classList.add('idle'); }
  const ctlShown = () => !el.classList.contains('idle');
  el.addEventListener('mousemove', () => { if (!touchMode) wake(); });
  el.addEventListener('mouseleave', () => { if (!master().paused) el.classList.add('idle'); });
  let touchMode = false;
  el.addEventListener('click', e => {
    if (touchMode) return;
    if (!menu.hidden) { closeMenu(); return; }
    if (!item) return;
    if (el.closest('#mini')) { M4.emit('player:expand'); return; }
    toggle();
  });
  el.addEventListener('dblclick', e => { if (!touchMode && !el.closest('#mini')) toggleFS(); });

  // en el móvil, los gestos de YouTube:
  //  · un toque: enseña u oculta los botones
  //  · dos toques a la izquierda o a la derecha: −10 / +10 s (y cada toque más, otros 10)
  //  · mantener pulsado: a 2× mientras no sueltes
  //  · deslizar hacia abajo: el vídeo baja y se queda pequeño (sigue sonando)
  //  · deslizar hacia arriba: pantalla completa; en pantalla completa, hacia abajo la quita
  //  · pellizcar en pantalla completa: llenar la pantalla o verlo entero
  const SKIP_ZONE = 0.4;
  let sx = 0, sy = 0, st = 0, ly = 0, lt = 0, vy = 0, swipe = null, holdT = 0, held = false, holdRate = 1, scrubFrom = 0, scrubTo = 0;
  let lastTap = 0, lastSide = 0, seekMode = 0, seekAcc = 0, seekT = 0, tapT = 0, pinch0 = 0, pinchK = 1;
  const BLOCK = '.ctrls button,.ctrls .bar,.ctrls .tag,.menu,.perr,.resume,.next-up,.audiomode,.mcenter button,.mtop';
  const endHold = () => { clearTimeout(holdT); if (held) { held = false; for (const m of [video, audio]) m.playbackRate = holdRate; el.classList.remove('speedup'); } };
  const watchView = () => el.closest('.watch');
  const resetDrag = (animate) => {
    const wv = watchView();
    for (const x of [el, wv]) if (x) {
      x.style.transition = animate ? 'transform .28s cubic-bezier(.2,.9,.3,1.15), opacity .2s' : '';
      x.style.transform = ''; x.style.opacity = '';
      if (animate) setTimeout(() => { x.style.transition = ''; }, 300);
    }
    document.body.classList.remove('dragdown');
  };
  el.addEventListener('touchcancel', () => { endHold(); swipe = null; resetDrag(true); hud.classList.remove('scrub'); });
  el.addEventListener('touchstart', e => {
    touchMode = true;
    if (e.touches.length === 2) { clearTimeout(holdT); endHold(); swipe = 'pinch'; pinch0 = dist(e.touches); pinchK = 1; return; }
    if (e.target.closest(BLOCK)) { swipe = 'x'; return; }
    const t = e.touches[0];
    sx = t.clientX; sy = t.clientY; ly = sy; st = lt = Date.now(); vy = 0; swipe = null;
    clearTimeout(holdT);
    if (seekMode) return;
    holdT = setTimeout(() => {
      if (swipe || !item || el.closest('#mini') || !want) return;
      held = true; holdRate = rate;
      for (const m of [video, audio]) m.playbackRate = 2;
      el.classList.add('speedup');
      hideCtl();
      M4.haptic('long');
    }, 450);
  }, { passive: true });
  const dist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  el.addEventListener('touchmove', e => {
    if (swipe === 'pinch') { if (e.touches.length === 2) { e.preventDefault(); pinchK = dist(e.touches) / (pinch0 || 1); if (isFS()) video.style.transform = `scale(${Math.max(.85, Math.min(1.25, pinchK))})`; } return; }
    if (swipe === 'x' || e.target.closest('.bar,.menu')) return;
    const t = e.touches[0], dy = t.clientY - sy, dx = t.clientX - sx;
    const n = Date.now(); if (n > lt) { vy = (t.clientY - ly) / (n - lt); ly = t.clientY; lt = n; }
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimeout(holdT);
    if (held || el.closest('#mini')) return;
    // deslizar a los lados: adelantar o atrasar (con la vista del tiempo)
    if ((swipe === 'scrub' || (!swipe && Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.7)) && item && total()) {
      e.preventDefault();
      if (swipe !== 'scrub') { swipe = 'scrub'; scrubFrom = now(); M4.haptic('tick'); wake(); }
      const span = Math.max(60, Math.min(total(), 600));
      scrubTo = Math.max(0, Math.min(total() - 1, scrubFrom + dx / el.clientWidth * span));
      hud.classList.add('scrub');
      showHud(dx < 0 ? 'prev' : 'next', dur(scrubTo) + '  (' + (dx < 0 ? '−' : '+') + dur(Math.abs(scrubTo - scrubFrom)) + ')');
      fill.style.width = (scrubTo / total() * 100) + '%'; knob.style.left = fill.style.width;
      return;
    }
    if (!swipe && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) swipe = dy > 0 ? 'down' : 'up';
    if (swipe !== 'down' && swipe !== 'up') return;
    e.preventDefault();
    if (isFS()) {
      // en pantalla completa el vídeo sigue al dedo
      el.style.transition = '';
      el.style.transform = `translateY(${dy * 0.5}px)`;
      return;
    }
    const wv = watchView();
    if (dy > 0 && wv) {
      // hacia abajo: toda la página del vídeo baja contigo y el vídeo encoge
      const H = innerHeight, k = Math.min(1, dy / (H * 0.6));
      wv.style.transition = '';
      wv.style.transform = `translateY(${dy}px)`;
      wv.style.opacity = String(1 - k * 0.55);
      el.style.transform = `scale(${1 - k * 0.35})`; el.style.transformOrigin = '100% 0';
      document.body.classList.add('dragdown');
    } else if (dy < 0) {
      el.style.transition = '';
      el.style.transform = `scale(${1 + Math.min(0.08, -dy / 1500)})`; el.style.transformOrigin = '50% 50%';
    }
  }, { passive: false });
  el.addEventListener('touchend', e => {
    clearTimeout(holdT);
    if (swipe === 'pinch') {
      if (e.touches.length) return;
      swipe = null; video.style.transform = '';
      if (isFS() && (pinchK > 1.12 || pinchK < 0.9)) setFill(pinchK > 1);
      return;
    }
    if (held) { endHold(); return; }
    if (swipe === 'scrub') { swipe = null; hud.classList.remove('scrub'); seek(scrubTo); M4.haptic('tap'); return; }
    if (swipe === 'down' || swipe === 'up') {
      const t = e.changedTouches[0], dy = t.clientY - sy, w = swipe;
      swipe = null;
      if (isFS()) {
        resetDrag(true);
        if (w === 'down' && (dy > 90 || vy > 0.6)) { M4.haptic('tick'); toggleFS(false); }
        return;
      }
      if (w === 'down' && (dy > innerHeight * 0.22 || (vy > 0.55 && dy > 40))) {
        // se va hacia abajo del todo y se queda en el mini reproductor
        M4.haptic('tick');
        const wv = watchView();
        if (wv) {
          wv.style.transition = 'transform .22s cubic-bezier(.4,0,1,1), opacity .22s';
          wv.style.transform = `translateY(${innerHeight}px)`; wv.style.opacity = '0';
        }
        setTimeout(() => {
          el.style.transform = ''; el.style.transition = ''; document.body.classList.remove('dragdown');
          M4.emit('player:minimize');
          setTimeout(() => { if (wv && wv.isConnected) resetDrag(true); }, 700);
        }, 200);
      } else if (w === 'up' && (dy < -60 || vy < -0.6)) { resetDrag(false); toggleFS(true); }
      else resetDrag(true);
      return;
    }
    if (swipe) { swipe = null; return; }
    if (el.closest('#mini')) { M4.emit('player:expand'); return; }
    if (!menu.hidden) { closeMenu(); return; }
    const t = e.changedTouches[0];
    if (Math.abs(t.clientX - sx) > 20 || Math.abs(t.clientY - sy) > 20) return;
    const r = el.getBoundingClientRect();
    const x = (t.clientX - r.left) / r.width;
    const side = x < SKIP_ZONE ? -1 : x > 1 - SKIP_ZONE ? 1 : 0;
    const n = Date.now();
    // ya saltando: cada toque en el mismo lado son otros 10 s
    if (seekMode && side === seekMode) { clearTimeout(tapT); doSkip(side); return; }
    if (side && side === lastSide && n - lastTap < 300) { clearTimeout(tapT); doSkip(side); return; }
    seekMode = 0;
    lastTap = n; lastSide = side;
    clearTimeout(tapT);
    // un toque: enseñar u ocultar los botones (en los lados espera un poco, por si es doble)
    const single = () => { if (ctlShown() && !el.classList.contains('paused')) hideCtl(); else wake(); };
    if (side) tapT = setTimeout(single, 280); else single();
  });
  function doSkip(side) {
    if (!item) return;
    if (seekMode !== side) { seekMode = side; seekAcc = 0; }
    seekAcc += 10;
    skip(side * 10);
    hideCtl();
    M4.haptic('tick');
    const rp = side < 0 ? ripL : ripR, other = side < 0 ? ripR : ripL;
    other.classList.remove('show', 'on');
    rp.querySelector('b').textContent = seekAcc + ' segundos';
    rp.classList.add('on');
    rp.classList.remove('show'); void rp.offsetWidth; rp.classList.add('show');
    clearTimeout(seekT);
    seekT = setTimeout(() => { seekMode = 0; seekAcc = 0; lastSide = 0; rp.classList.remove('on'); }, 750);
  }
  function setFill(on) {
    el.classList.toggle('fill', on);
    Settings.set({ fillScreen: on }, true);
    M4.haptic('tick');
    showHud(on ? 'expand' : 'fsx', on ? 'Ampliado para llenar la pantalla' : 'Tamaño original');
  }
  el.classList.toggle('fill', Settings.get().fillScreen !== false);
  M4.on('settings', pt => { if (pt && 'fillScreen' in pt) el.classList.toggle('fill', !!pt.fillScreen); if (pt && 'autoPip' in pt) M4.emit('watching'); });
  [ctrls, center, topR].forEach(x => x.addEventListener('touchstart', () => wake(), { passive: true }));

  /* ---------- teclado ---------- */
  document.addEventListener('keydown', e => {
    if (!item || e.ctrlKey || e.metaKey || e.altKey) return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement && document.activeElement.tagName)) return;
    if (!document.querySelector('.watch') && !isFS()) return;
    const k = e.key;
    const done = () => { e.preventDefault(); wake(); };
    if (k === ' ' || k === 'k') { toggle(); done(); }
    else if (k === 'ArrowLeft') { skip(-5); flashSeek(-5); done(); }
    else if (k === 'ArrowRight') { skip(5); flashSeek(5); done(); }
    else if (k === 'j') { skip(-10); flashSeek(-10); done(); }
    else if (k === 'l') { skip(10); flashSeek(10); done(); }
    else if (k === 'ArrowUp') { setVolume(+Settings.get().volume + 0.05); done(); }
    else if (k === 'ArrowDown') { setVolume(+Settings.get().volume - 0.05); done(); }
    else if (k === 'f') { toggleFS(); done(); }
    else if (k === 'm') { toggleMute(); done(); }
    else if (k === 'c') { toggleSubs(); done(); }
    else if (k === 'i') { pip(); done(); }
    else if (k === 't') { Settings.set({ theater: !Settings.get().theater }); done(); }
    else if (k === 'N' && e.shiftKey) { next(); done(); }
    else if (k === '>' || (k === '.' && e.shiftKey)) { setSpeed(Math.min(3, rate + 0.25)); showHud('speed', rate + '×'); done(); }
    else if (k === '<' || (k === ',' && e.shiftKey)) { setSpeed(Math.max(0.25, rate - 0.25)); showHud('speed', rate + '×'); done(); }
    else if (k === ',' && master().paused) { seek(now() - 1 / 30); done(); }
    else if (k === '.' && master().paused) { seek(now() + 1 / 30); done(); }
    else if (/^[0-9]$/.test(k)) { seek(total() * +k / 10); done(); }
  });
  function flashSeek(s) { showHud(s < 0 ? 'prev' : 'next', (s > 0 ? '+' : '−') + Math.abs(s) + ' s'); }

  /* ---------- avisos dentro del reproductor ---------- */
  let errBox = null;
  function showErr(msg) {
    clearErr();
    el.classList.remove('waiting');
    want = false; setPlayIcon();
    const retry = () => { const it = item; if (it) open(it._yt ? { ...it, src: 'yt', id: it._yt } : it, { start: now() }); };
    errBox = h('div.perr', null, h('b', null, 'No se puede ver este vídeo'), h('p', null, msg),
      h('div.btns', null, h('button.btn.acc', { onclick: e => { e.stopPropagation(); tries = 2; retry(); } }, icon('refresh'), 'Reintentar'),
        item && item.src === 'yt' ? h('button.btn', { onclick: e => { e.stopPropagation(); embed(); } }, 'Ver con el reproductor de YouTube') : ''));
    el.append(errBox);
  }
  function clearErr() { if (errBox) errBox.remove(); errBox = null; const f = el.querySelector('iframe'); if (f) f.remove(); }
  function embed() {
    clearErr(); stopAll();
    el.append(h('iframe', { src: `https://www.youtube-nocookie.com/embed/${item.id}?autoplay=1&rel=0&modestbranding=1&start=${Math.floor(now())}`, allow: 'autoplay; fullscreen; picture-in-picture', allowfullscreen: true }));
  }
  let resumeBox = null;
  function showResume(t) {
    hideResume();
    resumeBox = h('div.resume', null, h('span', null, 'Seguimos donde lo dejaste (' + dur(t) + ')'),
      h('button', { onclick: e => { e.stopPropagation(); seek(0); hideResume(); } }, 'Desde el principio'));
    el.append(resumeBox);
    setTimeout(hideResume, 8000);
  }
  function hideResume() { if (resumeBox) resumeBox.remove(); resumeBox = null; }
  let nextBox = null, nextFor = null;
  function showNextUp(n, secs) {
    if (nextBox && nextFor === n) { const b = nextBox.querySelector('.cnt'); if (b) b.textContent = 'En ' + secs + ' s'; return; }
    hideNextUp();
    nextFor = n;
    nextBox = h('div.next-up', null, h('img', { src: n.thumb, alt: '' }), h('div', null, h('small.cnt', null, 'En ' + secs + ' s'), h('b', null, n.title),
      h('div.btns', null, h('button.btn.acc', { onclick: e => { e.stopPropagation(); next(); } }, 'Ver ya'), h('button.btn', { onclick: e => { e.stopPropagation(); queue = queue.filter(x => x !== n); hideNextUp(); } }, 'Cancelar'))));
    el.append(nextBox);
  }
  function hideNextUp() { if (nextBox) nextBox.remove(); nextBox = null; nextFor = null; }

  /* ---------- fuera de la página: notificación del móvil, teclas multimedia ---------- */
  function mediaSession() {
    if (!item) return;
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({ title: item.title || '', artist: item.channel || '', album: 'Mix4Up', artwork: item.thumb ? [{ src: item.thumb, sizes: '480x360', type: 'image/jpeg' }] : [] });
        const ms = navigator.mediaSession;
        ms.setActionHandler('play', play); ms.setActionHandler('pause', pause);
        ms.setActionHandler('seekbackward', () => skip(-10)); ms.setActionHandler('seekforward', () => skip(10));
        ms.setActionHandler('nexttrack', () => queue[0] && next());
        try { ms.setActionHandler('seekto', d => seek(d.seekTime)); } catch {}
      }
    } catch {}
    nativeNow();
  }
  function nativeNow() {
    if (!ANDROID || !item) return;
    try { A.nowPlaying(JSON.stringify({ title: item.title || '', channel: item.channel || '', thumb: item.thumb || '', playing: want && !master().paused, pos: now(), dur: total(), bg: !!Settings.get().bgPlay })); } catch {}
  }
  // lo que manda la notificación del móvil (o un auricular)
  function remote(cmd) {
    if (cmd === 'play') play(); else if (cmd === 'pause') pause(); else if (cmd === 'toggle') toggle();
    else if (cmd === 'next') next(); else if (cmd === 'back10') skip(-10); else if (cmd === 'fwd10') skip(10);
    else if (cmd.startsWith('seek:')) seek(+cmd.slice(5));
  }

  M4.on('settings', p => { if ('volume' in p || 'muted' in p) applyVolume(); if ('theater' in p) bTheater.classList.toggle('on', !!Settings.get().theater); });
  M4.on('ready', () => { rate = +Settings.get().speed || 1; applySpeed(); applyVolume(); applyCue(); bTheater.classList.toggle('on', !!Settings.get().theater); });

  function mount(host) { if (el.parentNode !== host) host.append(el); wake(); }
  function close() { savePos(true); stopAll(); item = null; info = null; el.remove(); clearErr(); setPlayIcon(); if (ANDROID) try { A.nowPlaying('{}'); } catch {} }

  return {
    el, video, audio, open, close, mount, play, pause, toggle, seek, skip, next, setQueue, setSpeed, setSleep, toggleFS, pip, onPip, remote,
    get item() { return item; }, get info() { return info; }, get playing() { return want && !!item && (!master().paused || holding); },
    get time() { return now(); }, get duration() { return total(); }, isFS, keyOf, sleepLabel, openMenu,
  };
})();
