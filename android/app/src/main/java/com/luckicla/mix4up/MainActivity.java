package com.luckicla.mix4up;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Rational;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;

/**
 * Mix4Up en el móvil: una ventana con la misma interfaz que en el PC (servida
 * por LocalServer en 127.0.0.1), que sigue viva con la pantalla apagada
 * mientras suena (PlaybackService), y se actualiza sola.
 */
public class MainActivity extends Activity {
    private static final int REQ_PERMS = 1, REQ_FILE = 2, REQ_CAMERA = 3;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static WeakReference<MainActivity> current = new WeakReference<>(null);
    private static Context app;
    private static WebView web;
    private static MutableContextWrapper webCtx;
    private static LocalServer server;
    private static VideoLibrary library;
    private static String token = "";
    private static String shared;
    private static boolean keepOn, fullscreen, inPip, playing, testMode, watching;
    private static volatile boolean bgAllowed = true;
    private static boolean inBg;
    static void bgNow(boolean on) { if (inBg == on) return; inBg = on; js("window.M4bg && M4bg(" + on + ")"); }
    private static android.webkit.PermissionRequest camRequest;
    private ValueCallback<Uri[]> fileCallback;

    static String token() { return token; }
    static int serverPort() { return server == null ? LocalServer.PORT : server.port; }
    static String versionName() {
        try { return app.getPackageManager().getPackageInfo(app.getPackageName(), 0).versionName + "." + myVersion(); } catch (Exception e) { return "android"; }
    }
    static String deviceName() {
        String m = Build.MODEL == null ? "Móvil" : Build.MODEL;
        String b = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
        return m.toLowerCase().startsWith(b.toLowerCase()) ? m : (b.isEmpty() ? m : Character.toUpperCase(b.charAt(0)) + b.substring(1) + " " + m);
    }

