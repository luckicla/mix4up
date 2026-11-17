"""Las comprobaciones de Mix4Up, las mismas en el PC (la app de escritorio),
en Linux (el motor + Chrome) y en el emulador de Android. Cada una recibe
ev(js): evalúa JavaScript en la página de Mix4Up y devuelve el resultado.

Resultado: lista de (nombre, 'OK' | 'FALLO' | 'AVISO', detalle)."""
import json, time

results = []
log_fn = print


def say(*a):
    m = time.strftime('%H:%M:%S ') + ' '.join(str(x) for x in a)
    log_fn(m)


def res(name, state, detail=''):
    results.append((name, state, detail))
    say(('✔' if state == 'OK' else '✖' if state == 'FALLO' else '!'), name, '·', detail)


def until(fn, secs, step=1.0):
    t0 = time.time()
    last = None
    while time.time() - t0 < secs:
        try:
            last = fn()
        except Exception as e:
            last = None
        if last:
            return last
        time.sleep(step)
    return None


ERRS = """(() => { if (!window.__m4errs) { window.__m4errs = []; addEventListener('error', e => __m4errs.push(String(e.message) + ' @' + String(e.filename).split('/').pop() + ':' + e.lineno)); addEventListener('unhandledrejection', e => __m4errs.push('promesa: ' + String(e.reason && (e.reason.stack || e.reason)).slice(0, 300))); } return true })()"""

PLAYER = "JSON.stringify({id: (Player.item || {}).id || (Player.item || {}).lid || '', t: Player.time, playing: Player.playing, split: !!Player.audio.getAttribute('src'), vsrc: Player.video.getAttribute('src'), err: (document.querySelector('.perr p') || {}).textContent || '', title: (Player.item || {}).title || ''})"


def player(ev):
    try:
        return json.loads(ev(PLAYER))
    except Exception:
        return {}


def ready(ev, secs=90):
    ok = until(lambda: ev('window.M4ready === true') is True, secs, 1)
    ev(ERRS)
    res('La página de Mix4Up carga', 'OK' if ok else 'FALLO', '' if ok else 'M4ready no llegó')
    return ok


def local_video(ev, secs=25):
    ev("location.hash = '#/local?r=1'")
    n = until(lambda: ev("(Views.local().videos || []).length") or None, 30, 1)
    if not n:
        res('Mis vídeos: salen los vídeos', 'FALLO', 'no hay vídeos en la biblioteca')
        return False
    res('Mis vídeos: salen los vídeos', 'OK', f'{n} vídeos')
    vid = ev("(Views.local().videos.find(v => v.native) || {}).id || ''")
    ev(f"location.hash = '#/watch?lid={vid}'")
    st = until(lambda: (lambda p: p if p.get('t', 0) > 2 and p.get('playing') else None)(player(ev)), secs, 1)
    res('Un vídeo tuyo se ve', 'OK' if st else 'FALLO', json.dumps(st or player(ev), ensure_ascii=False))
    thumbs = until(lambda: ev("fetch('/thumb/' + Views.local().videos[0].id).then(r => r.status)") == 200 or None, 30, 2)
    res('Miniaturas de tus vídeos', 'OK' if thumbs else 'AVISO', '' if thumbs else 'aún sin miniatura')
    return bool(st)


def wait_tools(ev, secs=300):
    t = until(lambda: ev("M4.api('/api/yt/tools').then(t => t.ready)") or None, secs, 3)
    res('yt-dlp preparado', 'OK' if t else 'FALLO', '' if t else 'yt-dlp no llegó a estar listo')
    return t


def yt_search(ev, q='documental naturaleza 4k'):
    r = ev("""(async () => { try { const f = YT.search(%s); let it = await f.more(); if (it.length < 10) it = it.concat(await f.more());
      return JSON.stringify({ n: it.length, videos: it.filter(x => x.type === 'video').map(x => ({ id: x.id, t: x.title, d: x.dur, s: YT.isShort(x) })), removed: YT.shortsRemoved() }) }
      catch (e) { return JSON.stringify({ error: String(e.message || e) }) } })()""" % json.dumps(q))
    r = json.loads(r or '{}')
    if r.get('error') or not r.get('videos'):
        res('Búsqueda en YouTube', 'FALLO', r.get('error') or 'sin resultados')
        return []
    shorts = [v for v in r['videos'] if v['s']]
    res('Búsqueda en YouTube', 'OK', f"{len(r['videos'])} vídeos, {r['removed']} Shorts quitados")
    res('Sin Shorts en la búsqueda', 'OK' if not shorts else 'FALLO', json.dumps(shorts, ensure_ascii=False)[:300])
    return r['videos']


