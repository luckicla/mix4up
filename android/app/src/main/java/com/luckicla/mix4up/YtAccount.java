package com.luckicla.mix4up;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Tu cuenta de YouTube en el móvil (como yt.go en el PC): las cookies de la
 * sesión, solo en la carpeta privada de Mix4Up; la página pregunta a YouTube
 * lo mismo que su web (InnerTube) y aquí se añade la sesión.
 */
final class YtAccount {
    static final String UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";
    static final String ORIGIN = "https://www.youtube.com";

    static final class Cookie { String domain, path = "/", name, value; boolean secure = true; long expires; }

    private static File file;
    private static final List<Cookie> cookies = new ArrayList<>();
    private static JSONObject cfg;
    private static long cfgAt;

    static synchronized void init(File dataDir) {
        file = new File(dataDir, "youtube-cookies.txt");
        load();
    }
    static String cookieFile() { return connected() ? file.getAbsolutePath() : null; }

    private static synchronized void load() {
        cookies.clear();
        if (file == null || !file.exists()) return;
        try (InputStream in = new FileInputStream(file)) { cookies.addAll(parseNetscape(new String(Http.readAll(in), StandardCharsets.UTF_8))); }
        catch (IOException ignored) {}
    }

    static List<Cookie> parseNetscape(String text) {
        List<Cookie> out = new ArrayList<>();
        for (String line : text.split("\n")) {
            line = line.replace("\r", "");
            if (line.startsWith("#HttpOnly_")) line = line.substring(10);
            else if (line.startsWith("#") || line.trim().isEmpty()) continue;
            String[] p = line.split("\t");
            if (p.length < 7) continue;
            Cookie c = new Cookie();
            c.domain = p[0]; c.path = p[2]; c.secure = p[3].equalsIgnoreCase("TRUE"); c.name = p[5]; c.value = p[6];
            try { c.expires = Long.parseLong(p[4]); } catch (NumberFormatException ignored) {}
            out.add(c);
        }
        return out;
    }

    private static synchronized void save() {
        StringBuilder b = new StringBuilder("# Netscape HTTP Cookie File\n# Mix4Up: tu sesión de YouTube. No compartas este archivo.\n");
        for (Cookie c : cookies) {
            b.append(c.domain).append('\t').append(c.domain.startsWith(".") ? "TRUE" : "FALSE").append('\t').append(c.path == null ? "/" : c.path).append('\t')
                    .append(c.secure ? "TRUE" : "FALSE").append('\t').append(c.expires).append('\t').append(c.name).append('\t').append(c.value).append('\n');
        }
        try { Http.writeAtomic(file, b.toString().getBytes(StandardCharsets.UTF_8)); } catch (IOException e) { Diag.log("yt: no se guardó la sesión: " + e.getMessage()); }
        synchronized (YtAccount.class) { cfg = null; }
    }

    /** Lo que da la ventana de inicio de sesión (CookieManager: "a=1; b=2"). */
    static synchronized void setFromWebView(String header) {
        cookies.clear();
        if (header != null) for (String kv : header.split(";")) {
            int i = kv.indexOf('=');
            if (i <= 0) continue;
            Cookie c = new Cookie();
            c.domain = ".youtube.com"; c.name = kv.substring(0, i).trim(); c.value = kv.substring(i + 1).trim();
            c.expires = System.currentTimeMillis() / 1000 + 180L * 86400;
            cookies.add(c);
        }
        save();
        YtVideo.clearCache();
        Diag.log("yt: cuenta conectada (" + cookies.size() + " cookies)");
    }
    static synchronized void setFromText(String text) { cookies.clear(); cookies.addAll(parseNetscape(text)); save(); YtVideo.clearCache(); }
    static synchronized void clear() { cookies.clear(); if (file != null) file.delete(); cfg = null; YtVideo.clearCache(); }

    static synchronized String value(String name) {
        long now = System.currentTimeMillis() / 1000;
        for (Cookie c : cookies) if (c.name.equals(name) && c.domain.endsWith("youtube.com") && (c.expires == 0 || c.expires > now)) return c.value;
        return "";
    }
    static boolean connected() { return !value("SAPISID").isEmpty() || !value("__Secure-3PAPISID").isEmpty(); }

    static synchronized String header() {
        StringBuilder b = new StringBuilder();
        Set<String> seen = new HashSet<>();
        long now = System.currentTimeMillis() / 1000;
        for (Cookie c : cookies) {
            String d = c.domain.startsWith(".") ? c.domain.substring(1) : c.domain;
            if ((!d.equals("youtube.com") && !d.equals("www.youtube.com")) || (c.expires != 0 && c.expires < now) || !seen.add(c.name)) continue;
            if (b.length() > 0) b.append("; ");
            b.append(c.name).append('=').append(c.value);
        }
        if (!seen.contains("SOCS")) { if (b.length() > 0) b.append("; "); b.append("SOCS=CAI"); }
        return b.toString();
    }

