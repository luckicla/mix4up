// Nombre, descripción, versión e icono de Mix4Up dentro del .exe (si no,
// Windows lo enseña como «Electron» en el cortafuegos y el administrador de tareas).
const path = require('path');
module.exports = async ctx => {
  if (ctx.electronPlatformName !== 'win32') return;
  const exe = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.exe');
  const m = require('rcedit'), rcedit = m.rcedit || m.default || m;
  const v = ctx.packager.appInfo.version;
  await rcedit(exe, {
    icon: path.join(__dirname, 'icon.ico'),
    'file-version': v, 'product-version': v,
    'version-string': { CompanyName: 'luckicla', FileDescription: 'Mix4Up', ProductName: 'Mix4Up', InternalName: 'Mix4Up',
      OriginalFilename: 'Mix4Up.exe', LegalCopyright: '© 2026 luckicla' },
  });
  console.log('  • Mix4Up: nombre e icono puestos en ' + path.basename(exe));
};
