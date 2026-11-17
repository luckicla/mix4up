# Mix4Up

**Tus vídeos y YouTube, sin Shorts y sin anuncios.** Hermano de [MixUp](https://github.com/luckicla/zentor).

- Tu inicio de YouTube (las mismas recomendaciones), suscripciones, historial, Ver más tarde, Me gusta y listas, conectando tu cuenta (la sesión se guarda solo en tu aparato).
- Ni un Short: ni en inicio, búsquedas, canales, relacionados ni suscripciones.
- Reproductor propio: pantalla completa, gestos, velocidad, subtítulos, imagen dentro de imagen, calidad, A-B, temporizador para dormir, y en segundo plano.
- Rápido: al abrir un vídeo se baja entero en segundo plano con varias conexiones a la vez.
- Tus vídeos locales (MP4, MKV, WebM, MOV, AVI…) con miniaturas y «seguir donde lo dejaste».
- Descargas de YouTube en la calidad que elijas.
- Sincronización móvil ↔ PC por WiFi y «Seguir aquí».
- Windows (instalador y portable) y Android (APK). Se actualizan solas.

Web: https://luckicla.github.io/mix4up/ · Descargas: [Releases](https://github.com/luckicla/mix4up/releases)

## Cómo está hecho

- `*.go`: el motor (Go, sin dependencias). Sirve la interfaz en `http://127.0.0.1:47823`, lee las carpetas de vídeos, habla con YouTube (InnerTube con tu sesión, y yt-dlp para los vídeos y las descargas) y guarda los datos en `%APPDATA%\Mix4Up` (instalada) o `.mix4up` junto al exe (portable).
- `web/`: la interfaz (JavaScript sin compilar). Cada archivo define un solo nombre global.
- `desktop/`: la app de Windows (Electron), con instalador, portable y actualizaciones solas desde `mix4up-pc-latest`.
- `android/`: la app de Android (Java + WebView) con su propio servidor local, yt-dlp (youtubedl-android) y actualizaciones solas desde `mix4up-android-latest`.
- `.github/workflows/build.yml`: compila, prueba (Linux, Windows y emulador Android) y solo entonces publica.
- `tools/prueba/`: las pruebas automáticas.
