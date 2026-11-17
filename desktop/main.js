'use strict';
// Mix4Up para escritorio: el motor (mix4up-core.exe, el programa en Go que lee
// tus vídeos y habla con YouTube) dentro de una ventana propia, con su icono,
// un instalador y una versión portable.
//
//  - Arranca mix4up-core.exe con -shell: sirve la interfaz en 127.0.0.1:47823
//    (MixUp usa el 47811: las dos pueden estar abiertas a la vez).
//  - Portable (Mix4Up-Portable.exe): los datos van en la carpeta .mix4up junto al .exe.
//  - Instalada: datos en %APPDATA%\Mix4Up; se actualiza sola con electron-updater
//    desde la release «mix4up-pc-latest».
//  - «Conectar con YouTube»: abre el inicio de sesión de Google en una ventana
//    de Mix4Up; las cookies de la sesión se guardan solo en este PC.
//  - Nunca se manda al navegador a descargar nada.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, net, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = 47823;
const URL = `http://127.0.0.1:${PORT}/`;
// (las pruebas automáticas ponen aquí un servidor propio)
const UPDATES = process.env.MIX4UP_UPDATES || 'https://github.com/luckicla/mix4up/releases/download/mix4up-pc-latest/';
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || '';
const portable = !!portableDir;
const TOKEN = crypto.randomBytes(16).toString('hex');
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

// lo de la ventana (su almacenamiento, la caché), dentro de la carpeta de datos de Mix4Up
try { app.setPath('userData', portable ? path.join(portableDir, '.mix4up', 'escritorio') : path.join(app.getPath('appData'), 'Mix4Up', 'escritorio')); } catch {}
app.setAppUserModelId('com.luckicla.mix4up.desktop');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'Translate');

const first = app.requestSingleInstanceLock();
if (!first) app.quit();

let win = null, core = null, quitting = false, updState = null;

function log(m) {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'escritorio.log'), `${new Date().toISOString()} ${m}\n`); } catch {}
}

function corePath() {
  const packed = path.join(process.resourcesPath || '', 'core', 'mix4up-core.exe');
  if (fs.existsSync(packed)) return packed;
  const dev = path.join(__dirname, 'bin', process.platform === 'win32' ? 'mix4up-core.exe' : 'mix4up-core');
  return fs.existsSync(dev) ? dev : '';
}

function startCore() {
  const exe = corePath();
  if (!exe) { log('no hay mix4up-core: se usa uno que ya esté abierto'); return; }
  const args = ['-shell', '-token', TOKEN];
  if (portable) args.push('-root', portableDir);
  const me = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: 'ignore' });
  core = me;
  me.on('exit', code => {
    log('mix4up-core salió: ' + code);
    if (core === me) core = null;
    if (!quitting) setTimeout(() => keepServed(), 2500);
  });
}

let restarts = [];
async function keepServed() {
  if (quitting || core) return;
  if (await up()) return;
  restarts = restarts.filter(t => Date.now() - t < 10 * 60e3);
  if (restarts.length >= 5) { log('mix4up-core no aguanta: se deja'); return; }
  restarts.push(Date.now());
  startCore();
  if (await waitCore(15000) && win) win.webContents.reload();
}
setInterval(() => { if (!quitting && !core) keepServed(); }, 15000);