    private static final Pattern MAXAGE = Pattern.compile("max-age=(-?\\d+)"), EXPIRES = Pattern.compile("(?i)expires=([^;]+)");
    private static final Set<String> KEEP = new HashSet<>(java.util.Arrays.asList("SID", "HSID", "SSID", "APISID", "SAPISID", "LOGIN_INFO",
            "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PAPISID", "__Secure-3PAPISID"));
    /** Lo que YouTube cambia en la sesión, guardado. */
    static void absorb(HttpURLConnection c) {
        if (!connected()) return;
        Map<String, List<String>> h = c.getHeaderFields();
        List<String> sc = h == null ? null : h.get("Set-Cookie");
        if (sc == null) sc = h == null ? null : h.get("set-cookie");
        if (sc == null || sc.isEmpty()) return;
        boolean changed = false;
        synchronized (YtAccount.class) {
            for (String s : sc) {
                String first = s.split(";", 2)[0];
                int i = first.indexOf('=');
                if (i <= 0) continue;
                String name = first.substring(0, i).trim(), val = first.substring(i + 1).trim();
                String low = s.toLowerCase(java.util.Locale.ROOT);
                if (low.contains("domain=") && !low.contains("youtube.com")) continue;
                // ¿la borra? (caducada o Max-Age=0): fuera, en vez de guardar «EXPIRED» como si fuera
                // su valor (eso estropeaba la sesión y YouTube dejaba de reconocer la cuenta)
                long exp = System.currentTimeMillis() / 1000 + 180L * 86400;
                Matcher ma = MAXAGE.matcher(low);
                if (ma.find()) { try { exp = System.currentTimeMillis() / 1000 + Long.parseLong(ma.group(1)); } catch (NumberFormatException ignored) {} }
                else {
                    Matcher me = EXPIRES.matcher(s);
                    if (me.find()) try { exp = new java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", java.util.Locale.US).parse(me.group(1).trim().replace('-', ' ')).getTime() / 1000; } catch (Exception ignored) {}
                }
                boolean gone = exp <= System.currentTimeMillis() / 1000 || val.isEmpty() || val.equals("EXPIRED") || val.equals("deleted");
                if (gone) {
                    // las cookies que dicen quién eres no se tiran por un aviso suelto: solo si YouTube de verdad cierra la sesión
                    if (KEEP.contains(name)) continue;
                    if (cookies.removeIf(ck -> ck.name.equals(name))) changed = true;
                    continue;
                }
                boolean found = false;
                for (Cookie ck : cookies) if (ck.name.equals(name)) { if (!ck.value.equals(val)) { ck.value = val; ck.expires = exp; changed = true; } found = true; }
                if (!found) { Cookie ck = new Cookie(); ck.domain = ".youtube.com"; ck.name = name; ck.value = val; ck.expires = exp; cookies.add(ck); changed = true; }
            }
        }
        if (changed) save();
    }

    private static String sha1(String s) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-1").digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder b = new StringBuilder();
            for (byte x : d) b.append(String.format("%02x", x));
            return b.toString();
        } catch (Exception e) { return ""; }
    }
    static String auth(String userSession) {
        String ts = String.valueOf(System.currentTimeMillis() / 1000);
        StringBuilder out = new StringBuilder();
        String sap = value("SAPISID");
        if (sap.isEmpty()) sap = value("__Secure-3PAPISID");
        String[][] schemes = {{"SAPISIDHASH", sap}, {"SAPISID1PHASH", value("__Secure-1PAPISID")}, {"SAPISID3PHASH", value("__Secure-3PAPISID")}};
        for (String[] s : schemes) {
            if (s[1].isEmpty()) continue;
            String base = (userSession.isEmpty() ? "" : userSession + " ") + ts + " " + s[1] + " " + ORIGIN;
            if (out.length() > 0) out.append(' ');
            out.append(s[0]).append(' ').append(ts).append('_').append(sha1(base)).append(userSession.isEmpty() ? "" : "_u");
        }
        return out.toString();
    }

    private static final Pattern VER = Pattern.compile("\"INNERTUBE_CLIENT_VERSION\":\"([^\"]+)\""), VIS = Pattern.compile("\"VISITOR_DATA\":\"([^\"]+)\""),
            LOGGED = Pattern.compile("\"LOGGED_IN\":(true|false)"), DSYNC = Pattern.compile("\"DATASYNC_ID\":\"([^\"]*)\""), GL = Pattern.compile("\"GL\":\"([^\"]+)\"");

    static synchronized JSONObject cfg(boolean force) {
        if (!force && cfg != null && System.currentTimeMillis() - cfgAt < 3600_000L) return cfg;
        JSONObject c = new JSONObject();
        try {
            c.put("clientVersion", "2.20251114.01.00"); c.put("visitorData", ""); c.put("loggedIn", false); c.put("hl", "es"); c.put("gl", "ES"); c.put("ok", false);
            HttpURLConnection h = (HttpURLConnection) new URL(ORIGIN + "/?hl=es&gl=ES").openConnection();
            h.setConnectTimeout(12000); h.setReadTimeout(15000);
            h.setRequestProperty("User-Agent", UA); h.setRequestProperty("Accept-Language", "es-ES,es;q=0.9"); h.setRequestProperty("Cookie", header());
            String body = new String(Http.readAll(h.getInputStream()), StandardCharsets.UTF_8);
            absorb(h);
            Matcher m;
            if ((m = VER.matcher(body)).find()) { c.put("clientVersion", m.group(1)); c.put("ok", true); }
            if ((m = VIS.matcher(body)).find()) c.put("visitorData", m.group(1));
            if ((m = LOGGED.matcher(body)).find()) c.put("loggedIn", m.group(1).equals("true"));
            if ((m = DSYNC.matcher(body)).find()) c.put("dataSync", m.group(1));
            if ((m = GL.matcher(body)).find()) c.put("gl", m.group(1));
        } catch (Exception e) {
            try { c.put("error", "Sin conexión con YouTube"); } catch (Exception ignored) {}
        }
        try { c.put("connected", connected()); } catch (Exception ignored) {}
        if (c.optBoolean("ok")) { cfg = c; cfgAt = System.currentTimeMillis(); }
        return c;
    }

    private static String userSession() {
        String ds = cfg(false).optString("dataSync", "");
        if (ds.isEmpty()) return "";
        int i = ds.indexOf("||");
        if (i < 0) return ds;
        String second = ds.substring(i + 2);
        return second.isEmpty() ? ds.substring(0, i) : second;
    }

    private static final Set<String> OK = new HashSet<>(java.util.Arrays.asList("browse", "next", "search", "guide", "player", "like/like", "like/removelike", "like/dislike",
            "subscription/subscribe", "subscription/unsubscribe", "browse/edit_playlist", "playlist/create", "account/account_menu", "feedback", "navigation/resolve_url"));

    /** /api/yt/i/<punto> */
    static void innertube(Http.Request r, OutputStream out, String ep) throws IOException {
        if (!r.method.equals("POST") || !OK.contains(ep)) { Http.text(out, 400, "bad request"); return; }
        byte[] body = r.body(256 * 1024);
        JSONObject c = cfg(false);
        HttpURLConnection h = (HttpURLConnection) new URL(ORIGIN + "/youtubei/v1/" + ep + "?prettyPrint=false").openConnection();
        h.setConnectTimeout(12000); h.setReadTimeout(20000);
        h.setRequestMethod("POST"); h.setDoOutput(true);
        h.setRequestProperty("Content-Type", "application/json");
        h.setRequestProperty("User-Agent", UA);
        h.setRequestProperty("Origin", ORIGIN); h.setRequestProperty("Referer", ORIGIN + "/"); h.setRequestProperty("X-Origin", ORIGIN);
        h.setRequestProperty("Accept-Language", "es-ES,es;q=0.9");
        h.setRequestProperty("X-Youtube-Client-Name", "1");
        h.setRequestProperty("X-Youtube-Client-Version", c.optString("clientVersion"));
        if (!c.optString("visitorData").isEmpty()) h.setRequestProperty("X-Goog-Visitor-Id", c.optString("visitorData"));
        h.setRequestProperty("Cookie", header());
        if (connected()) { h.setRequestProperty("Authorization", auth(userSession())); h.setRequestProperty("X-Goog-AuthUser", "0"); }
        byte[] res;
        int code;
        try {
            try (OutputStream o = h.getOutputStream()) { o.write(body); }
            code = h.getResponseCode();
            InputStream in = code < 400 ? h.getInputStream() : h.getErrorStream();
            res = in == null ? new byte[0] : Http.readAll(in);
            absorb(h);
        } catch (IOException e) { Http.text(out, 502, "Sin conexión con YouTube"); return; }
        Http.send(out, code, "application/json; charset=utf-8", res);
    }

    /** /api/yt/suggest?q= */
    static void suggest(Http.Request r, OutputStream out) throws IOException {
        JSONArray arr = new JSONArray();
        String q = r.param("q").trim();
        if (!q.isEmpty()) try {
            HttpURLConnection h = (HttpURLConnection) new URL("https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&hl=es&gl=es&q=" + URLEncoder.encode(q, "UTF-8")).openConnection();
            h.setConnectTimeout(6000); h.setReadTimeout(6000); h.setRequestProperty("User-Agent", UA);
            String s = new String(Http.readAll(h.getInputStream()), StandardCharsets.UTF_8);
            int i = s.indexOf('('), j = s.lastIndexOf(')');
            if (i >= 0 && j > i) {
                JSONArray all = new JSONArray(s.substring(i + 1, j));
                JSONArray list = all.optJSONArray(1);
                if (list != null) for (int k = 0; k < list.length(); k++) { JSONArray it = list.optJSONArray(k); if (it != null) arr.put(it.optString(0)); }
            }
        } catch (Exception ignored) {}
        Http.json(out, arr);
    }
}
