'use strict';
// Ajustes: la cuenta de YouTube, el aspecto (personalizable), la reproducción,
// tus carpetas, el móvil y las actualizaciones.

const SettingsPage = (() => {
  const { h, icon, $, api, toast, Settings, ANDROID, DESKTOP, route } = M4;
  const S = window.Mix4UpShell, A = window.Mix4UpAndroid;

  const THEMES = [
    ['dark', 'Oscuro', '#0f0f13', '#22222b'], ['light', 'Claro', '#f7f6f3', '#ecebe7'], ['oled', 'Negro puro', '#000', '#18181c'],
    ['zine', 'Fanzine', '#0a0a0d', '#222226'], ['ocean', 'Océano', '#0b1420', '#183047'],
  ];
  const ACCENTS = ['#ff2e88', '#ff0033', '#ff7a00', '#ffd400', '#c8ff00', '#22d39a', '#00c2ff', '#4d7cff', '#9b5cff', '#ffffff'];
  const PRESETS = [
    ['Mix4Up', { theme: 'dark', accent: '#ff2e88', accent2: '#c8ff00', radius: 12, font: 'system' }],
    ['Clásico', { theme: 'dark', accent: '#ff0033', accent2: '#3ea6ff', radius: 12, font: 'system' }],
    ['Fanzine', { theme: 'zine', accent: '#c8ff00', accent2: '#ff2e88', radius: 2, font: 'narrow' }],
    ['Suave', { theme: 'light', accent: '#4d7cff', accent2: '#22d39a', radius: 18, font: 'rounded' }],
    ['Noche', { theme: 'oled', accent: '#9b5cff', accent2: '#00c2ff', radius: 14, font: 'system' }],
  ];

  /* ---------- conectar la cuenta de YouTube ---------- */
  async function connect() {
    if (DESKTOP && S.login) {
      toast('Inicia sesión en la ventana de Google que se abre');
      const r = await S.login();
      if (r && r.ok) await afterLogin(); else if (r && r.msg) toast(r.msg, { ms: 6000 });
      return;
    }
    if (ANDROID) { try { A.login(); } catch { toast('Actualiza Mix4Up para conectar tu cuenta'); } return; }
    // en un navegador normal (desarrollo): con un cookies.txt
    importCookies();
  }
  function importCookies() {
    M4.modal((box, close) => {
      const f = h('input', { type: 'file', accept: '.txt,text/plain' });
      f.onchange = async () => {
        const text = await f.files[0].text();
        try { await api('/api/yt/cookies', { method: 'POST', body: text }); close(); await afterLogin(); }
        catch (e) { toast('No se pudo: ' + e.message); }
      };
      box.append(h('h2', null, 'Conectar con un archivo de cookies'),
        h('p', null, 'Si tienes un cookies.txt de YouTube (exportado de tu navegador), elígelo aquí. Se guarda solo en este aparato.'), f,
        h('div.btns', null, h('button.btn.ghost', { onclick: () => close() }, 'Cerrar')));
    });
  }
  async function afterLogin() {
    const c = await YT.getCfg(true);
    M4.emit('account');
    if (c.connected && c.loggedIn) toast('¡Cuenta conectada! Tu inicio ya es el tuyo, sin Shorts.', { ms: 5000 });
    else if (c.connected) toast('Cuenta conectada. Si el inicio no cambia, vuelve a conectar.', { ms: 6000 });
    else toast('No se completó el inicio de sesión. Vuelve a intentarlo.', { ms: 5000 });
    if (location.hash === '' || location.hash === '#/' || location.hash.startsWith('#/settings')) M4.render();
  }
  window.M4loggedIn = afterLogin; // (lo llama la app del móvil)
  async function disconnect() {
    if (!await M4.confirm('¿Desconectar tu cuenta de YouTube?', 'Se borra la sesión guardada en este aparato.', 'Desconectar')) return;
    await api('/api/yt/cookies', { method: 'DELETE' }).catch(() => {});
    try { if (DESKTOP && S.logout) await S.logout(); if (ANDROID) A.logout(); } catch {}
    await YT.getCfg(true);
    M4.emit('account');
    toast('Cuenta desconectada');
    M4.render();
  }

  async function addFolder() {
    let p = '';
    if (DESKTOP && S.pickFolder) p = await S.pickFolder();
    else p = await M4.prompt('Ruta de la carpeta', '', 'Añadir', 'C:\\Users\\…\\Vídeos');
    if (!p) return;
    try { await api('/api/folders', { json: { add: p } }); toast('Carpeta añadida. Leyendo los vídeos…'); setTimeout(() => M4.go('/local?r=1'), 400); }
    catch (e) { toast(e.message); }
  }

  /* ---------- la página ---------- */
  const sw = (key, label, sub, onChange) => {
    const on = !!Settings.get()[key];
    const s = h('span.switch' + (on ? '.on' : ''), { role: 'switch', tabindex: 0, 'aria-checked': on },
      h('i'));
    s.onclick = () => { const v = !Settings.get()[key]; Settings.set({ [key]: v }); s.classList.toggle('on', v); s.setAttribute('aria-checked', v); onChange && onChange(v); };
    return h('div.set', null, h('span', null, label, sub ? h('small', null, sub) : ''), s);
  };
  const sel = (key, label, sub, opts, onChange) => {
    const s = h('select', { onchange: e => { const v = isNaN(+e.target.value) || e.target.value === '' ? e.target.value : +e.target.value; Settings.set({ [key]: v }); onChange && onChange(v); } },
      ...opts.map(([v, l]) => h('option', { value: v, selected: String(Settings.get()[key]) === String(v) }, l)));
    return h('div.set', null, h('span', null, label, sub ? h('small', null, sub) : ''), s);
  };

  route(/^\/settings$/, async () => {
    const v = $('#view');
    v.className = '';
    $('#main').scrollTop = 0;
    const cfg = await YT.getCfg();
    let info = {};
    try { info = await api('/api/info'); } catch {}
    const page = h('div.settings');
    v.replaceChildren(h('div.pagehead', null, h('h1', null, 'Ajustes')), page);

    // cuenta
    page.append(h('section', null, h('h2', null, icon('user'), 'Cuenta de YouTube'),
      h('div.set', null, h('span', null, cfg.connected ? (cfg.loggedIn ? 'Conectada' : 'Conectada (comprobando la sesión…)') : 'Sin conectar',
        h('small', null, cfg.connected ? 'Tu inicio, suscripciones, historial y listas vienen de tu cuenta. La sesión se guarda solo en este aparato.' : 'Conéctala para ver tus recomendaciones (sin Shorts), suscripciones, historial y listas.')),
        cfg.connected ? h('div.btns', null, h('button.btn', { onclick: connect }, 'Volver a conectar'), h('button.btn.ghost', { onclick: disconnect }, 'Desconectar'))
          : h('button.btn.acc', { onclick: connect }, 'Conectar con YouTube')),
      !DESKTOP && !ANDROID ? '' : h('div.set', null, h('span', null, 'Con un archivo de cookies', h('small', null, 'Por si el inicio de sesión de Google no deja entrar desde aquí.')), h('button.btn.ghost', { onclick: importCookies }, 'Elegir cookies.txt')),
      sw('markWatched', 'Contar en tu historial de YouTube lo que ves aquí', 'Así YouTube aprende de lo que ves en Mix4Up y te recomienda mejor.')));

    // aspecto
    const themeBox = h('div.themes');
    const paintThemes = () => themeBox.replaceChildren(...THEMES.map(([id, name, bg, card]) => h('button' + (Settings.get().theme === id ? '.sel' : ''), { onclick: () => { Settings.set({ theme: id, lookVer: Date.now() }); paintThemes(); } },
      h('div.sw', { style: { background: bg } }, h('i', { style: { background: card } }), h('i', { style: { background: Settings.get().accent } }), h('i', { style: { background: Settings.get().accent2 } })), h('b', null, name))));
    paintThemes();
    const accBox = h('div.swatches');
    const paintAcc = () => accBox.replaceChildren(...ACCENTS.map(c => h('button' + (Settings.get().accent === c ? '.sel' : ''), { style: { background: c }, title: c, onclick: () => { Settings.set({ accent: c, lookVer: Date.now() }); paintAcc(); paintThemes(); acc1.value = c; } })));
    paintAcc();
    const acc1 = h('input', { type: 'color', value: Settings.get().accent, oninput: e => { Settings.set({ accent: e.target.value, lookVer: Date.now() }); paintAcc(); } });
    const acc2 = h('input', { type: 'color', value: Settings.get().accent2, oninput: e => { Settings.set({ accent2: e.target.value, lookVer: Date.now() }); paintThemes(); } });
    const rad = h('input', { type: 'range', min: 0, max: 24, value: Settings.get().radius, oninput: e => Settings.set({ radius: +e.target.value, lookVer: Date.now() }) });
    page.append(h('section', null, h('h2', null, icon('palette'), 'Aspecto'),
      h('div.set', null, h('span', null, 'Estilos listos', h('small', null, 'Un toque y cambia todo; luego lo retocas a tu gusto.')),
        h('div.btns', null, PRESETS.map(([n, p]) => h('button.btn', { onclick: () => { Settings.set({ ...p, lookVer: Date.now() }); M4.render(); } }, n)))),
      h('div.set', null, h('span', null, 'Tema'), themeBox),
      h('div.set', null, h('span', null, 'Color principal', h('small', null, 'Botones, la barra del vídeo, lo seleccionado.')), accBox, acc1),
      h('div.set', null, h('span', null, 'Color secundario', h('small', null, 'Detalles: el temporizador, «Suscrito», el tramo A-B.')), acc2),
      h('div.set', null, h('span', null, 'Esquinas', h('small', null, 'De rectas a muy redondeadas.')), rad),
      sel('density', 'Tamaño de las miniaturas', 'Cuántos vídeos caben por fila.', [['compact', 'Pequeñas (caben más)'], ['normal', 'Normales'], ['big', 'Grandes']]),
      sel('font', 'Letra', '', [['system', 'La del sistema'], ['rounded', 'Redondeada'], ['narrow', 'Estrecha'], ['serif', 'Con serifa'], ['mono', 'Máquina de escribir']]),
      sw('syncLook', 'Mismo aspecto en el móvil y el PC', 'Al sincronizar, el aspecto que cambies en uno pasa al otro.'),
      h('div.set', null, h('span', null, 'Volver al aspecto de siempre'), h('button.btn.ghost', { onclick: () => { Settings.set({ ...PRESETS[0][1], density: 'normal', lookVer: Date.now() }); M4.render(); } }, 'Restablecer'))));

    // reproducción
    page.append(h('section', null, h('h2', null, icon('play'), 'Reproducción'),
      sw('autoplay', 'Reproducción automática', 'Al acabar un vídeo, empieza el siguiente.'),
      sw('resume', 'Seguir donde lo dejaste', 'Los vídeos empiezan donde te quedaste (también si lo empezaste en el otro aparato).'),
      sel('quality', 'Calidad de YouTube', 'La que se elige al abrir un vídeo (luego se puede cambiar en ⚙).', [['auto', 'Automática'], ['2160', '4K'], ['1440', '1440p'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']]),
      sel('qualityCap', 'Calidad automática como mucho', 'Para no gastar datos de más.', [[2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p']]),
      sel('speed', 'Velocidad', '', [[0.75, '0,75×'], [1, 'Normal'], [1.25, '1,25×'], [1.5, '1,5×'], [2, '2×']]),
      sw('subs', 'Subtítulos activados', 'Si el vídeo los tiene.'),
      sel('subLang', 'Idioma de los subtítulos', '', [['es', 'Español'], ['en', 'Inglés'], ['ca', 'Catalán'], ['fr', 'Francés'], ['pt', 'Portugués'], ['it', 'Italiano'], ['de', 'Alemán']]),
      ANDROID ? sw('gestures', 'Gestos en el vídeo', 'Dos toques a un lado: ±10 s. Deslizar a la izquierda: brillo; a la derecha: volumen.') : '',
      ANDROID ? sw('bgPlay', 'Seguir oyéndolo con la pantalla apagada', 'El sonido sigue en segundo plano, con controles en la notificación.') : '',
      sel('sleepAction', 'Al acabar el temporizador para dormir', '', [['pause', 'Parar el vídeo'], ['close', 'Parar y cerrar Mix4Up'], ...(DESKTOP ? [['shutdown', 'Parar y apagar el PC']] : [])])));

    // sin shorts
    page.append(h('section', null, h('h2', null, icon('hide'), 'Sin Shorts'),
      h('div.set', null, h('span', null, 'Los Shorts no salen nunca', h('small', null, 'Ni en inicio, ni en búsquedas, ni en canales, ni en relacionados, ni en suscripciones. Quitados en esta sesión: ' + YT.shortsRemoved() + '.'))),
      sw('strictShorts', 'Quitar también los vídeos de menos de 1 minuto', 'Por si alguno se cuela sin parecer un Short.')));

    // tus vídeos
    const folders = h('div', { style: { width: '100%' } });
    const paintFolders = list => folders.replaceChildren(...(list || []).map(f => h('div.set', null, h('span', null, f), DESKTOP ? h('button.btn.ghost', { onclick: async () => { const r = await api('/api/folders', { json: { remove: f } }); paintFolders(r.folders); } }, 'Quitar') : '')));
    paintFolders(info.folders);
    page.append(h('section', null, h('h2', null, icon('folder'), 'Mis vídeos'),
      h('div.set', null, h('span', null, ANDROID ? 'Los vídeos del móvil' : 'Carpetas que se leen', h('small', null, ANDROID ? 'Mix4Up enseña todos los vídeos de tu móvil.' : 'MP4, MKV, WebM, MOV, AVI… (los que la ventana no abre tal cual se convierten al vuelo).')),
        DESKTOP ? h('button.btn', { onclick: addFolder }, 'Añadir carpeta') : ''),
      folders,
      h('div.set', null, h('span', null, 'Las descargas van a', h('small', null, info.downloads || '')))));

    // móvil y PC
    const syncBox = h('div', { style: { width: '100%' } });
    page.append(h('section', null, h('h2', null, icon('devices'), ANDROID ? 'Conectar con el PC' : 'Conectar el móvil'),
      h('div.set', null, h('span', null, 'Sincroniza lo que ves, dónde te quedaste, tus listas y los vídeos ocultos', h('small', null, 'En la misma WiFi. Lo que borras en uno se borra en el otro y no vuelve.'))),
      syncBox));
    Sync.paintSettings(syncBox);

    // actualizaciones
    const upd = h('div.set');
    page.append(h('section', null, h('h2', null, icon('refresh'), 'Actualizaciones'), upd, sw('autoUpdate', 'Actualizar sola', 'Mix4Up se baja e instala las versiones nuevas sin preguntar.')));
    paintUpdate(upd, info);

    // herramientas
    const tools = h('div.set', null, h('span', null, 'yt-dlp (lo que habla con YouTube)', h('small', null, 'Comprobando…')), h('button.btn.ghost', { onclick: async () => { await api('/api/yt/tools', { method: 'POST' }); toast('Buscando la última versión de yt-dlp…'); } }, 'Actualizar ya'));
    page.append(h('section', null, h('h2', null, icon('gear'), 'Avanzado'), tools,
      h('div.set', null, h('span', null, 'Carpeta de datos', h('small', null, info.data || ''))),
      h('div.set', null, h('span', null, 'Mix4Up ' + (info.version || ''), h('small', null, 'Hermano de MixUp. Sin anuncios, sin Shorts, sin enviar tus datos a nadie.')))));
    api('/api/yt/tools?v=1').then(t => { tools.querySelector('small').textContent = t.ready ? 'Lista' + (t.version ? ' · versión ' + t.version : '') + (t.busy ? ' · actualizando…' : '') : t.busy ? 'Descargando (solo la primera vez)…' : 'Se descargará al ver el primer vídeo'; }).catch(() => {});
  });

  /* ---------- actualizaciones (las mismas en el PC y en el móvil) ---------- */
  let updState = null;
  const updListeners = new Set();
  function onUpdState(s) { updState = s; updListeners.forEach(f => f(s)); if (s && s.state === 'ready' && !Settings.get().autoUpdate) toast('Hay una versión nueva de Mix4Up', { action: 'Actualizar', fn: install }); }
  if (DESKTOP && S.onUpdate) S.onUpdate(onUpdState);
  window.M4update = json => { try { onUpdState(typeof json === 'string' ? JSON.parse(json) : json); } catch {} };
  function check() { if (DESKTOP) S.check().then(s => s && onUpdState(s)); else if (ANDROID) A.checkUpdate(true); }
  function install() { if (DESKTOP) S.install(); else if (ANDROID) A.installUpdate(); }
  function paintUpdate(box, info) {
    const label = h('span', null, 'Versión ' + (info.version || '').split('.').slice(0, 3).join('.'), h('small'));
    const btn = h('button.btn.acc', { onclick: () => { if (updState && updState.state === 'ready') install(); else { check(); } } }, 'Buscar actualización');
    box.replaceChildren(label, btn);
    const paint = s => {
      if (!box.isConnected) { updListeners.delete(paint); return; }
      const small = label.querySelector('small');
      if (!s) { small.textContent = DESKTOP || ANDROID ? 'Toca para mirar si hay una nueva' : 'En el navegador no se actualiza sola'; return; }
      const map = { checking: 'Mirando si hay una nueva…', none: 'Tienes la última', available: 'Hay una nueva: ' + (s.version || ''), downloading: 'Bajando la nueva… ' + (s.pct || 0) + '%', ready: 'Lista para instalar: ' + (s.version || ''), installing: 'Instalando…', error: 'No se pudo: ' + (s.msg || '') };
      small.textContent = map[s.state] || '';
      btn.textContent = s.state === 'ready' || s.state === 'available' ? 'Actualizar' : s.state === 'downloading' || s.state === 'installing' ? 'Un momento…' : 'Buscar actualización';
      btn.disabled = s.state === 'downloading' || s.state === 'installing' || s.state === 'checking';
      if (s.state === 'available') btn.onclick = () => install();
    };
    updListeners.add(paint);
    paint(updState);
    if (DESKTOP && S.state) S.state().then(s => s && onUpdState(s)).catch(() => {});
  }

  return { connect, disconnect, addFolder, check, install };
})();