function up() {
  return new Promise(ok => {
    const r = net.request({ url: URL + 'api/version', method: 'GET' });
    const t = setTimeout(() => { try { r.abort(); } catch {} ok(false); }, 2500);
    r.on('response', res => { clearTimeout(t); ok(res.statusCode === 200); res.on('data', () => {}); });
    r.on('error', () => { clearTimeout(t); ok(false); });
    r.end();
  });
}
async function waitCore(ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms || (core && Date.now() - t0 < 3 * 60e3)) {
    if (await up()) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

function iconPath() {
  const p = path.join(process.resourcesPath || '', 'icon.ico');
  if (fs.existsSync(p)) return p;
  const dev = path.join(__dirname, 'build', 'icon.ico');
  return fs.existsSync(dev) ? dev : undefined;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 380, minHeight: 560,
    backgroundColor: '#0f0f13', title: 'Mix4Up', icon: iconPath(), autoHideMenuBar: true, show: false,
    // sin la barra de Windows: la pone la página (flechas, lo que suena, minimizar/maximizar/cerrar)
    frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, backgroundThrottling: false, spellcheck: false },
  });
  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'splash.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });
  win.on('closed', () => { win = null; });
  const maxState = () => { if (win) win.webContents.send('shell-win', { max: win.isMaximized(), full: win.isFullScreen() }); };
  win.on('maximize', maxState); win.on('unmaximize', maxState);
  win.on('enter-full-screen', maxState); win.on('leave-full-screen', maxState);
  win.on('enter-html-full-screen', maxState); win.on('leave-html-full-screen', maxState);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
});

app.whenReady().then(async () => {
  if (!first) return;
  createWindow();
  if (portable) setTimeout(cleanPortable, 8000);
  startCore();
  const ok = await waitCore();
  if (!win) return;
  if (!ok) { win.webContents.executeJavaScript(`document.body.classList.add('err')`).catch(() => {}); return; }
  await win.loadURL(URL);
  setTimeout(checkUpdates, 15000);
  setInterval(checkUpdates, 6 * 3600e3);
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; if (core) { try { core.kill(); } catch {} } });

/* ---------- lo que la página puede pedir (preload.js → window.Mix4UpShell) ---------- */
ipcMain.handle('shell', async (_e, what, arg) => {
  switch (what) {
    case 'win':
      if (!win) return null;
      if (arg === 'min') win.minimize();
      else if (arg === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
      else if (arg === 'close') win.close();
      return { max: win.isMaximized(), full: win.isFullScreen() };
    case 'info': return { version: app.getVersion(), portable, dir: portableDir };
    case 'check': checkUpdates(true); return updState;
    case 'install': return installUpdate();
    case 'state': return updState;
    case 'login': return login();
    case 'logout': try { await session.fromPartition('persist:youtube').clearStorageData(); } catch {} return true;
    case 'pickFolder': {
      const r = await dialog.showOpenDialog(win, { title: 'Elige una carpeta con vídeos', properties: ['openDirectory'] });
      return r.canceled ? '' : r.filePaths[0];
    }
    case 'quit': quitting = true; setTimeout(() => app.quit(), 200); return true;
  }
  return null;
});

/* ---------- «Conectar con YouTube» ----------
   Una ventana con el inicio de sesión de Google (con su propio almacén, como
   un navegador aparte). Cuando YouTube ya te reconoce, Mix4Up copia las
   cookies de youtube.com al motor (que las guarda en la carpeta de datos) y
   la ventana se cierra. Nada sale de este PC. */
let loginWin = null;
function login() {
  if (loginWin) { loginWin.focus(); return Promise.resolve({ ok: false, msg: 'Ya hay una ventana de inicio de sesión abierta' }); }
  return new Promise(resolve => {
    const ses = session.fromPartition('persist:youtube');
    ses.setUserAgent(CHROME_UA, 'es-ES,es');
    loginWin = new BrowserWindow({
      width: 520, height: 720, parent: win || undefined, modal: false, title: 'Conectar con YouTube · Mix4Up', icon: iconPath(), autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, sandbox: true, spellcheck: false },
    });
    loginWin.webContents.setUserAgent(CHROME_UA);
    loginWin.webContents.setWindowOpenHandler(({ url }) => { loginWin.loadURL(url); return { action: 'deny' }; });
    const next = encodeURIComponent('https://www.youtube.com/signin?action_handle_signin=true&app=desktop&hl=es&next=%2F');
    loginWin.loadURL('https://accounts.google.com/ServiceLogin?service=youtube&hl=es&passive=true&continue=' + next);
    let done = false;
    const finish = r => { if (done) return; done = true; clearInterval(poll); const w = loginWin; loginWin = null; if (w && !w.isDestroyed()) w.close(); resolve(r); };
    const poll = setInterval(async () => {
      try {
        if (!loginWin || loginWin.isDestroyed()) return;
        const u = loginWin.webContents.getURL();
        const cs = await ses.cookies.get({ url: 'https://www.youtube.com' });
        const has = n => cs.some(c => c.name === n);
        if (u.startsWith('https://www.youtube.com') && (has('SAPISID') || has('__Secure-3PAPISID')) && has('LOGIN_INFO')) {
          const all = (await ses.cookies.get({ domain: 'youtube.com' })).map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure, hostOnly: c.hostOnly, expirationDate: c.expirationDate || 0 }));
          const ok = await sendCookies(all);
          log('youtube: sesión ' + (ok ? 'guardada' : 'NO guardada') + ' (' + all.length + ' cookies)');
          finish(ok ? { ok: true } : { ok: false, msg: 'No se pudo guardar la sesión. Vuelve a intentarlo.' });
        }
      } catch (e) { log('login: ' + e.message); }
    }, 1500);
    loginWin.on('closed', () => finish({ ok: false }));
  });
}
function sendCookies(list) {
  return new Promise(ok => {
    const r = net.request({ url: URL + 'api/yt/cookies?k=' + TOKEN, method: 'POST' });
    r.setHeader('Content-Type', 'application/json');
    r.on('response', res => { ok(res.statusCode === 200); res.on('data', () => {}); });
    r.on('error', () => ok(false));
    r.end(JSON.stringify(list));
  });
}

