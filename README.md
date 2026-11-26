# Mix4Up

**Tus vídeos y YouTube, sin Shorts y sin anuncios.** Hermano de [MixUp](https://github.com/luckicla/zentor).

- Tu inicio de YouTube (las mismas recomendaciones), suscripciones, historial, Ver más tarde, Me gusta y listas, conectando tu cuenta (la sesión se guarda solo en tu aparato).
- Ni un Short: ni en inicio, búsquedas, canales, relacionados ni suscripciones.
- Tu cola: un botón encima de cada portada para ir poniendo vídeos y verlos poco a poco, en orden.
- Pestañas dentro de la app: clic con la rueda (o ⋮ → «Abrir en una pestaña nueva»).
- Los comentarios de cada vídeo, con sus respuestas.
- Reproductor propio: pantalla completa, gestos, velocidad, subtítulos, imagen dentro de imagen, calidad, A-B, temporizador para dormir, y en segundo plano.
- En la máxima calidad que tenga el vídeo (4K, 8K…), sin esperar a nada.
- Rápido: al abrir un vídeo se baja entero en segundo plano con varias conexiones a la vez.
- Tus vídeos locales (MP4, MKV, WebM, MOV, AVI…) con miniaturas y «seguir donde lo dejaste».
- Descargas de YouTube en la calidad que elijas.
- Sincronización móvil ↔ PC por WiFi y «Seguir aquí».
- Windows (instalador y portable), Mac (Intel y Apple Silicon) y Android (APK). Se actualizan solas (el Mac avisa de la nueva y abre la web para bajarla).

Web: https://luckicla.github.io/mix4up/ · Descargas: [Releases](https://github.com/luckicla/mix4up/releases)

| | Descarga |
|---|---|
| Windows | [Mix4Up-Instalador.exe](https://github.com/luckicla/mix4up/releases/download/mix4up-pc-latest/Mix4Up-Instalador.exe) · [Mix4Up-Portable.exe](https://github.com/luckicla/mix4up/releases/download/mix4up-pc-latest/Mix4Up-Portable.exe) |
| Mac | [Mix4Up-Mac.dmg](https://github.com/luckicla/mix4up/releases/download/mix4up-mac-latest/Mix4Up-Mac.dmg) · [Mix4Up-Mac.zip](https://github.com/luckicla/mix4up/releases/download/mix4up-mac-latest/Mix4Up-Mac.zip) |
| Android | [Mix4Up.apk](https://github.com/luckicla/mix4up/releases/download/mix4up-android-latest/Mix4Up.apk) |

### En el Mac

Abre `Mix4Up-Mac.dmg` y arrastra Mix4Up a Aplicaciones. Vale para Mac con Intel y con chip de Apple.

La app no está firmada por Apple (no hay certificado de pago), así que la primera vez macOS no la deja abrir con doble clic:

- **Clic derecho** (o Control + clic) en Mix4Up, en Aplicaciones → **Abrir** → **Abrir**. Ya no lo vuelve a preguntar.
- En macOS 15 (Sequoia) o más nuevo: intenta abrirla una vez, ve a **Ajustes del Sistema → Privacidad y seguridad** y pulsa **Abrir igualmente**.

Por lo mismo, en el Mac no se instala sola: cuando hay una versión nueva te avisa y abre la web para bajarla. yt-dlp y deno los baja ella sola; ffmpeg (para las descargas y los vídeos raros) usa el de Homebrew si lo tienes y, si no, lo baja.

## Cómo está hecho

- `*.go`: el motor (Go, sin dependencias). Sirve la interfaz en `http://127.0.0.1:47823`, lee las carpetas de vídeos, habla con YouTube (InnerTube con tu sesión; para sacar la imagen y el sonido, la app de YouTube de las Vision Pro, como MixUp, y yt-dlp de reserva y para las descargas) y guarda los datos en `%APPDATA%\Mix4Up` (instalada), `.mix4up` junto al exe (portable) o `~/Library/Application Support/Mix4Up` (Mac). Lo de cada sistema está en `os_windows.go`, `os_darwin.go` y `os_other.go`.
- `web/`: la interfaz (JavaScript sin compilar). Cada archivo define un solo nombre global.
- `desktop/`: la app de escritorio (Electron). Windows: instalador, portable y actualizaciones solas desde `mix4up-pc-latest`. Mac: `.dmg` y `.zip` universales (firmados «ad hoc», sin certificado), que miran si hay versión nueva en `mix4up-mac-latest`.
- `android/`: la app de Android (Java + WebView) con su propio servidor local, yt-dlp (youtubedl-android) y actualizaciones solas desde `mix4up-android-latest`.
- `.github/workflows/build.yml`: compila, prueba (Linux, Windows, Mac y emulador Android) y solo entonces publica (solo desde `main`).
- `tools/prueba/`: las pruebas automáticas.
