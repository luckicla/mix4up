// Ventana de inicio de sesión de Google: que parezca un Firefox normal.
// Google bloquea los navegadores «incrustados» (dice «puede que este navegador o
// esta aplicación no sean seguros») mirando estas pistas de Chromium/Electron.
const { webFrame } = require('electron');
webFrame.executeJavaScript(`(() => {
  const N = Navigator.prototype;
  try { Object.defineProperty(N, 'userAgentData', { get: () => undefined, configurable: true }); } catch (e) {}
  try { Object.defineProperty(N, 'webdriver', { get: () => false, configurable: true }); } catch (e) {}
  try { Object.defineProperty(N, 'vendor', { get: () => '', configurable: true }); } catch (e) {}
  try { delete window.chrome; } catch (e) {}
})();`);