/* ---------- actualizaciones ---------- */
let wantInstall = false;
function tell(s) {
  updState = s;
  if (win) win.webContents.send('shell-update', s);
  if (s.state === 'ready' && wantInstall) { wantInstall = false; setTimeout(installUpdate, 1200); }
  if (s.state === 'error' || s.state === 'none') wantInstall = false;
}
const newer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); }
  return false;
};
async function autoOn() {
  if (!win) return true;
  try { return (await win.webContents.executeJavaScript('(() => { try { return M4.Settings.get().autoUpdate !== false } catch (e) { return true } })()')) !== false; }
  catch { return true; }
}

/* La portable: se baja la nueva (comprobada con su sha256) junto a la de
   ahora, y un PowerShell lanzado por Windows (WMI, así el lanzador de la
   portable no lo cierra) la pone en su sitio y la abre. */
const portableFile = process.env.PORTABLE_EXECUTABLE_FILE || '';
let portableNew = null;

async function getText(url) {
  const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error(url.split('/').pop() + ': HTTP ' + r.status);
  return r.text();
}
async function download(url, dest, sha) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
  const total = Number(r.headers.get('content-length')) || 0;
  const part = dest + '.part';
  const h = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0, last = -1;
  try {
    const rd = r.body.getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      h.update(value);
      if (!out.write(Buffer.from(value))) await new Promise(ok => out.once('drain', ok));
      got += value.length;
      const pct = total ? Math.floor(got * 100 / total) : 0;
      if (pct !== last) { last = pct; tell({ state: 'downloading', pct }); }
    }
    await new Promise((ok, ko) => out.end(e => e ? ko(e) : ok()));
  } catch (e) { out.destroy(); try { fs.unlinkSync(part); } catch {} throw e; }
  if (sha && h.digest('hex').toLowerCase() !== sha.toLowerCase()) { try { fs.unlinkSync(part); } catch {} throw new Error('la descarga no coincide'); }
  try { fs.unlinkSync(dest); } catch {}
  fs.renameSync(part, dest);
}
async function checkPortable(manual) {
  tell({ state: 'checking' });
  const f = (await getText(UPDATES + 'desktop.txt')).trim().split(/\s+/);
  if (f.length < 3) throw new Error('desktop.txt vacío');
  const [ver, , sha] = f;
  if (!newer(ver, app.getVersion())) { tell({ state: 'none', version: app.getVersion() }); return; }
  if (!portableFile) { tell({ state: 'error', msg: 'no se sabe dónde está la portable' }); return; }
  if (!manual && !(await autoOn())) { tell({ state: 'available', version: ver }); return; }
  const dest = portableFile.replace(/\.exe$/i, '') + '.nueva.exe';
  tell({ state: 'downloading', pct: 0, version: ver });
  await download(UPDATES + 'Mix4Up-Portable.exe', dest, sha);
  portableNew = { version: ver, file: dest };
  log('portable: ' + ver + ' lista en ' + dest);
  tell({ state: 'ready', version: ver });
}
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function runPS(script) {
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  const inner = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ' + enc;
  const outer = `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${inner}'; ProcessStartupInformation = $si }
exit [int]$r.ReturnValue`;
  return new Promise(ok => {
    let done = false;
    const end = how => { if (!done) { done = true; log('cambio: ' + how); ok(); } };
    try {
      const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
      c.on('error', e => end('powershell: ' + e.message));
      c.on('exit', code => {
        if (code !== 0) {
          try { const d = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { detached: true, stdio: 'ignore', windowsHide: true }); d.on('error', () => {}); d.unref(); } catch {}
        }
        end('lanzado (' + code + ')');
      });
      setTimeout(() => end('sin respuesta, sigo'), 15000);
    } catch (e) { end('powershell: ' + e.message); }
  });
}
async function installPortable() {
  const { file } = portableNew;
  const target = portableFile;
  const old = target.replace(/\.exe$/i, '') + '.vieja.exe';
  const plog = path.join(app.getPath('userData'), 'cambio.log');
  try {
    try { fs.unlinkSync(old); } catch {}
    fs.renameSync(target, old);
    try { fs.renameSync(file, target); }
    catch (e) { fs.renameSync(old, target); throw e; }
    log('portable: cambiada por la ' + portableNew.version);
  } catch (e) { log('portable: no se pudo cambiar ahora (' + e.message + '), se cambia al cerrar'); }
  const pids = [process.pid, process.ppid].filter(n => n > 0).join(',');
  const script = `$ErrorActionPreference = 'SilentlyContinue'
$dst = ${psQuote(target)}; $new = ${psQuote(file)}; $old = ${psQuote(old)}; $log = ${psQuote(plog)}
function L($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) }
L 'esperando a que se cierre'
for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process -Id ${pids} -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
Get-Process -Name mix4up-core -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*' } | Stop-Process -Force
if (Test-Path -LiteralPath $new) {
  for ($i = 0; $i -lt 120; $i++) {
    try { Move-Item -LiteralPath $new -Destination $dst -Force -ErrorAction Stop; L 'cambiada'; break } catch { Start-Sleep -Milliseconds 500 }
  }
}
Start-Sleep -Milliseconds 500
L ('abriendo ' + $dst)
Start-Process -FilePath $dst -WorkingDirectory (Split-Path -Parent $dst)
for ($i = 0; $i -lt 40 -and (Test-Path -LiteralPath $old); $i++) { Start-Sleep -Milliseconds 500; Remove-Item -LiteralPath $old -Force }
L 'hecho'`;
  tell({ state: 'installing', version: portableNew.version });
  await runPS(script);
  quitting = true;
  if (core) { try { core.kill(); } catch {} }
  setTimeout(() => app.exit(0), 300);
}
function cleanPortable() {
  if (!portableFile) return;
  for (const n of ['.vieja.exe', '.nueva.exe.part']) { try { fs.unlinkSync(portableFile.replace(/\.exe$/i, '') + n); } catch {} }
}
/* La instalada: el instalador nuevo, lanzado por un PowerShell que arranca
   Windows cuando esta se cierra: en silencio, sin preguntar, y abre Mix4Up al
   acabar. El instalador de Windows a veces se cae al empezar: hasta 3 intentos;
   si no puede, se abre la de antes (nunca te quedas sin Mix4Up). */
