#!/usr/bin/env python3
"""Prueba de la app de escritorio de Mix4Up en un Windows de verdad.

  pc.py todo <puerto-cdp> <salida>          las comprobaciones (vídeos, YouTube, sin Shorts, páginas, errores)
  pc.py update <puerto-cdp> <versión> <salida>  pulsa «Actualizar» y espera a que abra la nueva"""
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(__file__))
import checks

URL = 'http://127.0.0.1:47823'


def get(u, t=3):
    try:
        return urllib.request.urlopen(u, timeout=t).read().decode('utf-8', 'replace')
    except Exception:
        return ''


def connect(pw, port, out):
    if not checks.until(lambda: get(f'http://127.0.0.1:{port}/json/version'), 180):
        checks.res('La ventana de Mix4Up se abre', 'FALLO', 'sin conexión con la ventana')
        sys.exit(1)
    b = p = None
    for _ in range(15):
        if b:
            try: b.close()
            except Exception: pass
        b = pw.chromium.connect_over_cdp(f'http://127.0.0.1:{port}')
        p = checks.until(lambda: next((q for c in b.contexts for q in c.pages if q.url.startswith(URL)), None), 20, 1)
        if p:
            break
    if not p:
        checks.res('La ventana de Mix4Up se abre', 'FALLO', str([q.url for c in b.contexts for q in c.pages]))
        sys.exit(1)
    p.on('pageerror', lambda e: checks.say('[error de la página]', e))
    p.on('console', lambda m: checks.say('[consola]', m.type, m.text[:300]) if m.type == 'error' else None)
    return b, p


def main():
    what, port, out = sys.argv[1], int(sys.argv[2]), sys.argv[-1]
    os.makedirs(out, exist_ok=True)
    logf = open(os.path.join(out, 'prueba-' + what + '.log'), 'a', encoding='utf-8')
    checks.log_fn = lambda m: (print(m, flush=True), logf.write(m + '\n'), logf.flush())
    with sync_playwright() as pw:
        b, p = connect(pw, port, out)
        ev = lambda js: p.evaluate(js)
        if what == 'todo':
            if checks.ready(ev):
                p.screenshot(path=os.path.join(out, 'abierta.png'))
                bar = ev("JSON.stringify({tb: document.documentElement.classList.contains('tb'), ctl: !document.getElementById('wctl').hidden})")
                checks.res('Barra de arriba propia (minimizar, maximizar, cerrar)', 'OK' if '"tb":true' in bar and '"ctl":true' in bar else 'FALLO', bar)
                checks.local_video(ev)
                p.screenshot(path=os.path.join(out, 'mis-videos.png'))
                if checks.wait_tools(ev, 420):
                    vs = checks.yt_search(ev)
                    if vs:
                        checks.yt_play(ev, vs)
                        p.screenshot(path=os.path.join(out, 'video.png'))
                checks.home(ev)
                p.screenshot(path=os.path.join(out, 'inicio.png'))
                checks.pages(ev)
                checks.no_js_errors(ev)
            ok = checks.summary(os.path.join(out, 'resumen.txt'))
            sys.exit(0 if ok else 1)
        if what == 'update':
            want = sys.argv[3]
            checks.ready(ev)
            info = ev('Mix4UpShell.info()')
            checks.say('app ahora:', info, '· nueva:', want)
            checks.say('pulso Actualizar:', ev('Mix4UpShell.install()'))
            t0, last, gone = time.time(), None, False
            while time.time() - t0 < 600:
                try:
                    s = ev('Mix4UpShell.state()')
                except Exception:
                    checks.say('la ventana se cerró (se está actualizando)')
                    gone = True
                    break
                if s != last:
                    checks.say('estado:', s)
                    last = s
                    if s and s.get('state') == 'error':
                        p.screenshot(path=os.path.join(out, 'error-actualizar.png'))
                        checks.res('Se actualiza sola', 'FALLO', json.dumps(s, ensure_ascii=False))
                        checks.summary(os.path.join(out, 'resumen-update.txt'))
                        sys.exit(1)
                time.sleep(1)
    if not gone:
        checks.res('Se actualiza sola', 'FALLO', 'no llegó a instalarse')
        sys.exit(1)
    # la vieja se cierra y la nueva se abre sola: el motor vuelve a contestar
    time.sleep(5)
    v = checks.until(lambda: get(URL + '/api/version'), 420, 2)
    checks.res('Se actualiza sola y se abre la nueva', 'OK' if v else 'FALLO', v or 'no volvió a abrirse')
    sys.exit(0 if v else 1)


if __name__ == '__main__':
    main()
