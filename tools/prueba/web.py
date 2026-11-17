#!/usr/bin/env python3
"""Prueba de Mix4Up en Linux: el motor (compilado aquí) + Chrome, con internet de
verdad (YouTube de verdad). Uso: web.py <motor> <carpeta de vídeos> <salida>"""
import os, subprocess, sys, time
from playwright.sync_api import sync_playwright
sys.path.insert(0, os.path.dirname(__file__))
import checks

core, vids, out = sys.argv[1], os.path.abspath(sys.argv[2]), sys.argv[3]
os.makedirs(out, exist_ok=True)
logf = open(os.path.join(out, 'prueba.log'), 'w', encoding='utf-8')
checks.log_fn = lambda m: (print(m, flush=True), logf.write(m + '\n'), logf.flush())
env = dict(os.environ, MIX4UP_VIDEOS=vids)
srv = subprocess.Popen([core, '-data', os.path.join(out, 'datos')], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
time.sleep(2)
ok = False
try:
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel='chrome', args=['--autoplay-policy=no-user-gesture-required'])
        p = b.new_page(viewport={'width': 1366, 'height': 820})
        p.on('pageerror', lambda e: checks.say('[error de la página]', e))
        p.on('console', lambda m: checks.say('[consola]', m.type, m.text[:300]) if m.type == 'error' else None)
        p.goto('http://127.0.0.1:47823/')
        ev = lambda js: p.evaluate(js)
        if checks.ready(ev):
            checks.local_video(ev)
            p.screenshot(path=os.path.join(out, 'mis-videos.png'))
            checks.wait_tools(ev, 60)
            vs = checks.yt_search(ev)
            p.screenshot(path=os.path.join(out, 'busqueda.png'))
            if vs:
                checks.yt_play(ev, vs)
                p.screenshot(path=os.path.join(out, 'video.png'))
            checks.home(ev)
            p.screenshot(path=os.path.join(out, 'inicio.png'))
            checks.pages(ev)
            m = b.new_page(viewport={'width': 400, 'height': 860})
            m.goto('http://127.0.0.1:47823/#/local')
            time.sleep(4)
            m.screenshot(path=os.path.join(out, 'movil.png'))
            checks.no_js_errors(ev)
        ok = checks.summary(os.path.join(out, 'resumen.txt'))
        b.close()
finally:
    srv.terminate()
    try:
        logf.write(open(os.path.join(out, 'datos', 'mix4up.log'), encoding='utf-8').read())
    except Exception:
        pass
sys.exit(0 if ok else 1)