async function installQuiet(file) {
  const plog = path.join(app.getPath('userData'), 'actualizar.log');
  const script = `$ErrorActionPreference = 'SilentlyContinue'
$f = ${psQuote(file)}; $app = ${psQuote(process.execPath)}; $log = ${psQuote(plog)}
function L($m) { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) }
L 'esperando a que se cierre'
for ($i = 0; $i -lt 120; $i++) { if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 250 }
Get-Process -Name mix4up-core -ErrorAction SilentlyContinue | Stop-Process -Force
$ok = $false
for ($try = 1; $try -le 3 -and -not $ok; $try++) {
  L ('instalando, intento ' + $try)
  $p = Start-Process -FilePath $f -ArgumentList '--updated', '/S', '--force-run' -Wait -PassThru
  L ('instalador: ' + $p.ExitCode)
  if ($p.ExitCode -eq 0) { $ok = $true } else { Start-Sleep -Seconds 3 }
}
if (-not $ok) { L 'no se pudo: se abre la de antes'; Start-Process -FilePath $app }
L 'hecho'`;
  tell({ state: 'installing', version: updState.version });
  try { require('electron-updater').autoUpdater.autoInstallOnAppQuit = false; } catch {}
  await runPS(script);
  quitting = true;
  if (core) { try { core.kill(); } catch {} }
  setTimeout(() => app.exit(0), 300);
}
let installing = false;
function installUpdate() {
  if (installing) return true;
  if (!updState || updState.state !== 'ready') { wantInstall = true; checkUpdates(true); return false; }
  installing = true;
  log('instalando ' + updState.version);
  if (portable) {
    if (!portableNew) { installing = false; return false; }
    installPortable().catch(e => { log('portable: ' + e.message); installing = false; tell({ state: 'error', msg: e.message }); });
    return true;
  }
  if (updFile && fs.existsSync(updFile)) {
    installQuiet(updFile).catch(e => { log('instalar: ' + e.message); installing = false; tell({ state: 'error', msg: e.message }); });
    return true;
  }
  quitting = true;
  if (core) { try { core.kill(); } catch {} }
  try { require('electron-updater').autoUpdater.quitAndInstall(true, true); }
  catch (e) { log('instalar: ' + e.message); quitting = false; installing = false; tell({ state: 'error', msg: e.message }); return false; }
  return true;
}
let au = null, checking = false, updFile = '';
async function checkUpdates(manual) {
  if (!app.isPackaged || checking || installing) return;
  if (updState && updState.state === 'ready') { tell(updState); return; }
  if (updState && updState.state === 'downloading') return;
  checking = true;
  try {
    if (portable) { await checkPortable(manual); return; }
    if (!au) {
      au = require('electron-updater').autoUpdater;
      au.logger = { info: m => log('updater: ' + m), warn: m => log('updater: ' + m), error: m => log('updater: ' + m), debug: () => {} };
      au.autoInstallOnAppQuit = true;
      if (process.env.MIX4UP_UPDATES) au.setFeedURL({ provider: 'generic', url: UPDATES });
      au.on('checking-for-update', () => tell({ state: 'checking' }));
      au.on('update-available', i => { if (!au.autoDownload) tell({ state: 'available', version: i.version }); });
      au.on('update-not-available', () => tell({ state: 'none', version: app.getVersion() }));
      au.on('download-progress', p => tell({ state: 'downloading', pct: Math.round(p.percent || 0) }));
      au.on('update-downloaded', i => { updFile = i.downloadedFile || ''; tell({ state: 'ready', version: i.version }); });
      au.on('error', e => { log('actualizar: ' + (e && e.message)); tell({ state: 'error', msg: e && e.message }); });
    }
    au.autoDownload = manual || await autoOn();
    const r = await au.checkForUpdates();
    if (r && r.downloadPromise) await r.downloadPromise.catch(() => {});
  } catch (e) {
    log('actualizar: ' + e.message);
    tell({ state: 'error', msg: e.message });
  } finally { checking = false; }
}
