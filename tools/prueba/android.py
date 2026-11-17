#!/usr/bin/env python3
"""Prueba de Mix4Up en el emulador de Android: se ve un vídeo tuyo, YouTube
busca y se ve sin Shorts, todas las páginas, sin errores de JavaScript, sigue
sonando con la pantalla apagada, y se actualiza sola (desde un servidor de
pruebas con el APK nuevo). Uso: android.py <versionCode nuevo> <salida>"""
import json, os, re, subprocess, sys, time, urllib.request
import websocket
sys.path.insert(0, os.path.dirname(__file__))
import checks

PKG = 'com.luckicla.mix4up'
NEW = sys.argv[1]
OUT = sys.argv[2]
os.makedirs(OUT, exist_ok=True)
logf = open(os.path.join(OUT, 'prueba.log'), 'w', encoding='utf-8')
checks.log_fn = lambda m: (print(m, flush=True), logf.write(m + '\n'), logf.flush())


def adb(*a, timeout=120):
    try:
        return subprocess.run(['adb', *a], capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e:
        return str(e)


class Page:
    def __init__(self):
        self.ws, self.n = None, 0

    def connect(self):
        socks = re.findall(r'@(webview_devtools_remote_\d+)', adb('shell', 'cat', '/proc/net/unix'))
        if not socks:
            return False
        adb('forward', 'tcp:9222', 'localabstract:' + socks[-1])
        for _ in range(10):
            try:
                pages = json.load(urllib.request.urlopen('http://127.0.0.1:9222/json', timeout=5))
                pg = [p for p in pages if p.get('type') == 'page' and '127.0.0.1' in p.get('url', '')]
                if pg:
                    self.ws = websocket.create_connection(pg[0]['webSocketDebuggerUrl'], timeout=15, suppress_origin=True)
                    return True
            except Exception:
                pass
            time.sleep(1)
        return False

    def ev(self, js, timeout=60):
        for attempt in range(2):
            if not self.ws and not self.connect():
                time.sleep(2)
                continue
            self.n += 1
            try:
                self.ws.settimeout(timeout)
                self.ws.send(json.dumps({'id': self.n, 'method': 'Runtime.evaluate', 'params': {'expression': js, 'returnByValue': True, 'awaitPromise': True}}))
                while True:
                    m = json.loads(self.ws.recv())
                    if m.get('id') == self.n:
                        r = m.get('result', {}).get('result', {})
                        return r.get('value')
            except Exception as e:
                self.ws = None
        return None


def shot(name):
    adb('shell', 'screencap', '-p', '/sdcard/s.png')
    adb('pull', '/sdcard/s.png', os.path.join(OUT, name + '.png'))


def main():
    adb('logcat', '-c')
    adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity', '-e', 'm4update', 'http://10.0.2.2:8765/')
    time.sleep(20)
    p = Page()
    ev = p.ev
    if not checks.ready(ev, 120):
        shot('sin-cargar')
        return
    shot('abierta')
    checks.local_video(ev, 40)
    shot('mis-videos')
    # con la pantalla apagada: sigue sonando
    vid = ev("(Views.local().videos.find(v => /Largo/.test(v.file)) || Views.local().videos[0] || {}).id || ''")
    ev(f"location.hash = '#/watch?lid={vid}'")
    time.sleep(6)
    t0 = checks.player(ev).get('t', 0)
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    time.sleep(2)
    adb('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
    checks.say('pantalla apagada; esperando 60 s')
    time.sleep(60)
    st = checks.player(ev)
    t1 = st.get('t', 0)
    checks.res('Sigue sonando con la pantalla apagada', 'OK' if t1 - t0 > 45 and st.get('playing') else 'FALLO', f'{t0:.0f}s → {t1:.0f}s')
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'wm', 'dismiss-keyguard')
    time.sleep(2)
    adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity')
    time.sleep(5)
    ev('Player.pause()')
    if checks.wait_tools(ev, 300):
        vs = checks.yt_search(ev)
        shot('busqueda')
        if vs:
            checks.yt_play(ev, vs, 240)
            shot('video')
    checks.home(ev)
    shot('inicio')
    checks.pages(ev)
    checks.no_js_errors(ev)
    # actualizarse sola
    h0 = ev("Journal.all('hist').length + Journal.lists().length") or 0
    before = adb('shell', 'dumpsys', 'package', PKG)
    vc0 = (re.search(r'versionCode=(\d+)', before) or [None, '?'])[1]
    checks.say('versionCode antes:', vc0, '· nuevo:', NEW)
    ev('Mix4UpAndroid.installUpdate()')
    vc = None
    for _ in range(90):
        time.sleep(4)
        d = adb('shell', 'dumpsys', 'package', PKG)
        m = re.search(r'versionCode=(\d+)', d)
        if m and m.group(1) == NEW:
            vc = m.group(1)
            break
    checks.res('Se actualiza sola (sin preguntar)', 'OK' if vc else 'FALLO', f'{vc0} → {vc or "sin cambiar"}')
    if vc:
        adb('shell', 'am', 'start', '-n', PKG + '/.MainActivity')
        time.sleep(15)
        p2 = Page()
        checks.until(lambda: p2.ev('window.M4ready === true'), 60, 2)
        h1 = p2.ev("Journal.all('hist').length + Journal.lists().length") or 0
        checks.res('La versión nueva abre con los datos de antes', 'OK' if h1 >= h0 else 'FALLO', f'historial y listas: {h0} → {h1}')
        shot('actualizada')


try:
    main()
finally:
    for l in adb('logcat', '-d', '-v', 'brief').splitlines():
        if re.search(r'Uncaught|AndroidRuntime|FATAL|Mix4Up|chromium|cr_Media|MediaCodec|CCodec|VideoCapabilities', l):
            print('LOGCAT', l[:400], flush=True)
    for l in adb('shell', 'run-as', PKG, 'tail', '-n', '80', 'files/diag.log').splitlines():
        print('DIAG', l[:400], flush=True)
    open(os.path.join(OUT, 'logcat.txt'), 'w').write(adb('logcat', '-d', '-v', 'time'))
    open(os.path.join(OUT, 'diag.txt'), 'w').write(adb('shell', 'run-as', PKG, 'cat', 'files/diag.log'))
    ok = checks.summary(os.path.join(OUT, 'resumen.txt'))
    sys.exit(0 if ok else 1)
