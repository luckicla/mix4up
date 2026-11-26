package com.luckicla.mix4up;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * YouTube en el móvil, como ytdlp.go + ytcache.go en el PC: yt-dlp (con
 * youtubedl-android) dice dónde están la imagen y el sonido de cada calidad, y
 * Mix4Up se baja la calidad que ves ENTERA, en trozos y con varias conexiones a
 * la vez, empezando por donde miras. Así saltar y cambiar de calidad va al momento.
 */
final class YtVideo {
    private static final String TAG = "Mix4UpYt";
    private static Context app;
    private static volatile boolean ready;
    private static final Object initLock = new Object();
    private static volatile File jsConfig;
    private static volatile String ytdlpVersion = "";

    static final class Format { String id, ext, kind, vcodec = "", acodec = "", note = "", lang = "", url, mime; int h, w; double fps, tbr; long size; boolean hdr; Map<String, String> headers = new HashMap<>(); }
    static final class Sub { String lang, name, url; boolean auto; }
    static final class Info { JSONObject pub; List<Format> formats = new ArrayList<>(); List<Sub> subs = new ArrayList<>(); long exp; int client;
        Format format(String id) { for (Format f : formats) if (f.id.equals(id)) return f; return null; } }

    private static final Map<String, Info> cache = new HashMap<>();
    private static final Map<String, Object> locks = new HashMap<>();
    private static final String[] CLIENTS = {"", "tv", "web_safari", "mweb"};
    private static volatile int goodClient = 0;
    private static final Pattern GONE = Pattern.compile("(?i)private video|video unavailable|has been removed|no longer available|copyright|not available in your country|members-only|join this channel|confirm your age|inappropriate");

    /* ---------- preparar yt-dlp ---------- */
    static void jsEngine(Context ctx, int port, String key) {
        try {
            Context c = ctx.getApplicationContext();
            File base = new File(c.getFilesDir(), "ytdlp-plugins");
            File dir = new File(base, "mix4up/yt_dlp_plugins/extractor");
            dir.mkdirs();
            try (InputStream in = c.getAssets().open("mix4up_jsc.py"); java.io.FileOutputStream out = new java.io.FileOutputStream(new File(dir, "mix4up_jsc.py"))) {
                byte[] b = new byte[16384];
                for (int n; (n = in.read(b)) > 0; ) out.write(b, 0, n);
            }
            File conf = new File(c.getFilesDir(), "ytdlp-mix4up.conf");
            String txt = "--plugin-dirs \"" + base.getAbsolutePath() + "\"\n"
                    + "--extractor-args \"youtubejsc-mix4up:port=" + port + ";key=" + key + "\"\n"
                    + "--remote-components ejs:github\n";
            try (java.io.FileOutputStream out = new java.io.FileOutputStream(conf)) { out.write(txt.getBytes(StandardCharsets.UTF_8)); }
            jsConfig = conf;
        } catch (Exception e) {
            Diag.log("yt: no se pudo preparar el motor de JavaScript: " + e.getMessage());
        }
    }
    private static void base(YoutubeDLRequest req) {
        req.addOption("--no-warnings");
        req.addOption("--cache-dir", new File(app.getCacheDir(), "yt-dlp").getAbsolutePath());
        File f = jsConfig;
        if (f != null && ytdlpVersion.compareTo("2025.11.12") >= 0) req.addOption("--config-locations", f.getAbsolutePath());
        String ck = YtAccount.cookieFile();
        if (ck != null) req.addOption("--cookies", ck);
    }

