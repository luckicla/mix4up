package com.luckicla.mix4up;

import android.content.Context;
import android.content.res.AssetManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * El motor de Mix4Up en el móvil: sirve la misma interfaz que en el PC y la
 * misma API (/api/videos, /video/…, /api/yt/…, /ytstream/…) en 127.0.0.1:47823.
 * Cada petición lleva la cookie que se le dio a la ventana de Mix4Up: otras
 * apps del móvil no pueden usarlo.
 */
final class LocalServer {
    static final int PORT = 47823;

    private final Context ctx;
    private final VideoLibrary lib;
    private final String token;
    private final File dataDir;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private ServerSocket socket;
    int port;

    LocalServer(Context ctx, VideoLibrary lib, String token) {
        this.ctx = ctx.getApplicationContext();
        this.lib = lib;
        this.token = token;
        this.dataDir = ctx.getFilesDir();
    }

    void start() throws IOException {
        InetAddress lo = InetAddress.getByName("127.0.0.1");
        try { socket = new ServerSocket(PORT, 50, lo); }
        catch (IOException e) { socket = new ServerSocket(0, 50, lo); }
        port = socket.getLocalPort();
        Thread t = new Thread(() -> {
            while (!socket.isClosed()) {
                try { Socket s = socket.accept(); pool.execute(() -> handle(s)); } catch (IOException ignored) {}
            }
        }, "mix4up-server");
        t.setDaemon(true);
        t.start();
    }

    void stop() { try { socket.close(); } catch (Exception ignored) {} pool.shutdownNow(); }

