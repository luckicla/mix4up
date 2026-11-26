// Windows: nombre, descripción, versión e icono de Mix4Up dentro del .exe (si no,
// Windows lo enseña como «Electron» en el cortafuegos y el administrador de tareas).
// Mac: sin certificado de Apple, la app se firma «ad hoc» (sin nombre). Sin eso,
// los Mac con chip de Apple dicen que la app «está dañada» y no la dejan abrir.
const path = require('path');
module.exports = async ctx => {
  if (ctx.electronPlatformName === 'darwin') return signMac(ctx);
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

function signMac(ctx) {
  // la universal se arma con dos medias (x64 y arm64, carpetas «-temp»): se firma solo la de verdad
  if (/-temp$/.test(ctx.appOutDir)) return;
  const app = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app');
  const { execFileSync } = require('child_process');
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log('  • Mix4Up: ' + path.basename(app) + ' firmada ad hoc (sin certificado)');
}
