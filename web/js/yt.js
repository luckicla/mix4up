'use strict';
// YouTube: Mix4Up pregunta a YouTube lo mismo que pregunta su propia web
// (InnerTube), a través del motor de Mix4Up (/api/yt/i/…), que añade la sesión
// de tu cuenta si la has conectado. Aquí se lee la respuesta y se quita todo
// lo que sea un Short o un anuncio, venga donde venga.
//
// La lectura es «a lo ancho»: se recorre la respuesta entera buscando las
// piezas que son vídeos, canales o listas, sin depender de dónde estén. Así,
// cuando YouTube cambia el orden de su página, Mix4Up sigue encontrándolas.

const YT = (() => {
  let cfg = null, cfgAt = 0, acct = null, cfgP = null;
  // rápido: ¿hay cuenta? (sin esperar a youtube.com); la configuración llega aparte
  async function account() {
    if (acct) return acct;
    try { acct = await M4.api('/api/yt/account'); } catch { acct = { connected: false }; }
    return acct;
  }
  function warm() { if (!cfgP) cfgP = getCfg().finally(() => { cfgP = null; }); return cfgP; }
  async function getCfg(force) {
    if (cfg && !force && Date.now() - cfgAt < 30 * 60e3) return cfg;
    if (force) acct = null;
    try { cfg = await M4.api('/api/yt/cfg' + (force ? '?fresh=1' : '')); cfgAt = Date.now(); acct = { connected: !!cfg.connected }; }
    catch { cfg = cfg || { clientVersion: '2.20251114.01.00', hl: 'es', gl: 'ES', connected: false }; }
    return cfg;
  }
  const connected = () => !!((cfg && cfg.connected) || (acct && acct.connected));

  async function call(ep, body = {}) {
    const c = cfg && Date.now() - cfgAt < 30 * 60e3 ? cfg : await (cfgP || warm());
    const ctx = { client: { clientName: 'WEB', clientVersion: c.clientVersion, hl: 'es', gl: c.gl || 'ES', visitorData: c.visitorData || undefined,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid', utcOffsetMinutes: -new Date().getTimezoneOffset() },
      user: { lockedSafetyMode: false }, request: { useSsl: true } };
    let r;
    try { r = await M4.api('/api/yt/i/' + ep, { json: { context: ctx, ...body } }); }
    catch (e) {
      let msg = e.message;
      try { const j = JSON.parse(msg); msg = (j.error && j.error.message) || msg; } catch {}
      if (e.status === 401 || e.status === 403) msg = 'YouTube no aceptó la sesión. Vuelve a conectar tu cuenta en Ajustes.';
      throw new Error(msg || 'YouTube no contestó');
    }
    if (r && r.error) throw new Error(r.error.message || 'YouTube dio un error');
    if (ep === 'browse' && connected()) grabMe(r);
    return r;
  }

  /* ---------- leer las piezas ---------- */
  const text = o => !o ? '' : typeof o === 'string' ? o : o.simpleText ?? (o.runs ? o.runs.map(r => r.text).join('') : (o.content ?? ''));
  const bestThumb = list => {
    if (!Array.isArray(list) || !list.length) return '';
    let b = list[0];
    for (const t of list) if ((t.width || 0) > (b.width || 0)) b = t;
    let u = b.url || '';
    if (u.startsWith('//')) u = 'https:' + u;
    return u;
  };
  // la primera vez que aparece una clave, en cualquier parte (con un límite)
  function find(o, key, max = 4000) {
    const q = [o]; let n = 0;
    while (q.length && n++ < max) {
      const x = q.shift();
      if (!x || typeof x !== 'object') continue;
      if (!Array.isArray(x) && key in x) return x[key];
      for (const v of Array.isArray(x) ? x : Object.values(x)) if (v && typeof v === 'object') q.push(v);
    }
    return undefined;
  }
  function findAll(o, key, out = [], depth = 0) {
    if (!o || typeof o !== 'object' || depth > 50) return out;
    if (Array.isArray(o)) { for (const v of o) findAll(v, key, out, depth + 1); return out; }
    for (const k in o) { if (k === key) out.push(o[k]); else findAll(o[k], key, out, depth + 1); }
    return out;
  }

  // lo que nunca se enseña: Shorts y anuncios (y menús, que no tienen vídeos)
  const SKIP = new Set(['reelShelfRenderer', 'reelItemRenderer', 'shortsLockupViewModel', 'reelPlayerOverlayRenderer',
    'adSlotRenderer', 'promotedVideoRenderer', 'promotedSparklesWebRenderer', 'promotedSparklesTextSearchRenderer', 'compactPromotedVideoRenderer',
    'displayAdRenderer', 'inFeedAdLayoutRenderer', 'searchPyvRenderer', 'bannerPromoRenderer', 'statementBannerRenderer', 'brandVideoSingletonRenderer',
    'brandVideoShelfRenderer', 'adSlotAndLayoutViewModel', 'primetimePromoRenderer', 'mealbarPromoRenderer', 'movieOfferModuleRenderer',
    'merchandiseShelfRenderer', 'ticketShelfRenderer', 'menu', 'menuRenderer', 'feedFilterChipBarRenderer', 'chipCloudRenderer',
    'thumbnailOverlays', 'topbar', 'frameworkUpdates', 'responseContext', 'endScreen', 'playerOverlays', 'emergencyOneboxRenderer',
    'backgroundPromoRenderer', 'feedNudgeRenderer', 'compactAutoplayRenderer']);
  const VIDEO_R = new Set(['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer', 'videoWithContextRenderer', 'movieRenderer']);

  function isShortsShelf(v) {
    const t = text(v && (v.title || (v.header && find(v.header, 'title')))) || '';
    return /^\s*shorts\s*$/i.test(t) || !!(v && (v.isShorts || find(v, 'shortsLockupViewModel', 300) || find(v, 'reelItemRenderer', 300)));
  }

  function fromVideo(v) {
    const id = v.videoId;
    if (!id) return null;
    const by = v.longBylineText || v.ownerText || v.shortBylineText;
    const ov = (v.thumbnailOverlays || []).map(o => o.thumbnailOverlayTimeStatusRenderer).find(Boolean);
    const durText = text(v.lengthText) || text(ov && ov.text) || '';
    const url = (v.navigationEndpoint && v.navigationEndpoint.commandMetadata && v.navigationEndpoint.commandMetadata.webCommandMetadata && v.navigationEndpoint.commandMetadata.webCommandMetadata.url) || '';
    const badges = JSON.stringify(v.badges || []) + (ov ? ov.style : '');
    const ava = v.channelThumbnailSupportedRenderers ? bestThumb(find(v.channelThumbnailSupportedRenderers, 'thumbnails')) : bestThumb(v.channelThumbnail && v.channelThumbnail.thumbnails);
    const thumbs = v.thumbnail && v.thumbnail.thumbnails;
    const vert = Array.isArray(thumbs) && thumbs.length && thumbs[thumbs.length - 1].height > thumbs[thumbs.length - 1].width;
    return {
      type: 'video', id, title: text(v.title) || text(v.headline), channel: text(by),
      chId: by && by.runs && by.runs[0] && by.runs[0].navigationEndpoint && by.runs[0].navigationEndpoint.browseEndpoint ? by.runs[0].navigationEndpoint.browseEndpoint.browseId : '',
      ava, thumb: bestThumb(thumbs) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      durText, dur: M4.parseDur(durText), live: /LIVE/.test(badges) || /directo|live/i.test(durText),
      views: text(v.shortViewCountText) || text(v.viewCountText), published: text(v.publishedTimeText),
      short: url.startsWith('/shorts/') || !!(v.navigationEndpoint && v.navigationEndpoint.reelWatchEndpoint) || /SHORTS/.test(ov ? ov.style || '' : ''),
      vertical: !!vert,
      desc: text(v.detailedMetadataSnippets && v.detailedMetadataSnippets[0] && v.detailedMetadataSnippets[0].snippetText) || text(v.descriptionSnippet),
    };
  }

  function fromLockup(v) {
    const md = v.metadata && v.metadata.lockupMetadataViewModel;
    const title = md && md.title ? text(md.title) : '';
    const rows = (md && find(md, 'metadataRows')) || [];
    const parts = rows.map(r => (r.metadataParts || []).map(p => text(p.text)).filter(Boolean));
    const img = v.contentImage || {};
    const thumbs = find(img, 'sources') || [];
    const badgeTexts = findAll(img, 'thumbnailBadgeViewModel').map(b => text(b.text)).filter(Boolean);
    const badgeStyles = JSON.stringify(findAll(img, 'badgeStyle'));
    const onTap = find(v.rendererContext || {}, 'innertubeCommand') || {};
    const url = (onTap.commandMetadata && onTap.commandMetadata.webCommandMetadata && onTap.commandMetadata.webCommandMetadata.url) || '';
    const avatar = md && find(md, 'decoratedAvatarViewModel');
    const chId = (avatar && find(avatar, 'browseId')) || (md && find(md, 'browseId')) || '';
    const ava = avatar ? bestThumb(find(avatar, 'sources')) : '';
    const ct = v.contentType || '';
    if (ct === 'LOCKUP_CONTENT_TYPE_VIDEO' || (!ct && onTap.watchEndpoint)) {
      const durText = badgeTexts.find(t => /^\d+(:\d{2}){1,2}$/.test(t)) || '';
      const id = v.contentId || (onTap.watchEndpoint && onTap.watchEndpoint.videoId);
      if (!id) return null;
      return {
        type: 'video', id, title, channel: (parts[0] || [])[0] || '', chId, ava,
        thumb: bestThumb(thumbs) || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, durText, dur: M4.parseDur(durText),
        live: /LIVE/.test(badgeStyles) || badgeTexts.some(t => /directo|live/i.test(t)),
        views: (parts[1] || [])[0] || '', published: (parts[1] || [])[1] || '',
        short: url.startsWith('/shorts/') || !!onTap.reelWatchEndpoint, vertical: false, desc: '',
      };
    }
    if (/PLAYLIST|PODCAST|ALBUM|MIX/.test(ct)) {
      const id = v.contentId || '';
      if (!id) return null;
      return { type: 'playlist', id, title, channel: (parts[0] || [])[0] || '', thumb: bestThumb(thumbs), count: badgeTexts.find(t => /\d/.test(t)) || '',
        firstId: onTap.watchEndpoint ? onTap.watchEndpoint.videoId : '' };
    }
    return null;
  }

  function fromChannel(v) {
    const id = v.channelId || (v.navigationEndpoint && v.navigationEndpoint.browseEndpoint && v.navigationEndpoint.browseEndpoint.browseId);
    if (!id) return null;
    return { type: 'channel', id, title: text(v.title), thumb: bestThumb(v.thumbnail && v.thumbnail.thumbnails),
      subs: text(v.videoCountText) || text(v.subscriberCountText), handle: text(v.subscriberCountText).startsWith('@') ? text(v.subscriberCountText) : '', desc: text(v.descriptionSnippet) };
  }
  function fromPlaylist(v) {
    const id = v.playlistId;
    if (!id) return null;
    const thumbs = v.thumbnails ? v.thumbnails[0] && v.thumbnails[0].thumbnails : v.thumbnail && v.thumbnail.thumbnails;
    return { type: 'playlist', id, title: text(v.title), channel: text(v.shortBylineText || v.longBylineText), thumb: bestThumb(thumbs),
      count: text(v.videoCountText) || text(v.videoCountShortText) || (v.videoCount ? v.videoCount + ' vídeos' : ''),
      firstId: v.navigationEndpoint && v.navigationEndpoint.watchEndpoint ? v.navigationEndpoint.watchEndpoint.videoId : '' };
  }

  // recorre la respuesta: vídeos, canales y listas en su orden, y el «seguir cargando»
  function collect(root) {
    const items = [];
    let cont = null;
    const walk = (n, d) => {
      if (!n || typeof n !== 'object' || d > 60) return;
      if (Array.isArray(n)) { for (const x of n) walk(x, d + 1); return; }
      for (const k in n) {
        const v = n[k];
        if (SKIP.has(k) || !v || typeof v !== 'object') continue;
        if ((k === 'richShelfRenderer' || k === 'shelfRenderer' || k === 'richSectionRenderer' || k === 'horizontalCardListRenderer') && isShortsShelf(v)) continue;
        let it = null;
        if (VIDEO_R.has(k)) it = fromVideo(v);
        else if (k === 'lockupViewModel') it = fromLockup(v);
        else if (k === 'channelRenderer' || k === 'gridChannelRenderer') it = fromChannel(v);
        else if (k === 'playlistRenderer' || k === 'gridPlaylistRenderer' || k === 'compactPlaylistRenderer' || k === 'radioRenderer' || k === 'compactRadioRenderer') it = fromPlaylist(v);
        else if (k === 'continuationItemRenderer') { const t = find(v, 'token'); if (t) cont = t; continue; }
        else { walk(v, d + 1); continue; }
        if (it) items.push(it);
      }
    };
    walk(root, 0);
    return { items, cont };
  }

  /* ---------- ni un Short ---------- */
  function isShort(it) {
    if (it.type !== 'video') return false;
    if (it.short) return true;
    if (/(^|\s)#shorts?\b/i.test(it.title || '')) return true;
    if (it.vertical && it.dur > 0 && it.dur <= 180) return true;
    if (M4.Settings.get().strictShorts && it.dur > 0 && it.dur <= 60 && !it.live) return true;
    return false;
  }
  let shortsRemoved = 0;
  function clean(items, seen) {
    const out = [];
    for (const it of items) {
      if (!it) continue;
      if (isShort(it)) { shortsRemoved++; continue; }
      if (it.type === 'video' && Journal.isOn('hide', 'yt:' + it.id)) continue;
      const k = it.type + ':' + it.id;
      if (seen) { if (seen.has(k)) continue; seen.add(k); }
      out.push(it);
    }
    return out;
  }

  // un feed que se puede seguir cargando (scroll infinito)
  // las «chips» de arriba del inicio (Todo, Música, Directos…), las de YouTube
  function chipsOf(r) {
    const out = [];
    for (const c of findAll(r, 'chipCloudChipRenderer')) {
      const label = text(c.text);
      const token = find(c.navigationEndpoint || {}, 'token');
      if (label && !/^shorts$/i.test(label)) out.push({ label, token: token || '', selected: !!c.isSelected });
    }
    return out;
  }
  function feed(first, next) {
    const seen = new Set();
    let cont = null, done = false, started = false;
    return {
      chips: [],
      async more() {
        if (done) return [];
        const r = started ? (cont ? await next(cont) : null) : await first();
        if (!started && r) this.chips = chipsOf(r);
        started = true;
        if (!r) { done = true; return []; }
        const c = collect(r);
        cont = c.cont;
        if (!cont) done = true;
        const items = clean(c.items, seen);
        // una página que solo traía Shorts: la siguiente
        if (!items.length && cont) return this.more();
        return items;
      },
      get done() { return done; },
      raw: null,
    };
  }
  // una chip del inicio: su propia tanda de recomendaciones
  const chipFeed = token => feed(() => call('browse', { continuation: token }), c => call('browse', { continuation: c }));
  const browseFeed = (browseId, params) => feed(() => call('browse', params ? { browseId, params } : { browseId }), c => call('browse', { continuation: c }));

  /* ---------- con yt-dlp (si la web de YouTube cambia y lo de arriba falla) ---------- */
  async function dlpList(u, start = 1, end = 40) {
    const r = await M4.api('/api/yt/list?u=' + encodeURIComponent(u) + '&start=' + start + '&end=' + end);
    return clean((r.entries || []).map(e => ({ type: 'video', id: e.ID, title: e.Title, channel: e.Channel, chId: e.ChannelID,
      thumb: e.Thumb || `https://i.ytimg.com/vi/${e.ID}/hqdefault.jpg`, dur: e.Duration || 0, durText: e.Duration ? M4.dur(e.Duration) : '',
      live: e.Live === 'is_live', views: e.Views ? M4.views(e.Views) : '', published: e.Timestamp ? M4.ago(e.Timestamp * 1000) : '',
      short: /\/shorts\//.test(e.URL || ''), vertical: !!e.Vertical })).filter(x => ytId(x.id)));
  }
  function dlpFeed(u) {
    let n = 0, done = false; const seen = new Set();
    return { async more() { if (done) return []; const items = clean(await dlpList(u, n + 1, n + 40), seen); n += 40; if (!items.length) done = true; return items; }, get done() { return done; } };
  }
  const ytId = s => /^[A-Za-z0-9_-]{11}$/.test(s || '');

  /* ---------- inicio ---------- */
  // con cuenta: lo que YouTube te recomienda a ti. Sin cuenta: una mezcla con
  // lo relacionado con lo último que has visto y tus suscripciones.
  function home() {
    if (connected()) {
      const f = browseFeed('FEwhat_to_watch');
      let fallback = null, got = false;
      return {
        async more() {
          if (fallback) return fallback.more();
          try {
            const items = await f.more();
            if (!items.length && !got) throw new Error('vacío');
            got = true;
            return items;
          } catch (e) {
            if (got) throw e;
            console.warn('inicio por la web de YouTube:', e.message, '→ con yt-dlp');
            fallback = dlpFeed(':ytrec');
            return fallback.more();
          }
        },
        get done() { return fallback ? fallback.done : f.done; },
        get chips() { return f.chips || []; },
      };
    }
    return personalMix();
  }

  function personalMix() {
    const seen = new Set();
    let round = 0, done = false;
    return {
      async more() {
        if (done) return [];
        const hist = Journal.all('hist').filter(e => e.v && e.v.id).slice(0, 24);
        const subs = Journal.all('sub');
        const seeds = hist.slice(round * 3, round * 3 + 3);
        const subSeeds = subs.slice(round * 3, round * 3 + 3);
        round++;
        if (!seeds.length && !subSeeds.length) { done = true; return []; }
        const res = await Promise.allSettled([
          ...seeds.map(s => watch(s.v.id).then(w => w.related.slice(0, 10))),
          ...subSeeds.map(s => channelVideos(s.k).then(r => r.slice(0, 6))),
        ]);
        const lists = res.filter(r => r.status === 'fulfilled').map(r => r.value);
        // intercaladas
        const out = [];
        for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]);
        return clean(out.filter(x => x.type === 'video' && !Journal.pos('yt:' + x.id)), seen);
      },
      get done() { return done; },
    };
  }

  /* ---------- suscripciones ---------- */
  function subscriptions() {
    if (connected()) {
      const f = browseFeed('FEsubscriptions');
      let fb = null;
      return {
        async more() { if (fb) return fb.more(); try { return await f.more(); } catch { fb = dlpFeed(':ytsubs'); return fb.more(); } },
        get done() { return fb ? fb.done : f.done; },
      };
    }
    // sin cuenta: lo último de cada canal al que te suscribiste en Mix4Up
    let done = false;
    return {
      async more() {
        if (done) return [];
        done = true;
        const subs = Journal.all('sub');
        const res = await Promise.allSettled(subs.slice(0, 40).map(s => channelVideos(s.k).then(r => r.slice(0, 8))));
        const lists = res.filter(r => r.status === 'fulfilled').map(r => r.value);
        const out = [];
        for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (l[i]) out.push(l[i]);
        return clean(out, new Set());
      },
      get done() { return done; },
    };
  }

  // los canales de tu cuenta (para el menú)
  async function guideSubs() {
    if (!connected()) return Journal.all('sub').map(e => ({ id: e.k, title: (e.v && e.v.n) || '', thumb: (e.v && e.v.a) || '' }));
    try {
      const r = await call('guide');
      const out = [], seen = new Set();
      for (const g of findAll(r, 'guideEntryRenderer')) {
        const id = g.navigationEndpoint && g.navigationEndpoint.browseEndpoint && g.navigationEndpoint.browseEndpoint.browseId;
        if (!id || !/^UC/.test(id) || seen.has(id)) continue;
        seen.add(id);
        out.push({ id, title: text(g.formattedTitle) || g.accessibility?.accessibilityData?.label || '', thumb: bestThumb(g.thumbnail && g.thumbnail.thumbnails) });
      }
      return out;
    } catch { return []; }
  }

  /* ---------- búsqueda ---------- */
  const FILTERS = { video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==' };
  function search(q, filter) {
    const params = FILTERS[filter];
    const f = feed(() => call('search', params ? { query: q, params } : { query: q }), c => call('search', { continuation: c }));
    let fb = null;
    return {
      async more() {
        if (fb) return fb.more();
        try { return await f.more(); }
        catch (e) { if (filter && filter !== 'video') throw e; fb = dlpFeed('ytsearch60:' + q); return fb.more(); }
      },
      get done() { return fb ? fb.done : f.done; },
    };
  }
  async function suggest(q) {
    try { return await M4.api('/api/yt/suggest?q=' + encodeURIComponent(q)); } catch { return []; }
  }

  /* ---------- un vídeo: datos, relacionados ---------- */
  async function watch(id, list) {
    const r = await call('next', list ? { videoId: id, playlistId: list } : { videoId: id });
    const res = r.contents && r.contents.twoColumnWatchNextResults;
    const prim = find(r, 'videoPrimaryInfoRenderer') || {};
    const sec = find(r, 'videoSecondaryInfoRenderer') || {};
    const owner = (sec.owner && sec.owner.videoOwnerRenderer) || {};
    const rel = collect(res ? res.secondaryResults : find(r, 'secondaryResults') || {});
    const pl = res && res.playlist ? collect(res.playlist) : { items: [] };
    const plInfo = res && res.playlist && res.playlist.playlist;
    const likeStatus = find(r, 'likeStatus');
    const subscribed = find(sec, 'subscribed');
    return {
      id, title: text(prim.title), views: text(find(prim, 'viewCount') && find(prim, 'viewCount').videoViewCountRenderer ? find(prim, 'viewCount').videoViewCountRenderer.viewCount : find(prim, 'viewCount')),
      date: text(prim.relativeDateText) || text(prim.dateText),
      channel: text(owner.title), chId: owner.navigationEndpoint && owner.navigationEndpoint.browseEndpoint ? owner.navigationEndpoint.browseEndpoint.browseId : '',
      ava: bestThumb(owner.thumbnail && owner.thumbnail.thumbnails), subs: text(owner.subscriberCountText),
      desc: (sec.attributedDescription && sec.attributedDescription.content) || text(sec.description),
      liked: likeStatus === 'LIKE', subscribed: subscribed === true,
      related: clean(rel.items, new Set([ 'video:' + id ])), relCont: rel.cont,
      playlist: plInfo ? { id: plInfo.playlistId, title: text(plInfo.title), items: clean(pl.items.filter(x => x.type === 'video'), new Set()) } : null,
    };
  }
  async function moreRelated(cont) {
    const r = await call('next', { continuation: cont });
    const c = collect(r);
    return { items: clean(c.items, new Set()), cont: c.cont };
  }

  /* ---------- canales ---------- */
  async function resolveChannel(idOrHandle) {
    if (/^UC[\w-]{22}$/.test(idOrHandle)) return idOrHandle;
    const r = await call('navigation/resolve_url', { url: 'https://www.youtube.com/' + (idOrHandle.startsWith('@') ? idOrHandle : '@' + idOrHandle) });
    const id = find(r, 'browseId');
    if (!id) throw new Error('No se encontró ese canal');
    return id;
  }
  async function channel(idOrHandle) {
    const id = await resolveChannel(idOrHandle);
    const r = await call('browse', { browseId: id });
    const meta = find(r, 'channelMetadataRenderer') || {};
    const header = (r.header) || {};
    const tabs = findAll(r.contents || {}, 'tabRenderer').map(t => ({ title: t.title, url: (find(t.endpoint || {}, 'url') || ''), params: t.endpoint && t.endpoint.browseEndpoint ? t.endpoint.browseEndpoint.params : '', selected: !!t.selected }));
    const banner = bestThumb(find(header, 'imageBannerViewModel') ? find(find(header, 'imageBannerViewModel'), 'sources') : (find(header, 'banner') || {}).thumbnails);
    const rows = findAll(header, 'metadataParts').flat().map(p => text(p.text)).filter(Boolean);
    const subText = rows.find(t => /suscriptor|subscriber/i.test(t)) || text(find(header, 'subscriberCountText'));
    const handle = rows.find(t => t.startsWith('@')) || '';
    const subscribed = find(header, 'subscribed');
    return {
      id, title: meta.title || text(find(header, 'title')), ava: bestThumb(meta.avatar && meta.avatar.thumbnails), banner, subs: subText, handle,
      desc: meta.description || '', subscribed: subscribed === true, tabs,
      first: clean(collect(r.contents || {}).items, new Set()),
    };
  }
  function channelTab(info, which) {
    const t = info.tabs.find(x => x.url.endsWith('/' + which));
    if (!t) return null;
    return browseFeed(info.id, t.params);
  }
  async function channelVideos(id) {
    const info = await channel(id);
    const f = channelTab(info, 'videos');
    return f ? f.more() : info.first.filter(x => x.type === 'video');
  }

  /* ---------- listas ---------- */
  async function playlist(id) {
    const f = browseFeed('VL' + id);
    const first = await call('browse', { browseId: 'VL' + id });
    const c = collect(first);
    const seen = new Set();
    let cont = c.cont;
    const title = text(find(first.header || {}, 'title')) || text(find(first, 'title'));
    return {
      title, items: clean(c.items, seen),
      async more() { if (!cont) return []; const r = await call('browse', { continuation: cont }); const cc = collect(r); cont = cc.cont; return clean(cc.items, seen); },
      get done() { return !cont; },
    };
  }
  const history = () => browseFeed('FEhistory');
  const myPlaylists = () => browseFeed('FEplaylist_aggregation');

  /* ---------- acciones con tu cuenta ---------- */
  async function like(id, on) { await call(on ? 'like/like' : 'like/removelike', { target: { videoId: id } }); }
  async function subscribe(chId, on) { await call(on ? 'subscription/subscribe' : 'subscription/unsubscribe', { channelIds: [chId] }); }
  async function watchLater(id, on) {
    await call('browse/edit_playlist', { playlistId: 'WL', actions: [on ? { addedVideoId: id, action: 'ACTION_ADD_VIDEO' } : { removedVideoId: id, action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID' }] });
  }

  /* ---------- tu perfil: tu foto de la cuenta ---------- */
  // Sale de lo que YouTube ya manda con cada página (la barra de arriba de su web
  // trae tu foto): sin pedir nada más a YouTube.
  function grabMe(r) {
    try {
      const tb = find(r, 'topbarMenuButtonRenderer', 3000);
      const th = tb && tb.avatar && tb.avatar.thumbnails;
      if (!th || !th.length) return;
      let photo = bestThumb(th).replace(/=s\d+(-[^/]*)?$/, '=s176-c-k-c0x00ffffff-no-rj');
      const old = M4.store.get('me');
      if (old && old.photo === photo) return;
      const label = tb.accessibility && tb.accessibility.accessibilityData && tb.accessibility.accessibilityData.label || '';
      const v = { name: (old && old.name) || '', handle: (old && old.handle) || '', photo, label, at: Date.now() };
      M4.store.set('me', v);
      M4.emit('me', v);
    } catch {}
  }
  function me() { return Promise.resolve(connected() || (acct && acct.connected) ? M4.store.get('me') : null); }
  const meCached = () => { const c = M4.store.get('me'); return c && c.photo ? c : null; };
  const forgetMe = () => M4.store.set('me', null);

  return { getCfg, account, warm, me, meCached, forgetMe, chipFeed, connected, call, collect, clean, isShort, home, subscriptions, guideSubs, search, suggest, watch, moreRelated,
    channel, channelTab, channelVideos, playlist, history, myPlaylists, like, subscribe, watchLater, dlpFeed, text, find, findAll,
    shortsRemoved: () => shortsRemoved, ytId };
})();