    /* ---------- el motor y la página ---------- */
    @SuppressLint("SetJavaScriptEnabled")
    private static void makeWeb(Context base) {
        webCtx = new MutableContextWrapper(base);
        web = new WebView(webCtx) {
            // con un vídeo sonando, la página no se entera de que la app se fue al fondo
            // o se apagó la pantalla: así el móvil no lo para (sigue sonando)
            @Override protected void onWindowVisibilityChanged(int v) {
                if (v != View.VISIBLE && playing && bgAllowed) { bgNow(true); super.onWindowVisibilityChanged(View.VISIBLE); return; }
                if (v == View.VISIBLE) bgNow(false);
                super.onWindowVisibilityChanged(v);
            }
        };
        web.setBackgroundColor(Color.parseColor("#0F0F13"));
        web.setOnLongClickListener(v -> true);
        web.setLongClickable(false);
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        if ((base.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        ws.setUserAgentString(ws.getUserAgentString() + " Mix4UpAndroid");
        web.addJavascriptInterface(new Bridge(), "Mix4UpAndroid");
        if (Build.VERSION.SDK_INT >= 26) web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail d) {
                Diag.log("Android cerró la página: se rehace");
                main.post(() -> rebirth(v));
                return true;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if ("127.0.0.1".equals(u.getHost())) return false;
                try { app.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(android.webkit.PermissionRequest req) {
                boolean cam = false;
                for (String r : req.getResources()) cam |= android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r);
                MainActivity a = current.get();
                if (!cam || a == null) { req.deny(); return; }
                if (a.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) req.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                else { camRequest = req; a.requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA); }
            }
            @Override public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                MainActivity a = current.get();
                if (a == null) return false;
                if (a.fileCallback != null) a.fileCallback.onReceiveValue(null);
                a.fileCallback = cb;
                try { a.startActivityForResult(params.createIntent(), REQ_FILE); } catch (Exception e) { a.fileCallback = null; return false; }
                return true;
            }
            @Override public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR) Diag.log("consola: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return false;
            }
        });
    }

    private static void rebirth(WebView dead) {
        if (web != dead || server == null) return;
        if (dead.getParent() instanceof ViewGroup) ((ViewGroup) dead.getParent()).removeView(dead);
        try { dead.destroy(); } catch (Exception ignored) {}
        MainActivity a = current.get();
        makeWeb(a != null ? a : app);
        if (a != null) a.setContentView(web);
        web.loadUrl("http://127.0.0.1:" + server.port + "/");
    }

    static void bootCore(Context base) {
        app = base.getApplicationContext();
        Diag.init(app);
        Diag.log("--- Mix4Up arranca " + versionName());
        byte[] rnd = new byte[16];
        new SecureRandom().nextBytes(rnd);
        StringBuilder t = new StringBuilder();
        for (byte b : rnd) t.append(String.format("%02x", b));
        token = t.toString();
        YtAccount.init(app.getFilesDir());
        library = new VideoLibrary(app);
        YtVideo.setLibrary(library);
        server = new LocalServer(app, library, token);
        YtVideo.warmUp(app);
        makeWeb(base);
        new Thread(() -> {
            YtVideo.cleanCache();
            cleanOldApks();
            try { server.start(); YtVideo.jsEngine(app, server.port, token); }
            catch (Exception e) { Diag.log("servidor: " + e); return; }
            main.post(() -> {
                if (web == null) return;
                String origin = "http://127.0.0.1:" + server.port;
                CookieManager cm = CookieManager.getInstance();
                cm.setAcceptCookie(true);
                cm.setCookie(origin, "m4=" + token + "; Path=/");
                cm.flush();
                web.loadUrl(origin + "/");
            });
        }).start();
        // (en las pruebas automáticas, la actualización se prueba aparte, a mano)
        main.postDelayed(() -> { if (!testMode) checkUpdate(false); }, 20_000);
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = new WeakReference<>(this);
        app = getApplicationContext();
        takeShare(getIntent());
        // (solo la versión de pruebas: las pruebas automáticas ponen su propio servidor de actualizaciones)
        String testUpd = getIntent().getStringExtra("m4update");
        if (testUpd != null && (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) { UPDATE_BASE = testUpd; testMode = true; }
        if (web != null) {
            webCtx.setBaseContext(this);
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            setContentView(web);
        } else {
            bootCore(this);
            setContentView(web);
        }
        askPermissions();
    }

    private void askPermissions() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) { need.add(Manifest.permission.READ_MEDIA_VIDEO); need.add(Manifest.permission.POST_NOTIFICATIONS); }
        else need.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        List<String> missing = new ArrayList<>();
        for (String p : need) if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), REQ_PERMS);
    }

    @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_CAMERA && camRequest != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) camRequest.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE});
            else camRequest.deny();
            camRequest = null;
            return;
        }
        for (int i = 0; i < perms.length; i++) {
            boolean vids = perms[i].equals(Manifest.permission.READ_MEDIA_VIDEO) || perms[i].equals(Manifest.permission.READ_EXTERNAL_STORAGE);
            if (vids && results[i] == PackageManager.PERMISSION_GRANTED) { library.scan(true); js("location.hash.startsWith('#/local') && M4.render()"); }
        }
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_FILE && fileCallback != null) { fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data)); fileCallback = null; }
    }

    @Override protected void onNewIntent(Intent intent) { super.onNewIntent(intent); takeShare(intent); }
    private static void takeShare(Intent i) {
        if (i == null || !Intent.ACTION_SEND.equals(i.getAction())) return;
        String t = i.getStringExtra(Intent.EXTRA_TEXT);
        if (t == null || t.isEmpty()) return;
        shared = t;
        js("window.M4shared && M4shared()");
    }

    // «atrás»: primero lo que esté abierto en la página; si no, Mix4Up al fondo
    // (si hay un vídeo sonando, sigue en una ventanita: imagen dentro de imagen)
    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.M4back ? String(M4back()) : 'false'", v -> {
            if (v != null && v.contains("true")) return;
            if (!(playing && enterPip(16, 9))) moveTaskToBack(true);
        });
    }

    @Override protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        // al salir con el botón de inicio mientras se ve un vídeo: ventanita flotante
        // (si no, sigue sonando en segundo plano con la notificación)
        if (playing && (fullscreen || watching)) enterPip(16, 9);
    }

    boolean enterPip(int w, int h) {
        if (Build.VERSION.SDK_INT < 26) return false;
        try {
            Rational r = new Rational(Math.max(1, w), Math.max(1, h));
            float f = r.floatValue();
            if (f > 2.39f) r = new Rational(239, 100); else if (f < 0.42f) r = new Rational(42, 100);
            return enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(r).build());
        } catch (Exception e) { return false; }
    }

    @Override public void onPictureInPictureModeChanged(boolean pip, Configuration c) {
        super.onPictureInPictureModeChanged(pip, c);
        inPip = pip;
        js("window.M4pip && M4pip(" + pip + ")");
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (current.get() == this) current = new WeakReference<>(null);
        if (web != null) {
            if (web.getParent() instanceof ViewGroup) ((ViewGroup) web.getParent()).removeView(web);
            webCtx.setBaseContext(app);
            if (!PlaybackService.isPlaying()) shutdown();
        }
        super.onDestroy();
    }

    static void shutdown() {
        main.post(() -> {
            if (current.get() != null || web == null) return;
            try { web.destroy(); } catch (Exception ignored) {}
            web = null;
            if (server != null) server.stop();
            server = null;
        });
    }

    static void quit() {
        main.post(() -> {
            js("try{Journal.saveNow()}catch(e){}");
            PlaybackService.stop(app);
            MainActivity a = current.get();
            main.postDelayed(() -> {
                if (a != null) a.finishAndRemoveTask();
                if (web != null) { try { web.destroy(); } catch (Exception ignored) {} web = null; }
                if (server != null) server.stop();
                server = null;
                android.os.Process.killProcess(android.os.Process.myPid());
            }, 500);
        });
    }

    static void remote(String cmd) { js("window.M4remote && M4remote(" + JSONObject.quote(cmd) + ")"); }
    static void loggedIn() { js("window.M4loggedIn && M4loggedIn()"); }
    static void updateState(String json) { js("window.M4update && M4update(" + JSONObject.quote(json) + ")"); }
    private static void js(String code) { main.post(() -> { if (web != null) web.evaluateJavascript(code, null); }); }

    private static void withWindow(java.util.function.Consumer<MainActivity> f) { main.post(() -> { MainActivity a = current.get(); if (a != null) f.accept(a); }); }

    private static void applyFullscreen(MainActivity a, boolean on, boolean landscape) {
        fullscreen = on;
        Window w = a.getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                if (on) { c.hide(WindowInsets.Type.systemBars()); c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE); }
                else c.show(WindowInsets.Type.systemBars());
            }
        } else {
            w.getDecorView().setSystemUiVisibility(on ? View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_LAYOUT_STABLE : 0);
        }
        // en pantalla completa el vídeo ocupa también la zona de la cámara
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = on ? (Build.VERSION.SDK_INT >= 30 ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES)
                                              : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            w.setAttributes(lp);
        }
        if (Build.VERSION.SDK_INT >= 30) w.setDecorFitsSystemWindows(!on);
        a.setRequestedOrientation(on ? (landscape ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT) : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
    }

    /* ---------- actualizarse sola ---------- */
    // GitHub compila el APK con cada cambio y lo publica con un version.txt
    // ("<versionCode> <sha256>"). Nueva → se baja, se comprueba y se instala
    // con PackageInstaller (sin volver a preguntar en Android 12 o superior).
    private static String UPDATE_BASE = "https://github.com/luckicla/mix4up/releases/download/mix4up-android-latest/";
    private static java.io.File updateFile;
    private static volatile boolean updating;
    private static volatile long updateVersion;

    static long myVersion() {
        try {
            android.content.pm.PackageInfo pi = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) { return 0; }
    }
    private static boolean autoUpdate() {
        try {
            java.io.File f = new java.io.File(app.getFilesDir(), "settings.json");
            if (!f.exists()) return true;
            return new JSONObject(new String(Http.readAll(new java.io.FileInputStream(f)), "UTF-8")).optBoolean("autoUpdate", true);
        } catch (Exception e) { return true; }
    }

    static void checkUpdate(boolean manual) {
        new Thread(() -> {
            try {
                if (manual) updateState("{\"state\":\"checking\"}");
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(UPDATE_BASE + "version.txt?t=" + System.currentTimeMillis()).openConnection();
                c.setUseCaches(false); c.setConnectTimeout(10_000); c.setReadTimeout(10_000);
                String line;
                try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(c.getInputStream()))) { line = r.readLine(); }
                String[] p = line.trim().split("\\s+");
                long latest = Long.parseLong(p[0]);
                String sha = p.length > 1 ? p[1].toLowerCase() : "";
                String label = p.length > 2 ? p[2] : String.valueOf(latest);
                if (latest <= myVersion()) { updateState("{\"state\":\"none\"}"); return; }
                if (!manual && !autoUpdate()) { updateState("{\"state\":\"available\",\"version\":\"" + label + "\"}"); return; }
                downloadUpdate(latest, sha, label);
                if (updateFile != null && (manual || autoUpdate())) withWindow(MainActivity::installUpdate);
            } catch (Exception e) {
                if (manual) updateState("{\"state\":\"error\",\"msg\":\"No se pudo mirar si hay versión nueva (¿hay internet?)\"}");
            }
        }).start();
    }

    private static void downloadUpdate(long n, String sha, String label) {
        java.io.File dir = new java.io.File(app.getCacheDir(), "update");
        java.io.File f = new java.io.File(dir, "Mix4Up-" + n + ".apk");
        if (f.isFile() && f.length() > 0 && (sha.isEmpty() || sha.equals(sha256(f)))) { updateFile = f; updateVersion = n; updateState("{\"state\":\"ready\",\"version\":\"" + label + "\"}"); return; }
        synchronized (MainActivity.class) { if (updating) return; updating = true; }
        java.io.File part = new java.io.File(dir, "Mix4Up-" + n + ".part");
        try {
            dir.mkdirs();
            java.io.File[] olds = dir.listFiles();
            if (olds != null) for (java.io.File o : olds) if (!o.equals(part)) o.delete();
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(UPDATE_BASE + "Mix4Up.apk?t=" + n).openConnection();
            c.setInstanceFollowRedirects(true); c.setUseCaches(false); c.setConnectTimeout(15_000); c.setReadTimeout(30_000);
            for (int hop = 0; hop < 5; hop++) {
                int code = c.getResponseCode();
                if (code < 300 || code >= 400) break;
                String loc = c.getHeaderField("Location");
                c.disconnect();
                c = (java.net.HttpURLConnection) new java.net.URL(new java.net.URL(c.getURL(), loc).toString()).openConnection();
                c.setConnectTimeout(15_000); c.setReadTimeout(30_000);
            }
            if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
            long total = c.getContentLengthLong(), got = 0;
            int last = -1;
            try (java.io.InputStream in = c.getInputStream(); java.io.OutputStream out = new java.io.FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                for (int k; (k = in.read(buf)) > 0; ) {
                    out.write(buf, 0, k); got += k;
                    int pct = total > 0 ? (int) (got * 100 / total) : 0;
                    if (pct != last && pct % 2 == 0) { last = pct; updateState("{\"state\":\"downloading\",\"pct\":" + pct + "}"); }
                }
            }
            if (!sha.isEmpty() && !sha.equals(sha256(part))) throw new java.io.IOException("la descarga no coincide");
            if (!part.renameTo(f)) throw new java.io.IOException("rename");
            updateFile = f; updateVersion = n;
            updateState("{\"state\":\"ready\",\"version\":\"" + label + "\"}");
        } catch (Exception e) {
            part.delete();
            updateState("{\"state\":\"error\",\"msg\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}");
        } finally { updating = false; }
    }

    private static String sha256(java.io.File f) {
        try (java.io.InputStream in = new java.io.FileInputStream(f)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            for (int k; (k = in.read(buf)) > 0; ) md.update(buf, 0, k);
            StringBuilder sb = new StringBuilder();
            for (byte x : md.digest()) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) { return ""; }
    }

    private static void cleanOldApks() {
        java.io.File[] fs = new java.io.File(app.getCacheDir(), "update").listFiles();
        if (fs != null) for (java.io.File f : fs) if (f.getName().startsWith("Mix4Up-") && !f.getName().contains(String.valueOf(myVersion() + 1))) f.delete();
    }

    private void installUpdate() {
        java.io.File f = updateFile;
        if (f == null || !f.isFile()) { checkUpdate(true); return; }
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            try {
                startActivity(new Intent(android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                js("M4.toast('Permite a Mix4Up instalar apps y vuelve a pulsar «Actualizar»', {ms: 6000})");
            } catch (Exception ignored) {}
            return;
        }
        updateState("{\"state\":\"installing\"}");
        new Thread(() -> {
            try {
                js("try{Journal.saveNow()}catch(e){}");
                android.content.pm.PackageInstaller pi = app.getPackageManager().getPackageInstaller();
                android.content.pm.PackageInstaller.SessionParams sp = new android.content.pm.PackageInstaller.SessionParams(android.content.pm.PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                sp.setAppPackageName(app.getPackageName());
                if (Build.VERSION.SDK_INT >= 31) sp.setRequireUserAction(android.content.pm.PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED);
                if (Build.VERSION.SDK_INT >= 34) sp.setRequestUpdateOwnership(true);
                int sid = pi.createSession(sp);
                try (android.content.pm.PackageInstaller.Session ss = pi.openSession(sid)) {
                    try (java.io.InputStream in = new java.io.FileInputStream(f); java.io.OutputStream out = ss.openWrite("Mix4Up.apk", 0, f.length())) {
                        byte[] buf = new byte[64 * 1024];
                        for (int k; (k = in.read(buf)) > 0; ) out.write(buf, 0, k);
                        ss.fsync(out);
                    }
                    Intent cb = new Intent(app, InstallReceiver.class);
                    int fl = android.app.PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? android.app.PendingIntent.FLAG_MUTABLE : 0);
                    ss.commit(android.app.PendingIntent.getBroadcast(app, sid, cb, fl).getIntentSender());
                }
            } catch (Exception e) {
                updateState("{\"state\":\"error\",\"msg\":" + JSONObject.quote("No se pudo instalar: " + e.getMessage()) + "}");
            }
        }).start();
    }

    /* ---------- lo que la página puede pedir (window.Mix4UpAndroid) ---------- */
    private static class Bridge {
        @JavascriptInterface public String deviceName() { return MainActivity.deviceName(); }
        @JavascriptInterface public String consumeShared() { String s = shared; shared = null; return s == null ? "" : s; }
        @JavascriptInterface public void checkUpdate(boolean manual) { MainActivity.checkUpdate(manual); }
        @JavascriptInterface public void installUpdate() { if (updateFile != null) withWindow(MainActivity::installUpdate); else MainActivity.checkUpdate(true); }
        @JavascriptInterface public void login() { withWindow(a -> a.startActivity(new Intent(a, LoginActivity.class))); }
        @JavascriptInterface public void logout() {
            main.post(() -> {
                CookieManager cm = CookieManager.getInstance();
                cm.removeAllCookies(v -> { if (server != null) cm.setCookie("http://127.0.0.1:" + server.port, "m4=" + token + "; Path=/"); cm.flush(); });
            });
        }
        @JavascriptInterface public void askVideoPermission() { withWindow(MainActivity::askPermissions); }
        @JavascriptInterface public void setKeepScreenOn(boolean on) {
            if (on) playing = true;
            withWindow(a -> { keepOn = on; if (on) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); });
        }
        @JavascriptInterface public void setWatching(boolean on) { watching = on; }
        @JavascriptInterface public void setFullscreen(boolean on, boolean landscape) { withWindow(a -> applyFullscreen(a, on, landscape)); }
        @JavascriptInterface public void enterPip(int w, int h) { withWindow(a -> a.enterPip(w, h)); }
        @JavascriptInterface public float getVolume() {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            return (float) am.getStreamVolume(AudioManager.STREAM_MUSIC) / am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        }
        @JavascriptInterface public void setVolume(float v) {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(Math.max(0, Math.min(1, v)) * am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)), 0);
        }
        private volatile float bright = -1;
        @JavascriptInterface public float getBrightness() {
            if (bright >= 0) return bright;
            try { return android.provider.Settings.System.getInt(app.getContentResolver(), android.provider.Settings.System.SCREEN_BRIGHTNESS) / 255f; } catch (Exception e) { return 0.5f; }
        }
        @JavascriptInterface public void setBrightness(float v) {
            bright = Math.max(0.01f, Math.min(1, v));
            withWindow(a -> { WindowManager.LayoutParams lp = a.getWindow().getAttributes(); lp.screenBrightness = bright; a.getWindow().setAttributes(lp); });
        }
        @JavascriptInterface public void nowPlaying(String json) {
            try {
                JSONObject j = new JSONObject(json);
                if (!j.has("title")) { PlaybackService.stop(app); return; }
                PlaybackService.State s = new PlaybackService.State();
                s.title = j.optString("title", "Mix4Up"); s.channel = j.optString("channel"); s.thumb = j.optString("thumb");
                bgAllowed = j.optBoolean("bg", true);
                playing = j.optBoolean("playing");
                s.playing = j.optBoolean("playing") && bgAllowed;
                s.posMs = (long) (j.optDouble("pos", 0) * 1000); s.durMs = (long) (j.optDouble("dur", 0) * 1000);
                PlaybackService.loadArt(app, s);
                if (s.playing || PlaybackService.isPlaying()) PlaybackService.update(app, s);
            } catch (Exception ignored) {}
        }
        @JavascriptInterface public void quitApp() { MainActivity.quit(); }
        @JavascriptInterface public void share(String text) {
            try { app.startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Compartir").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
        }
        @JavascriptInterface public void setBars(String hex, boolean light) {
            withWindow(a -> {
                try {
                    int c = Color.parseColor(hex.length() == 4 ? "#" + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2) + hex.charAt(3) + hex.charAt(3) : hex);
                    a.getWindow().setStatusBarColor(c); a.getWindow().setNavigationBarColor(c);
                    if (Build.VERSION.SDK_INT >= 30) {
                        WindowInsetsController ic = a.getWindow().getInsetsController();
                        if (ic != null) ic.setSystemBarsAppearance(light ? WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS : 0,
                                WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
                    } else if (Build.VERSION.SDK_INT >= 26) {
                        a.getWindow().getDecorView().setSystemUiVisibility(light ? View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR : 0);
                    }
                } catch (Exception ignored) {}
            });
        }
        @JavascriptInterface public void diag(String what) { Diag.log("página: " + what); }
        // vibración: las de Android (finas y cortas, como las del teclado del sistema)
        @JavascriptInterface public void haptic(String kind) {
            try {
                android.os.Vibrator v = Build.VERSION.SDK_INT >= 31
                        ? ((android.os.VibratorManager) app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE)).getDefaultVibrator()
                        : (android.os.Vibrator) app.getSystemService(Context.VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= 29) {
                    int e;
                    switch (kind) {
                        case "tick": e = android.os.VibrationEffect.EFFECT_TICK; break;
                        case "long": e = android.os.VibrationEffect.EFFECT_HEAVY_CLICK; break;
                        case "confirm": e = android.os.VibrationEffect.EFFECT_DOUBLE_CLICK; break;
                        default: e = android.os.VibrationEffect.EFFECT_CLICK;
                    }
                    v.vibrate(android.os.VibrationEffect.createPredefined(e));
                } else if (Build.VERSION.SDK_INT >= 26) {
                    long ms = "tick".equals(kind) ? 6 : "long".equals(kind) ? 28 : "confirm".equals(kind) ? 18 : 12;
                    v.vibrate(android.os.VibrationEffect.createOneShot(ms, "tick".equals(kind) ? 60 : 160));
                } else v.vibrate(12);
            } catch (Exception ignored) {}
        }
    }
}