def yt_play(ev, videos, secs=150):
    cands = [v for v in videos if (v.get('d') or 0) > 120][:3] or videos[:3]
    for v in cands:
        ev(f"location.hash = '#/watch?v={v['id']}'")
        time.sleep(2)
        st = until(lambda: (lambda p: p if p.get('id') == v['id'] and ((p.get('t', 0) > 3 and p.get('playing')) or p.get('err')) else None)(player(ev)), secs, 2)
        st = st or player(ev)
        if st.get('t', 0) > 3:
            res('Un vídeo de YouTube se ve (sin anuncios)', 'OK', f"{v['t'][:60]} · imagen y sonido separados: {st.get('split')} · {st.get('vsrc')}")
            time.sleep(8)
            prog = ev(f"M4.api('/api/yt/cache?id={v['id']}').then(p => JSON.stringify(p))")
            res('Se va bajando entero en segundo plano', 'OK' if prog and prog != '{}' else 'AVISO', str(prog))
            # cambiar de calidad sin cortar
            q = ev("(() => { const hs = [...new Set((Player.info && Player.info.formats || []).filter(f => f.kind === 'v' && f.h).map(f => f.h))].sort((a, b) => a - b); return hs[0] || 0 })()")
            if q:
                ev(f"M4.Settings.set({{quality: '{q}'}}); Player.openMenu('quality'); [...document.querySelectorAll('.player .menu button')].find(b => b.textContent.startsWith('{q}p'))?.click()")
                st2 = until(lambda: (lambda p: p if p.get('playing') and str(p.get('vsrc', '')).count('/') >= 3 else None)(player(ev)), 30, 2)
                t1 = player(ev).get('t', 0)
                time.sleep(4)
                t2 = player(ev).get('t', 0)
                res('Cambiar de calidad', 'OK' if t2 > t1 else 'FALLO', f'{q}p · {t1:.1f}s → {t2:.1f}s')
                ev("M4.Settings.set({quality: 'auto'})")
            rel = until(lambda: ev("document.querySelectorAll('.related .card').length") or None, 40, 2)
            shorts = ev("JSON.stringify([...document.querySelectorAll('.related .card h3')].map(h => h.textContent).filter(t => /#shorts?/i.test(t)))")
            res('Relacionados del vídeo', 'OK' if rel else 'AVISO', f'{rel or 0} vídeos')
            res('Sin Shorts en relacionados', 'OK' if shorts in ('[]', None) else 'FALLO', shorts)
            time.sleep(6)  # (más de 10 s visto: cuenta en el historial)
            return v
        say('no se ve', v['id'], st)
        last = st
    err = (last or {}).get('err', '') if cands else 'sin candidatos'
    bot = 'robot' in err or 'bot' in err
    res('Un vídeo de YouTube se ve (sin anuncios)', 'AVISO' if bot else 'FALLO', err or json.dumps(last, ensure_ascii=False))
    return None


def home(ev):
    ev("location.hash = '#/'")
    n = until(lambda: ev("document.querySelectorAll('#view .grid .card').length") or None, 90, 2)
    shorts = ev("JSON.stringify([...document.querySelectorAll('#view .grid .card a.thumb')].map(a => a.getAttribute('href')).filter(h => /shorts/.test(h)))")
    res('Inicio con recomendaciones', 'OK' if n else 'AVISO', f'{n or 0} vídeos')
    res('Sin Shorts en el inicio', 'OK' if shorts in ('[]', None) else 'FALLO', shorts)


def pages(ev):
    bad = []
    for h in ['#/subs', '#/history', '#/later', '#/likes', '#/lists', '#/downloads', '#/settings', '#/library']:
        ev(f"location.hash = '{h}'")
        time.sleep(2.5)
        txt = ev("document.querySelector('#view').innerText.length")
        if not txt:
            bad.append(h)
    res('Todas las páginas se abren (nada en blanco)', 'OK' if not bad else 'FALLO', ', '.join(bad))


def no_js_errors(ev):
    e = ev("JSON.stringify(window.__m4errs || [])")
    errs = json.loads(e or '[]')
    res('Sin errores de JavaScript', 'OK' if not errs else 'FALLO', json.dumps(errs, ensure_ascii=False)[:600])


def summary(out_path=None):
    lines = [f"{'OK   ' if s == 'OK' else 'FALLO' if s == 'FALLO' else 'AVISO'}  {n}  {d}" for n, s, d in results]
    text = '\n'.join(lines)
    say('\n==== RESUMEN ====\n' + text)
    if out_path:
        open(out_path, 'w', encoding='utf-8').write(text + '\n')
    return not any(s == 'FALLO' for _, s, _ in results)