    private void handle(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(60000);
            sock.setTcpNoDelay(true);
            InputStream in = new BufferedInputStream(sock.getInputStream());
            OutputStream out = new java.io.BufferedOutputStream(sock.getOutputStream(), 64 * 1024);
            Http.Request r = Http.parse(in);
            if (r == null) return;
            if (!authorized(r)) { Http.text(out, 403, "forbidden"); return; }
            route(r, out);
            out.flush();
        } catch (Exception ignored) {
        }
    }

    private boolean authorized(Http.Request r) {
        String host = r.headers.getOrDefault("host", "");
        if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) return false;
        String origin = r.headers.getOrDefault("origin", "");
        if (!origin.isEmpty() && !origin.startsWith("http://127.0.0.1:") && !origin.startsWith("http://localhost:")) return false;
        return r.headers.getOrDefault("cookie", "").contains("m4=" + token);
    }

    private void route(Http.Request r, OutputStream out) throws Exception {
        String p = r.path;
        if (p.equals("/api/version")) { Http.text(out, 200, MainActivity.versionName()); }
        else if (p.equals("/api/info")) {
            Http.json(out, new JSONObject().put("version", MainActivity.versionName()).put("platform", "android").put("portable", false)
                    .put("data", dataDir.getAbsolutePath()).put("folders", new JSONArray().put("Vídeos del móvil")).put("downloads", lib.downloadDir().getAbsolutePath())
                    .put("name", MainActivity.deviceName()));
        }
        else if (p.equals("/api/ping")) Http.noContent(out);
        else if (p.equals("/api/settings") || p.equals("/api/state")) jsonDoc(r, out, new File(dataDir, p.substring(5) + ".json"));
        else if (p.equals("/api/journal")) journal(r, out);
        else if (p.equals("/api/now")) nowDoc(r, out);
        else if (p.equals("/api/videos")) Http.json(out, lib.scan(!r.param("rescan").isEmpty()));
        else if (p.equals("/api/folders")) Http.json(out, new JSONObject().put("folders", new JSONArray().put("Vídeos del móvil")).put("downloads", lib.downloadDir().getAbsolutePath()));
        else if (p.startsWith("/video/")) lib.serve(r, out, p.substring(7));
        else if (p.startsWith("/thumb/")) lib.thumb(r, out, p.substring(7));
        else if (p.startsWith("/api/subs/")) Http.json(out, new JSONArray());
        else if (p.equals("/api/delete")) {
            if (lib.delete(r.param("id"))) Http.noContent(out);
            else Http.text(out, 403, "Los vídeos de la galería se borran desde la galería del móvil.");
        }
        else if (p.equals("/api/jsrun") && r.method.equals("POST")) {
            byte[] b = r.body(16 * 1024 * 1024);
            try { Http.text(out, 200, JsRun.run(ctx, new String(b, StandardCharsets.UTF_8), 60_000)); }
            catch (IOException e) { Http.text(out, 500, String.valueOf(e.getMessage())); }
        }
        else if (p.startsWith("/api/yt/i/")) YtAccount.innertube(r, out, p.substring(10));
        else if (p.equals("/api/yt/cfg")) Http.json(out, YtAccount.cfg(!r.param("fresh").isEmpty()));
        else if (p.equals("/api/yt/account")) Http.json(out, new JSONObject().put("connected", YtAccount.connected()));
        else if (p.equals("/api/yt/cookies")) {
            if (r.method.equals("DELETE")) YtAccount.clear();
            else if (r.method.equals("POST") || r.method.equals("PUT")) YtAccount.setFromText(r.bodyText(1 << 20));
            Http.json(out, new JSONObject().put("connected", YtAccount.connected()));
        }
        else if (p.equals("/api/yt/video")) YtVideo.video(r, out);
        else if (p.equals("/api/yt/sub")) YtVideo.sub(r, out);
        else if (p.equals("/api/yt/list")) YtVideo.list(r, out);
        else if (p.equals("/api/yt/watched")) YtVideo.watched(r, out);
        else if (p.equals("/api/yt/suggest")) YtAccount.suggest(r, out);
        else if (p.equals("/api/yt/cache")) Http.json(out, YtVideo.progress(r.param("id")));
        else if (p.equals("/api/yt/tools")) { if (r.method.equals("POST")) YtVideo.forceUpdate(); Http.json(out, YtVideo.tools()); }
        else if (p.startsWith("/ytstream/")) {
            String[] parts = p.substring(10).split("/", 2);
            if (parts.length < 2 || !parts[0].matches("[A-Za-z0-9_-]{11}")) { Http.text(out, 400, "bad id"); return; }
            YtVideo.stream(r, out, parts[0], parts[1]);
        }
        else if (p.equals("/api/download")) YtVideo.downloads(r, out);
        else if (p.startsWith("/api/")) Http.text(out, 404, "no en el móvil");
        else asset(p, out);
    }

    private static final Object DOC_LOCK = new Object();
    private void jsonDoc(Http.Request r, OutputStream out, File f) throws IOException {
        if (r.method.equals("GET")) {
            byte[] b;
            synchronized (DOC_LOCK) { b = f.exists() ? Http.readAll(new FileInputStream(f)) : "{}".getBytes(); }
            Http.send(out, 200, "application/json", b);
        } else {
            byte[] b = r.body(8 * 1024 * 1024);
            try { new JSONObject(new String(b, StandardCharsets.UTF_8)); } catch (Exception e) { Http.text(out, 400, "bad json"); return; }
            synchronized (DOC_LOCK) { Http.writeAtomic(f, b); }
            Http.noContent(out);
        }
    }

    // el registro: lo que llega se junta con lo que había (por el id de cada cambio)
    private static final Object J_LOCK = new Object();
    private void journal(Http.Request r, OutputStream out) throws IOException {
        File f = new File(dataDir, "journal.json");
        synchronized (J_LOCK) {
            JSONObject cur;
            try { cur = f.exists() ? new JSONObject(new String(Http.readAll(new FileInputStream(f)), StandardCharsets.UTF_8)) : new JSONObject(); }
            catch (Exception e) { cur = new JSONObject(); }
            try {
                if (!cur.has("events")) cur.put("events", new JSONArray());
                if (r.method.equals("GET")) { Http.json(out, cur); return; }
                JSONObject in = new JSONObject(r.bodyText(32 * 1024 * 1024));
                if (!in.optString("dev").isEmpty()) cur.put("dev", in.optString("dev"));
                if (in.optLong("seq") > cur.optLong("seq")) cur.put("seq", in.optLong("seq"));
                JSONArray ev = cur.getJSONArray("events");
                Set<String> have = new HashSet<>();
                for (int i = 0; i < ev.length(); i++) have.add(ev.getJSONObject(i).optString("i"));
                JSONArray add = in.optJSONArray("events");
                if (add != null) for (int i = 0; i < add.length(); i++) {
                    JSONObject e = add.optJSONObject(i);
                    if (e == null || e.optString("i").isEmpty() || e.optString("y").isEmpty() || !have.add(e.optString("i"))) continue;
                    ev.put(e);
                }
                Http.writeAtomic(f, cur.toString().getBytes(StandardCharsets.UTF_8));
                Http.noContent(out);
            } catch (org.json.JSONException e) { Http.text(out, 400, "bad json"); }
        }
    }

    private static final JSONObject now = new JSONObject();
    private void nowDoc(Http.Request r, OutputStream out) throws IOException {
        synchronized (now) {
            if (!r.method.equals("GET")) {
                try { JSONObject v = new JSONObject(r.bodyText(65536)); now.put(v.optString("dev", "?"), v.opt("now")); } catch (Exception ignored) {}
                Http.noContent(out);
                return;
            }
            Http.json(out, now);
        }
    }

    private void asset(String path, OutputStream out) throws IOException {
        if (path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..")) { Http.text(out, 404, ""); return; }
        AssetManager am = ctx.getAssets();
        try (InputStream in = am.open("web" + path)) { Http.send(out, 200, Http.mimeFor(path), Http.readAll(in)); }
        catch (IOException e) { Http.text(out, 404, "not found"); }
    }
}