    static void warmUp(Context ctx) {
        app = ctx.getApplicationContext();
        Thread t = new Thread(() -> {
            try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); } catch (Exception ignored) {}
            if (init()) { noteVersion(); update(false); noteVersion(); Diag.log("yt-dlp " + ytdlpVersion); }
            else Diag.log("yt-dlp no arranca en este móvil");
        }, "ytdlp-init");
        t.setDaemon(true);
        t.start();
    }
    private static void noteVersion() { try { String v = YoutubeDL.getInstance().version(app); if (v != null) ytdlpVersion = v.trim(); } catch (Throwable ignored) {} }
    static boolean init() {
        synchronized (initLock) {
            if (ready) return true;
            try { YoutubeDL.getInstance().init(app); ready = true; } catch (Throwable e) { Log.w(TAG, "init", e); }
            try { FFmpeg.getInstance().init(app); } catch (Throwable e) { Log.w(TAG, "ffmpeg", e); }
            return ready;
        }
    }
    static boolean update(boolean soon) {
        SharedPreferences p = app.getSharedPreferences("ytdlp", Context.MODE_PRIVATE);
        long last = p.getLong("checked", 0), now = System.currentTimeMillis();
        if (now - last < (soon ? 30 * 60_000L : 12 * 3600_000L)) return false;
        p.edit().putLong("checked", now).apply();
        try {
            String before = YoutubeDL.getInstance().version(app);
            synchronized (initLock) { YoutubeDL.getInstance().updateYoutubeDL(app, YoutubeDL.UpdateChannel._STABLE); }
            noteVersion();
            if (!ytdlpVersion.equals(before)) { clearCache(); return true; }
        } catch (Throwable e) { Log.w(TAG, "update", e); }
        return false;
    }
    static void clearCache() { synchronized (cache) { cache.clear(); } }

    /* ---------- lo que yt-dlp sabe de un vídeo ---------- */
    static Info info(String id, boolean fresh) throws IOException {
        Object lock;
        synchronized (locks) { lock = locks.get(id); if (lock == null) { lock = new Object(); locks.put(id, lock); } }
        synchronized (lock) {
            Info prev;
            synchronized (cache) {
                Info i = cache.get(id);
                prev = i;
                if (i != null && !fresh && i.exp - System.currentTimeMillis() > 10 * 60_000L) return i;
            }
            Info in = null;
            // primero el camino rápido (como el PC): sin yt-dlp, al momento. También al renovar, salvo que lo que
            // falló fuera justo lo del camino rápido (yt-dlp a veces solo da 360p y eso no puede quedarse)
            if (!(fresh && prev != null && prev.client == -1) && System.currentTimeMillis() > fastOffTil) {
                long t0 = System.currentTimeMillis();
                try { in = fast(id); fastFails = 0; Diag.log("yt " + id + ": rápido en " + (System.currentTimeMillis() - t0) + " ms"); }
                catch (Exception e) {
                    String m = String.valueOf(e.getMessage());
                    Diag.log("yt " + id + ": rápido no (" + (System.currentTimeMillis() - t0) + " ms): " + m);
                    // (un vídeo con edad, privado, de miembros… no apaga el camino rápido para los demás;
                    //  si YouTube lo rechaza en general, se descansa 5 minutos, no media hora)
                    boolean onlyThis = m.contains("UNPLAYABLE") || m.contains("ERROR ") || (m.contains("LOGIN_REQUIRED") && !m.toLowerCase().contains("bot"));
                    if (!onlyThis && ++fastFails >= 3) { fastOffTil = System.currentTimeMillis() + 5 * 60_000L; fastFails = 0; }
                }
            }
            if (in != null) { synchronized (cache) { if (cache.size() > 100) cache.clear(); cache.put(id, in); } return in; }
            try { in = resolve(id); }
            catch (IOException e) {
                if (GONE.matcher(String.valueOf(e.getMessage())).find() || !update(true)) throw e;
                in = resolve(id);
            }
            synchronized (cache) { if (cache.size() > 100) cache.clear(); cache.put(id, in); }
            return in;
        }
    }
    private static Info resolve(String id) throws IOException {
        IOException last = null;
        Info poor = null; // uno que solo da 360p (imagen y sonido juntos): solo si ningún otro da más
        int first = goodClient;
        for (int i = 0; i < CLIENTS.length; i++) {
            int k = (first + i) % CLIENTS.length;
            try {
                Info in = resolveWith(id, CLIENTS[k]); in.client = k;
                boolean adaptive = false;
                for (Format f : in.formats) if ("v".equals(f.kind)) { adaptive = true; break; }
                if (!adaptive) { Diag.log("yt " + id + ": el cliente " + k + " solo da 360p; pruebo otro"); if (poor == null) poor = in; continue; }
                goodClient = k; return in;
            }
            catch (IOException e) { last = e; if (GONE.matcher(String.valueOf(e.getMessage())).find()) throw e; }
        }
        if (poor != null) return poor;
        throw last;
    }
    private static Info resolveWith(String id, String client) throws IOException {
        if (app == null || !init()) throw new IOException("yt-dlp no está disponible todavía, prueba en un momento");
        String out;
        try {
            YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
            base(req);
            req.addOption("--no-playlist");
            req.addOption("-J");
            if (!client.isEmpty()) req.addOption("--extractor-args", "youtube:player_client=" + client);
            out = YoutubeDL.getInstance().execute(req).getOut();
        } catch (Throwable e) {
            Diag.log("yt " + id + " (" + (client.isEmpty() ? "auto" : client) + "): " + shortMsg(e.getMessage()));
            throw new IOException(friendly(String.valueOf(e.getMessage())));
        }
        try { return parse(new JSONObject(out.trim())); }
        catch (org.json.JSONException e) { throw new IOException("yt-dlp no dio los datos del vídeo"); }
    }
    static String shortMsg(String m) { if (m == null) return ""; int i = m.lastIndexOf("ERROR:"); m = i >= 0 ? m.substring(i) : m; return m.length() > 300 ? m.substring(0, 300) : m; }
    static String friendly(String m) {
        String l = m.toLowerCase();
        if (l.contains("private video")) return "Es un vídeo privado.";
        if (l.contains("unavailable") || l.contains("removed")) return "Este vídeo ya no está disponible.";
        if (l.contains("confirm your age") || l.contains("inappropriate")) return "Este vídeo tiene restricción de edad: conecta tu cuenta de YouTube para verlo.";
        if (l.contains("members-only")) return "Este vídeo es solo para miembros del canal.";
        if (l.contains("not a bot") || l.contains("sign in to confirm")) return "YouTube pide comprobar que no eres un robot. Conecta tu cuenta de YouTube (Ajustes) y vuelve a intentarlo.";
        return "yt-dlp: " + shortMsg(m);
    }

    private static Info parse(JSONObject j) throws org.json.JSONException {
        Info in = new Info();
        in.exp = System.currentTimeMillis() + 5 * 3600_000L;
        JSONObject p = new JSONObject();
        p.put("id", j.optString("id")); p.put("title", j.optString("title"));
        p.put("channel", j.optString("channel", j.optString("uploader"))); p.put("channelId", j.optString("channel_id"));
        p.put("duration", j.optDouble("duration", 0)); p.put("description", j.optString("description"));
        p.put("upload", j.optString("upload_date")); p.put("views", j.optLong("view_count")); p.put("likes", j.optLong("like_count"));
        p.put("thumb", j.optString("thumbnail")); p.put("live", "is_live".equals(j.optString("live_status")));
        p.put("width", j.optInt("width")); p.put("height", j.optInt("height"));
        JSONArray ch = new JSONArray();
        JSONArray chs = j.optJSONArray("chapters");
        if (chs != null) for (int i = 0; i < chs.length(); i++) { JSONObject c = chs.getJSONObject(i); ch.put(new JSONObject().put("start", c.optDouble("start_time")).put("end", c.optDouble("end_time")).put("title", c.optString("title"))); }
        p.put("chapters", ch);
        JSONArray fmts = new JSONArray();
        JSONArray fs = j.optJSONArray("formats");
        if (fs != null) for (int i = 0; i < fs.length(); i++) {
            JSONObject f = fs.getJSONObject(i);
            String proto = f.optString("protocol"), url = f.optString("url");
            if (url.isEmpty() || (!proto.equals("https") && !proto.equals("http")) || f.optString("format_note").contains("storyboard") || "mhtml".equals(f.optString("ext"))) continue;
            String vc = f.optString("vcodec", "none"), ac = f.optString("acodec", "none");
            boolean hv = !vc.isEmpty() && !vc.equals("none") && !vc.equals("null"), ha = !ac.isEmpty() && !ac.equals("none") && !ac.equals("null");
            if (!hv && !ha) continue;
            Format x = new Format();
            x.id = f.optString("format_id"); x.ext = f.optString("ext"); x.kind = !ha ? "v" : !hv ? "a" : "av";
            x.h = f.optInt("height"); x.w = f.optInt("width"); x.fps = f.optDouble("fps", 0); x.tbr = f.optDouble("tbr", 0);
            x.vcodec = hv ? vc : ""; x.acodec = ha ? ac : ""; x.size = f.optLong("filesize", f.optLong("filesize_approx", 0));
            x.note = f.optString("format_note"); x.lang = f.isNull("language") ? "" : f.optString("language"); x.url = url;
            x.hdr = !f.optString("dynamic_range", "SDR").equals("SDR") && !f.isNull("dynamic_range");
            x.mime = x.kind.equals("a") && x.ext.equals("m4a") ? "audio/mp4" : x.kind.equals("a") && x.ext.equals("webm") ? "audio/webm" : x.ext.equals("webm") ? "video/webm" : "video/mp4";
            JSONObject hh = f.optJSONObject("http_headers");
            if (hh != null) for (Iterator<String> it = hh.keys(); it.hasNext(); ) { String k = it.next(); x.headers.put(k, hh.optString(k)); }
            try { String e = android.net.Uri.parse(url).getQueryParameter("expire"); if (e != null) in.exp = Math.min(in.exp, Long.parseLong(e) * 1000); } catch (Exception ignored) {}
            in.formats.add(x);
            JSONObject o = new JSONObject().put("id", x.id).put("ext", x.ext).put("kind", x.kind).put("vcodec", x.vcodec).put("acodec", x.acodec).put("tbr", x.tbr).put("size", x.size).put("note", x.note).put("lang", x.lang).put("hdr", x.hdr);
            if (x.h > 0) o.put("h", x.h).put("w", x.w);
            if (x.fps > 0) o.put("fps", x.fps);
            fmts.put(o);
        }
        p.put("formats", fmts);
        JSONArray subs = new JSONArray();
        for (String key : new String[]{"subtitles", "automatic_captions"}) {
            JSONObject m = j.optJSONObject(key);
            if (m == null) continue;
            boolean auto = key.equals("automatic_captions");
            for (Iterator<String> it = m.keys(); it.hasNext(); ) {
                String lang = it.next();
                if (lang.equals("live_chat")) continue;
                if (auto && !lang.endsWith("-orig") && !lang.equals("es") && !lang.equals("en") && !lang.equals("ca")) continue;
                JSONArray list = m.getJSONArray(lang);
                for (int i = 0; i < list.length(); i++) {
                    JSONObject s = list.getJSONObject(i);
                    if (!"vtt".equals(s.optString("ext"))) continue;
                    Sub sb = new Sub(); sb.lang = lang; sb.name = s.optString("name"); sb.auto = auto; sb.url = s.optString("url");
                    in.subs.add(sb);
                    subs.put(new JSONObject().put("lang", lang).put("name", sb.name).put("auto", auto));
                    break;
                }
            }
        }
        p.put("subs", subs);
        in.pub = p;
        if (in.formats.isEmpty()) throw new org.json.JSONException(p.optBoolean("live") ? "directo" : "sin formatos");
        return in;
    }

    /* ---------- el camino rápido: la app de YouTube para las Apple Vision Pro (como MixUp)
       da las direcciones de todas las calidades tal cual, sin acertijos de JavaScript ni
       anuncios, y sin cuenta (si no las da, yt-dlp). Antes era la de las Oculus (ANDROID_VR),
       pero YouTube la rechaza desde agosto de 2026. ---------- */
    private static final String VIS_NAME = "VISIONOS", VIS_VER = "1.02", VIS_NUM = "101";
    private static final String VIS_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
    private static volatile long fastOffTil = 0;
    private static volatile int fastFails = 0;
    private static volatile String visVisitor = "";
    private static volatile long visVisitorAt = 0;
    private static final Pattern CODECS = Pattern.compile("codecs=\"([^\"]+)\"");

    private static JSONObject visCall(String endpoint, JSONObject extra, String visitor) throws Exception {
        JSONObject client = new JSONObject().put("clientName", VIS_NAME).put("clientVersion", VIS_VER).put("deviceMake", "Apple").put("deviceModel", "RealityDevice17,1")
                .put("osName", "visionOS").put("osVersion", "26.5.23O471").put("userAgent", VIS_UA).put("hl", "es").put("gl", "ES").put("timeZone", "UTC").put("utcOffsetMinutes", 0);
        if (!visitor.isEmpty()) client.put("visitorData", visitor);
        JSONObject body = extra == null ? new JSONObject() : extra;
        body.put("context", new JSONObject().put("client", client));
        HttpURLConnection h = (HttpURLConnection) new URL("https://www.youtube.com/youtubei/v1/" + endpoint + "?prettyPrint=false").openConnection();
        h.setConnectTimeout(6000); h.setReadTimeout(8000); h.setRequestMethod("POST"); h.setDoOutput(true);
        h.setRequestProperty("Content-Type", "application/json"); h.setRequestProperty("User-Agent", VIS_UA);
        h.setRequestProperty("X-YouTube-Client-Name", VIS_NUM); h.setRequestProperty("X-YouTube-Client-Version", VIS_VER); h.setRequestProperty("Origin", "https://www.youtube.com");
        if (!visitor.isEmpty()) h.setRequestProperty("X-Goog-Visitor-Id", visitor);
        try (OutputStream o = h.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        if (h.getResponseCode() != 200) throw new IOException("YouTube contestó " + h.getResponseCode());
        return new JSONObject(new String(Http.readAll(h.getInputStream()), StandardCharsets.UTF_8));
    }
    // el «visitante» que YouTube da a la app (solo en memoria, 6 horas), o uno nuevo; "" si no da
    private static String visitorId() {
        if (!visVisitor.isEmpty() && System.currentTimeMillis() - visVisitorAt < 6 * 3600_000L) return visVisitor;
        try { keepVisitor(visCall("visitor_id", null, "").optJSONObject("responseContext").optString("visitorData")); } catch (Exception ignored) {}
        return visVisitor;
    }
    private static void keepVisitor(String v) { if (v != null && !v.isEmpty() && !v.equals(visVisitor)) { visVisitor = v; visVisitorAt = System.currentTimeMillis(); } }
    private static boolean botCheck(JSONObject ps) { return ps != null && "LOGIN_REQUIRED".equals(ps.optString("status")) && ps.optString("reason").toLowerCase().contains("not a bot"); }
    private static String visitorOf(JSONObject j) { JSONObject rc = j.optJSONObject("responseContext"); return rc == null ? "" : rc.optString("visitorData"); }

    private static Info fast(String id) throws Exception {
        String visitor = visitorId();
        JSONObject req = new JSONObject().put("videoId", id).put("contentCheckOk", true).put("racyCheckOk", true)
                .put("playbackContext", new JSONObject().put("contentPlaybackContext", new JSONObject().put("html5Preference", "HTML5_PREF_WANTS")));
        JSONObject j = visCall("player", new JSONObject(req.toString()), visitor);
        JSONObject ps = j.optJSONObject("playabilityStatus");
        if (botCheck(ps)) {
            // sin un visitante de confianza pregunta si es un robot; su respuesta trae uno nuevo, que pasa
            String fresh = visitorOf(j);
            visVisitor = "";
            if (fresh.isEmpty() || fresh.equals(visitor)) fresh = visitorId();
            visitor = fresh;
            j = visCall("player", new JSONObject(req.toString()), fresh);
            ps = j.optJSONObject("playabilityStatus");
        }
        if (!botCheck(ps)) { String v = visitorOf(j); keepVisitor(v.isEmpty() ? visitor : v); }
        if (ps == null || !"OK".equals(ps.optString("status"))) throw new IOException(ps == null ? "sin respuesta" : ps.optString("status") + " " + ps.optString("reason"));
        JSONObject sd = j.getJSONObject("streamingData"), d = j.optJSONObject("videoDetails");
        if (d == null) d = new JSONObject();
        if (d.optBoolean("isLive")) throw new IOException("ERROR directo");
        Info in = new Info();
        in.client = -1;
        in.exp = System.currentTimeMillis() + Math.max(600, sd.optLong("expiresInSeconds", 18000)) * 1000;
        double length = d.optDouble("lengthSeconds", 0);
        JSONObject p = new JSONObject();
        p.put("id", id).put("title", d.optString("title")).put("channel", d.optString("author")).put("channelId", d.optString("channelId"))
                .put("duration", length).put("description", d.optString("shortDescription")).put("upload", "")
                .put("views", d.optLong("viewCount", 0)).put("likes", 0).put("live", false).put("width", 0).put("height", 0).put("chapters", new JSONArray());
        JSONArray th = d.optJSONObject("thumbnail") == null ? null : d.getJSONObject("thumbnail").optJSONArray("thumbnails");
        p.put("thumb", th != null && th.length() > 0 ? th.getJSONObject(th.length() - 1).optString("url") : "");
        JSONArray fmts = new JSONArray();
        boolean hv = false, ha = false;
        for (String key : new String[]{"formats", "adaptiveFormats"}) {
            JSONArray fs = sd.optJSONArray(key);
            if (fs == null) continue;
            for (int i = 0; i < fs.length(); i++) {
                JSONObject f = fs.getJSONObject(i);
                String url = f.optString("url");
                // tal cual (sin firma ni acertijo), sin cifrar, no el «volumen estable», no cortado
                if (url.isEmpty() || android.net.Uri.parse(url).getQueryParameter("n") != null) continue;
                if (f.optBoolean("isDrc") || f.has("drmFamilies") || "FORMAT_STREAM_TYPE_OTF".equals(f.optString("type")) || f.has("targetDurationSec")) continue;
                double fd = f.optDouble("approxDurationMs", 0) / 1000;
                if (length > 0 && fd > 0 && fd < length / 2) continue;
                String mt = f.optString("mimeType"), mime = mt.contains(";") ? mt.substring(0, mt.indexOf(';')) : mt;
                java.util.regex.Matcher m = CODECS.matcher(mt);
                String[] codecs = (m.find() ? m.group(1) : "").split(",");
                Format x = new Format();
                long br = f.optLong("averageBitrate", 0); if (br == 0) br = f.optLong("bitrate", 0);
                x.id = String.valueOf(f.optInt("itag")); x.url = url; x.h = f.optInt("height"); x.w = f.optInt("width"); x.fps = f.optInt("fps");
                x.tbr = br / 1000.0; x.size = f.optLong("contentLength", 0); x.headers.put("User-Agent", VIS_UA);
                if (mime.startsWith("audio/")) {
                    if (f.optInt("audioChannels", 2) > 2) continue; // 5.1
                    x.kind = "a"; x.acodec = codecs[0].trim(); x.ext = mime.equals("audio/mp4") ? "m4a" : "webm"; x.mime = mime;
                    JSONObject at = f.optJSONObject("audioTrack");
                    if (at != null) {
                        x.note = at.optString("displayName") + (at.optBoolean("audioIsDefault") ? " (original)" : "");
                        String aid = at.optString("id"); if (aid.contains(".")) x.lang = aid.substring(0, aid.indexOf('.'));
                    }
                    ha = true;
                } else if (codecs.length > 1) { x.kind = "av"; x.vcodec = codecs[0].trim(); x.acodec = codecs[1].trim(); x.ext = "mp4"; x.mime = "video/mp4"; hv = true; ha = true; }
                else {
                    x.kind = "v"; x.vcodec = codecs[0].trim(); x.ext = mime.equals("video/mp4") ? "mp4" : "webm"; x.mime = mime; hv = true;
                    JSONObject ci = f.optJSONObject("colorInfo"); String tr = ci == null ? "" : ci.optString("transferCharacteristics");
                    x.hdr = f.optString("qualityLabel").contains("HDR") || tr.contains("SMPTEST2084") || tr.contains("ARIB_STD_B67");
                }
                in.formats.add(x);
                JSONObject o = new JSONObject().put("id", x.id).put("ext", x.ext).put("kind", x.kind).put("vcodec", x.vcodec).put("acodec", x.acodec).put("tbr", x.tbr).put("size", x.size).put("note", x.note).put("lang", x.lang).put("hdr", x.hdr);
                if (x.h > 0) o.put("h", x.h).put("w", x.w);
                if (x.fps > 0) o.put("fps", x.fps);
                fmts.put(o);
            }
        }
        if (!hv || !ha) throw new IOException("sin direcciones");
        p.put("formats", fmts);
        JSONArray subs = new JSONArray();
        JSONObject cap = j.optJSONObject("captions");
        JSONArray tracks = cap == null || cap.optJSONObject("playerCaptionsTracklistRenderer") == null ? null : cap.getJSONObject("playerCaptionsTracklistRenderer").optJSONArray("captionTracks");
        if (tracks != null) for (int i = 0; i < tracks.length(); i++) {
            JSONObject t = tracks.getJSONObject(i);
            Sub sb = new Sub(); sb.lang = t.optString("languageCode"); sb.auto = "asr".equals(t.optString("kind")); sb.url = t.optString("baseUrl") + "&fmt=vtt";
            JSONObject nm = t.optJSONObject("name");
            sb.name = nm == null ? sb.lang : nm.optString("simpleText", nm.optJSONArray("runs") != null ? nm.getJSONArray("runs").getJSONObject(0).optString("text") : sb.lang);
            in.subs.add(sb);
            subs.put(new JSONObject().put("lang", sb.lang).put("name", sb.name).put("auto", sb.auto));
        }
        p.put("subs", subs);
        in.pub = p;
        // ¿de verdad lo da? (un trozo pequeño del sonido). Hace falta: si YouTube da direcciones que luego
        // rechaza, mejor saberlo ya y pasar a yt-dlp aquí que con el vídeo a medias (se quedaba cargando sin fin)
        for (Format f : in.formats) if (f.kind.equals("a")) { warm(f, true); break; }
        return in;
    }

    static void dropClient(Info in) { if (in != null && in.client == goodClient) goodClient = (goodClient + 1) % CLIENTS.length; }

    private static long total(String cr) {
        if (cr == null) return 0;
        int i = cr.lastIndexOf('/');
        try { return i >= 0 ? Long.parseLong(cr.substring(i + 1).trim()) : 0; } catch (NumberFormatException e) { return 0; }
    }
    static final class Refused extends IOException { Refused(String m) { super(m); } }
    static HttpURLConnection fetch(Format f, long from, long to) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(f.url).openConnection();
        c.setConnectTimeout(15000); c.setReadTimeout(20000);
        for (Map.Entry<String, String> h : f.headers.entrySet()) c.setRequestProperty(h.getKey(), h.getValue());
        c.setRequestProperty("Accept-Encoding", "identity");
        c.setRequestProperty("Range", "bytes=" + from + "-" + to);
        int code = c.getResponseCode();
        if (code != 206 && code != 200) { c.disconnect(); throw new Refused("youtube: " + code); }
        return c;
    }

    /* ---------- la caché: el vídeo entero, en trozos, con varias conexiones ---------- */
    private static final long CHUNK = 2L << 20;
    private static final int WORKERS = 3;
    private static final long CACHE_MAX = 1500L << 20;
    private static final Map<String, CacheFile> files = new HashMap<>();
    private static final ExecutorService POOL = Executors.newCachedThreadPool();

    static final class CacheFile {
        String key, id, fid, mime; File path; long size; RandomAccessFile raf; boolean[] have, busy; long[] got; long tailAt; boolean tailOK; int left, prio, workers; long used; String err; Format fmt;
        synchronized void touch() { used = System.currentTimeMillis(); }
    }

    private static File cacheDir() { File d = new File(app.getCacheDir(), "video"); d.mkdirs(); return d; }
    static void cleanCache() { if (app == null) return; File[] fs = cacheDir().listFiles(); if (fs != null) for (File f : fs) f.delete(); }

    static CacheFile cacheFor(String id, String fid) throws IOException {
        String key = id + "/" + fid;
        synchronized (files) {
            CacheFile c = files.get(key);
            if (c != null && (c.err == null || c.left == 0)) { c.touch(); start(c); return c; }
            if (c != null) files.remove(key);
        }
        Info in = info(id, false);
        Format f = in.format(fid);
        if (f == null) throw new IOException("esa calidad ya no está");
        long size = f.size;
        // (del camino rápido, el tamaño es el exacto de YouTube y ya está comprobado: un viaje menos;
        //  el de yt-dlp a veces es aproximado y con él el vídeo no acababa de cargar)
        if (size <= 0 || in.client != -1) try { HttpURLConnection h = fetch(f, 0, 0); long n = total(h.getHeaderField("Content-Range")); h.disconnect(); if (n > 0) size = n; }
        catch (IOException e) {
            dropClient(in);
            in = info(id, true);
            f = in.format(fid);
            if (f == null) throw new IOException("esa calidad ya no está");
            HttpURLConnection h = fetch(f, 0, 0); long n = total(h.getHeaderField("Content-Range")); h.disconnect(); if (n > 0) size = n;
        }
        if (size <= 0) throw new IOException("tamaño desconocido");
        prune(size);
        CacheFile c = new CacheFile();
        c.key = key; c.id = id; c.fid = fid; c.size = size; c.mime = f.mime; c.fmt = f;
        c.path = new File(cacheDir(), id + "." + fid.replace('/', '_') + "." + f.ext);
        c.raf = new RandomAccessFile(c.path, "rw");
        c.raf.setLength(0);
        int n = (int) ((size + CHUNK - 1) / CHUNK);
        c.have = new boolean[n]; c.busy = new boolean[n]; c.got = new long[n]; c.left = n; c.used = System.currentTimeMillis();
        synchronized (files) {
            CacheFile old = files.get(key);
            if (old != null) { try { c.raf.close(); } catch (IOException ignored) {} c.path.delete(); old.touch(); return old; }
            files.put(key, c);
        }
        // el final del archivo, aparte y enseguida: Chrome lo mira antes de reproducir nada (y antes se bajaba el último)
        c.tailAt = Math.max(0, size - TAIL);
        POOL.execute(() -> fetchTail(c));
        start(c);
        return c;
    }

    private static void prune(long need) {
        List<CacheFile> list;
        synchronized (files) { list = new ArrayList<>(files.values()); }
        long total = 0;
        for (CacheFile c : list) total += c.size;
        list.sort((a, b) -> Long.compare(a.used, b.used));
        for (CacheFile c : list) {
            if (total + need <= CACHE_MAX) break;
            if (System.currentTimeMillis() - c.used < 30_000) continue;
            synchronized (files) { files.remove(c.key); }
            synchronized (c) { c.err = "quitado"; c.notifyAll(); }
            try { c.raf.close(); } catch (IOException ignored) {}
            c.path.delete();
            total -= c.size;
        }
    }

    private static void start(CacheFile c) {
        synchronized (c) {
            while (c.workers < WORKERS && c.left > 0 && c.err == null) { c.workers++; POOL.execute(() -> work(c)); }
        }
    }

    private static void work(CacheFile c) {
        byte[] buf = new byte[64 * 1024];
        try {
            while (true) {
                int i = -1;
                Format f;
                synchronized (c) {
                    if (c.left == 0 || c.err != null || System.currentTimeMillis() - c.used > 120_000) return;
                    int n = c.have.length;
                    for (int k = 0; k < n; k++) { int x = (c.prio + k) % n; if (!c.have[x] && !c.busy[x]) { i = x; break; } }
                    if (i < 0) return;
                    c.busy[i] = true;
                    f = c.fmt;
                }
                boolean ok = fetchChunk(c, f, i, buf);
                synchronized (c) {
                    c.busy[i] = false;
                    if (ok && !c.have[i]) { c.have[i] = true; c.left--; }
                    c.notifyAll();
                }
                if (!ok) Diag.log("yt " + c.key + ": trozo " + i + " falló, se renueva la dirección");
                if (!ok && !refresh(c)) { Diag.log("yt " + c.key + ": no se pudo renovar"); synchronized (c) { c.err = "YouTube no dio el vídeo"; c.notifyAll(); } return; }
            }
        } finally {
            synchronized (c) { c.workers--; }
        }
    }

    private static final long TAIL = 256L << 10;
    private static void fetchTail(CacheFile c) {
        for (int t = 0; t < 2; t++) {
            Format f; long from;
            synchronized (c) { f = c.fmt; from = c.tailAt; }
            try {
                HttpURLConnection h = fetch(f, from, c.size - 1);
                byte[] b = Http.readAll(h.getInputStream());
                if (b.length < c.size - from) continue;
                synchronized (c.raf) { c.raf.seek(from); c.raf.write(b, 0, (int) (c.size - from)); }
                synchronized (c) { c.tailOK = true; c.notifyAll(); }
                return;
            } catch (IOException e) {
                try { Thread.sleep(300); } catch (InterruptedException ignored) {}
            }
        }
    }

    private static boolean fetchChunk(CacheFile c, Format f, int i, byte[] buf) {
        long from = i * CHUNK, to = Math.min(c.size, from + CHUNK) - 1;
        for (int t = 0; t < 3; t++) {
            if (t > 0) try { Thread.sleep(400L * t); } catch (InterruptedException ignored) {}
            HttpURLConnection h = null;
            boolean reuse = false;
            try {
                h = fetch(f, from, to);
                InputStream in = h.getInputStream();
                long pos = from, base = (long) i * CHUNK;
                for (int n; pos <= to && (n = in.read(buf)) > 0; ) {
                    int m = (int) Math.min(n, to + 1 - pos);
                    synchronized (c.raf) { c.raf.seek(pos); c.raf.write(buf, 0, m); }
                    pos += m;
                    // lo que va llegando ya se puede mandar al vídeo (no hace falta esperar al trozo entero)
                    synchronized (c) { if (pos - base > c.got[i]) { c.got[i] = pos - base; c.notifyAll(); } }
                }
                if (pos > to) { in.close(); reuse = true; return true; }
                from = pos;
            } catch (Refused e) {
                Diag.log("yt " + c.key + " trozo " + i + ": " + e.getMessage());
                return false;
            } catch (IOException e) {
                Log.w(TAG, "trozo " + i + ": " + e.getMessage());
            } finally { if (h != null && !reuse) h.disconnect(); }
        }
        return false;
    }

    private static final Object refreshLock = new Object();
    private static boolean refresh(CacheFile c) {
        synchronized (refreshLock) {
            try {
                Format cur;
                synchronized (c) { cur = c.fmt; }
                Info in = info(c.id, false);
                Format f = in.format(c.fid);
                if (f != null && f != cur) { synchronized (c) { c.fmt = f; } return true; }
                dropClient(in);
                in = info(c.id, true);
                f = in.format(c.fid);
                if (f == null) return false;
                synchronized (c) { c.fmt = f; }
                return true;
            } catch (IOException e) { return false; }
        }
    }

    /** hasta dónde (sin incluir) se puede leer ya, empezando en pos; -1 si no llega */
    private static long waitBytes(CacheFile c, long pos) {
        int i = (int) (pos / CHUNK);
        long base = (long) i * CHUNK, ce = Math.min(c.size, base + CHUNK);
        long deadline = System.currentTimeMillis() + 60_000;
        synchronized (c) {
            while (!c.have[i] && base + c.got[i] <= pos && !(c.tailOK && pos >= c.tailAt)) {
                // lo que alguien está esperando ya, lo primero (Chrome pide también el final del archivo y lo deja:
                // eso no puede quitarle el turno al principio, que es lo que hace falta para empezar)
                c.prio = i;
                if (c.err != null || System.currentTimeMillis() > deadline) return -1;
                if (c.workers == 0) start(c);
                try { c.wait(1000); } catch (InterruptedException e) { return -1; }
            }
            if (c.tailOK && pos >= c.tailAt) return c.size;
            return c.have[i] ? ce : base + c.got[i];
        }
    }
    /** /ytstream/<id>/<formato> */
    static void stream(Http.Request r, OutputStream out, String id, String fid) throws IOException {
        CacheFile c;
        try { c = cacheFor(id, fid); } catch (IOException e) { Diag.log("yt " + id + "/" + fid + ": " + e.getMessage()); Http.text(out, 502, String.valueOf(e.getMessage())); return; }
        long start = 0, end = c.size - 1;
        boolean partial = false;
        String range = r.headers.get("range");
        if (range != null && range.startsWith("bytes=")) {
            String[] p = range.substring(6).split("-", 2);
            try {
                if (!p[0].isEmpty()) start = Long.parseLong(p[0]);
                if (p.length > 1 && !p[1].isEmpty()) end = Math.min(Long.parseLong(p[1]), c.size - 1);
                partial = true;
            } catch (NumberFormatException ignored) {}
        }
        if (start > end || start >= c.size) {
            out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + c.size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes());
            return;
        }
        synchronized (c) { c.prio = (int) (start / CHUNK); c.used = System.currentTimeMillis(); }
        start(c);
        // en cuanto llegan los primeros bytes (antes: el trozo entero de 2 MB)
        long t0 = System.currentTimeMillis();
        if (waitBytes(c, start) < 0) { Diag.log("yt " + c.key + ": sin datos en " + (System.currentTimeMillis() - t0) + " ms (" + c.err + ")"); Http.text(out, 502, "YouTube no dio el vídeo"); return; }
        if (start == 0) Diag.log("yt " + c.key + ": primeros datos en " + (System.currentTimeMillis() - t0) + " ms");
        long len = end - start + 1;
        String h = (partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n") + "Content-Type: " + c.mime + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + len + "\r\n"
                + (partial ? "Content-Range: bytes " + start + "-" + end + "/" + c.size + "\r\n" : "") + "Cache-Control: no-store\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.flush();
        if (r.method.equals("HEAD")) return;
        byte[] buf = new byte[128 * 1024];
        long pos = start;
        try (RandomAccessFile rd = new RandomAccessFile(c.path, "r")) {
            while (pos <= end) {
                long avail = waitBytes(c, pos);
                if (avail < 0) return;
                long ce = Math.min(end, avail - 1);
                while (pos <= ce) {
                    int n = (int) Math.min(buf.length, ce - pos + 1);
                    rd.seek(pos);
                    int m = rd.read(buf, 0, n);
                    if (m <= 0) return;
                    out.write(buf, 0, m);
                    pos += m;
                }
                out.flush();
                c.touch();
            }
        }
        out.flush();
    }

    /** cuánto hay bajado de cada calidad. keep: las que usa el reproductor (mientras el vídeo esté abierto,
     *  aunque esté en pausa, se siguen bajando enteras, como hace YouTube) */
    static JSONObject progress(String id, String keep) {
        JSONObject o = new JSONObject();
        java.util.Set<String> ks = new java.util.HashSet<>(java.util.Arrays.asList(keep.split(",")));
        java.util.List<CacheFile> wake = new java.util.ArrayList<>();
        synchronized (files) {
            for (CacheFile c : files.values()) {
                if (!c.id.equals(id)) continue;
                synchronized (c) {
                    try { o.put(c.fid, 1 - (double) c.left / c.have.length); } catch (Exception ignored) {}
                    if (ks.contains(c.fid) && c.err == null) { c.used = System.currentTimeMillis(); if (c.workers == 0 && c.left > 0) wake.add(c); }
                }
            }
        }
        for (CacheFile c : wake) start(c);
        return o;
    }

    /* ---------- lo demás que pide la página ---------- */
    static void video(Http.Request r, OutputStream out) throws IOException {
        String id = r.param("id");
        if (!id.matches("[A-Za-z0-9_-]{11}")) { Http.text(out, 400, "bad id"); return; }
        if (!r.param("prep").isEmpty()) {
            Http.noContent(out);
            PREP.execute(() -> {
                try {
                    Info in = info(id, false);
                    // y la conexión con el servidor del vídeo, ya abierta (al tocar, empieza sin esperar el saludo de cifrado)
                    for (Format f : in.formats) if ("a".equals(f.kind)) { warm(f); break; }
                } catch (IOException ignored) {}
            });
            return;
        }
        try { Http.json(out, info(id, !r.param("fresh").isEmpty()).pub); }
        catch (IOException e) { Http.text(out, 502, String.valueOf(e.getMessage())); }
    }
    private static final ExecutorService PREP = Executors.newFixedThreadPool(2);
    private static void warm(Format f) { try { warm(f, false); } catch (IOException ignored) {} }
    private static void warm(Format f, boolean strict) throws IOException {
        try { HttpURLConnection c = fetch(f, 0, 1023); Http.readAll(c.getInputStream()); }
        catch (IOException e) { if (strict) throw new IOException("comprobación: " + e.getMessage()); }
    }

    static void sub(Http.Request r, OutputStream out) throws IOException {
        try {
            Info in = info(r.param("id"), false);
            boolean auto = "1".equals(r.param("auto"));
            for (Sub s : in.subs) if (s.lang.equals(r.param("lang")) && s.auto == auto) {
                HttpURLConnection h = (HttpURLConnection) new URL(s.url).openConnection();
                h.setConnectTimeout(10000); h.setReadTimeout(15000);
                Http.send(out, 200, "text/vtt; charset=utf-8", Http.readAll(h.getInputStream()));
                return;
            }
            Http.text(out, 404, "");
        } catch (IOException e) { Http.text(out, 502, String.valueOf(e.getMessage())); }
    }

    private static final Pattern LIST_OK = Pattern.compile("^(https://(www|m)\\.youtube\\.com/[\\w/@.?=&%-]+|:yt(rec|subs|history|watchlater|fav)|ytsearch\\d{1,3}:.+)$");
    static void list(Http.Request r, OutputStream out) throws IOException {
        String u = r.param("u");
        if (!LIST_OK.matcher(u).matches()) { Http.text(out, 400, "bad url"); return; }
        int start = Math.max(1, parseInt(r.param("start"), 1)), end = Math.min(300, parseInt(r.param("end"), 60));
        try {
            if (!init()) throw new IOException("yt-dlp no está listo");
            YoutubeDLRequest req = new YoutubeDLRequest(u);
            base(req);
            req.addOption("--flat-playlist"); req.addOption("-J"); req.addOption("--playlist-items", start + ":" + end);
            JSONObject j = new JSONObject(YoutubeDL.getInstance().execute(req).getOut().trim());
            JSONArray in = j.optJSONArray("entries"), outArr = new JSONArray();
            if (in != null) for (int i = 0; i < in.length(); i++) {
                JSONObject e = in.getJSONObject(i);
                JSONObject o = new JSONObject().put("ID", e.optString("id")).put("URL", e.optString("url")).put("Title", e.optString("title"))
                        .put("Channel", e.optString("channel", e.optString("uploader"))).put("ChannelID", e.optString("channel_id"))
                        .put("Duration", e.optDouble("duration", 0)).put("Views", e.optLong("view_count")).put("Live", e.optString("live_status")).put("Timestamp", e.optLong("timestamp"));
                JSONArray th = e.optJSONArray("thumbnails");
                if (th != null && th.length() > 0) { JSONObject t = th.getJSONObject(th.length() - 1); o.put("Thumb", t.optString("url")); o.put("Vertical", t.optInt("height") > t.optInt("width") && t.optInt("width") > 0); }
                outArr.put(o);
            }
            Http.json(out, new JSONObject().put("title", j.optString("title")).put("entries", outArr));
        } catch (Throwable e) { Http.text(out, 502, friendly(String.valueOf(e.getMessage()))); }
    }
    static int parseInt(String s, int d) { try { return Integer.parseInt(s); } catch (Exception e) { return d; } }

    static void watched(Http.Request r, OutputStream out) throws IOException {
        String id = r.param("id");
        Http.noContent(out);
        if (!YtAccount.connected() || !id.matches("[A-Za-z0-9_-]{11}")) return;
        PREP.execute(() -> {
            try {
                YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + id);
                base(req); req.addOption("--mark-watched"); req.addOption("--simulate"); req.addOption("--no-playlist");
                YoutubeDL.getInstance().execute(req);
            } catch (Throwable e) { Diag.log("yt: marcar visto: " + shortMsg(e.getMessage())); }
        });
    }

    static JSONObject tools() {
        JSONObject o = new JSONObject();
        try { o.put("ready", ready); o.put("busy", !ready); o.put("version", ytdlpVersion); o.put("ffmpeg", true); } catch (Exception ignored) {}
        return o;
    }
    static void forceUpdate() { if (app == null) return; app.getSharedPreferences("ytdlp", Context.MODE_PRIVATE).edit().putLong("checked", 0).apply(); PREP.execute(() -> { update(false); noteVersion(); }); }

    /* ---------- descargas (a la carpeta de Mix4Up; salen en «Mis vídeos») ---------- */
    static final class Job { String key, id, title, q, state = "queued", file = "", error = ""; double pct; long at; }
    private static final List<Job> jobs = new ArrayList<>();
    private static final ExecutorService DL = Executors.newFixedThreadPool(2);
    private static VideoLibrary lib;
    static void setLibrary(VideoLibrary l) { lib = l; }

    static void downloads(Http.Request r, OutputStream out) throws IOException {
        if (r.method.equals("POST")) {
            try {
                JSONObject v = new JSONObject(r.bodyText(8192));
                String id = v.optString("id");
                if (!id.matches("[A-Za-z0-9_-]{11}")) { Http.text(out, 400, "bad"); return; }
                Job j = new Job();
                j.key = Long.toHexString(System.nanoTime()); j.id = id; j.title = v.optString("title"); j.q = v.optString("q"); j.at = System.currentTimeMillis();
                synchronized (jobs) { jobs.add(j); if (jobs.size() > 60) jobs.remove(0); }
                DL.execute(() -> runJob(j));
            } catch (org.json.JSONException e) { Http.text(out, 400, "bad json"); return; }
        } else if (r.method.equals("DELETE")) {
            String k = r.param("key");
            synchronized (jobs) {
                for (Iterator<Job> it = jobs.iterator(); it.hasNext(); ) {
                    Job j = it.next();
                    if (!j.key.equals(k)) continue;
                    if (j.state.equals("running")) { try { YoutubeDL.class.getMethod("destroyProcessById", String.class).invoke(YoutubeDL.getInstance(), j.key); } catch (Throwable ignored) {} }
                    else it.remove();
                }
            }
        }
        JSONArray arr = new JSONArray();
        synchronized (jobs) {
            for (Job j : jobs) try { arr.put(new JSONObject().put("key", j.key).put("id", j.id).put("title", j.title).put("q", j.q).put("state", j.state).put("pct", j.pct).put("file", j.file).put("error", j.error).put("at", j.at)); } catch (Exception ignored) {}
        }
        Http.json(out, arr);
    }

    private static String dlFormat(String q) {
        if ("audio".equals(q)) return "ba[ext=m4a]/ba";
        int h = parseInt(q, 0);
        if (h <= 0) return "bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba/b";
        return "bv*[height<=" + h + "][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=" + h + "]+ba/b[height<=" + h + "]/b";
    }

    private static void runJob(Job j) {
        j.state = "running";
        try {
            if (!init()) throw new IOException("yt-dlp no está listo");
            File dir = lib.downloadDir();
            YoutubeDLRequest req = new YoutubeDLRequest("https://www.youtube.com/watch?v=" + j.id);
            base(req);
            req.addOption("--no-playlist"); req.addOption("--newline"); req.addOption("--no-mtime");
            req.addOption("-N", "4"); req.addOption("--http-chunk-size", "10M");
            req.addOption("-f", dlFormat(j.q));
            if (!"audio".equals(j.q)) req.addOption("--merge-output-format", "mp4");
            req.addOption("-o", new File(dir, "%(title).100B [%(id)s].%(ext)s").getAbsolutePath());
            req.addOption("--print", "after_move:filepath");
            // el progreso: lo que ya ocupa en la carpeta, frente a lo que ocupará
            long expected = 0;
            try {
                Info in = info(j.id, false);
                int want = parseInt(j.q, 0);
                Format bv = null, ba = null;
                for (Format f : in.formats) {
                    if (f.kind.equals("a") && "m4a".equals(f.ext) && (ba == null || f.tbr > ba.tbr)) ba = f;
                    if (f.kind.equals("v") && f.vcodec.startsWith("avc1") && (want == 0 || f.h <= want) && (bv == null || f.h > bv.h)) bv = f;
                }
                expected = ("audio".equals(j.q) ? 0 : (bv == null ? 0 : bv.size)) + (ba == null ? 0 : ba.size);
            } catch (Exception ignored) {}
            final long exp = expected;
            final boolean[] running = {true};
            Thread mon = new Thread(() -> {
                while (running[0] && exp > 0) {
                    long sum = 0;
                    File[] fs = dir.listFiles();
                    if (fs != null) for (File f : fs) if (f.getName().contains("[" + j.id + "]")) sum += f.length();
                    j.pct = Math.min(99, sum * 100.0 / exp);
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                }
            });
            mon.setDaemon(true);
            mon.start();
            final String[] last = {""};
            YoutubeDLResponse resp;
            try { resp = YoutubeDL.getInstance().execute(req, j.key); }
            finally { running[0] = false; }
            String outp = resp.getOut().trim();
            String path = outp.contains("\n") ? outp.substring(outp.lastIndexOf('\n') + 1).trim() : outp;
            if (path.isEmpty()) path = last[0];
            j.file = new File(path).getName();
            j.pct = 100; j.state = "done";
            Diag.log("descargado " + j.file);
            lib.scan(true);
        } catch (Throwable e) {
            j.state = "error"; j.error = friendly(String.valueOf(e.getMessage()));
            Diag.log("descarga " + j.id + ": " + shortMsg(e.getMessage()));
        }
    }
}
