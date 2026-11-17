package com.luckicla.mix4up;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Lo pequeño de HTTP que comparten el servidor local y las piezas de YouTube. */
final class Http {
    private Http() {}

    static final class Request {
        String method, path, query = "";
        Map<String, String> headers = new HashMap<>();
        InputStream body;

        String param(String key) {
            for (String kv : query.split("&")) {
                if (kv.startsWith(key + "=")) {
                    try { return URLDecoder.decode(kv.substring(key.length() + 1), "UTF-8"); } catch (Exception e) { return ""; }
                }
            }
            return "";
        }

        byte[] body(int max) throws IOException {
            int len = 0;
            try { len = Integer.parseInt(headers.getOrDefault("content-length", "0")); } catch (NumberFormatException ignored) {}
            if (len < 0 || len > max) throw new IOException("body too large");
            byte[] b = new byte[len];
            int off = 0;
            while (off < len) {
                int n = body.read(b, off, len - off);
                if (n < 0) break;
                off += n;
            }
            return b;
        }

        String bodyText(int max) throws IOException { return new String(body(max), StandardCharsets.UTF_8); }
    }

    static Request parse(InputStream in) throws IOException {
        String line = readLine(in);
        if (line == null || line.isEmpty()) return null;
        String[] p = line.split(" ");
        if (p.length < 2) return null;
        Request r = new Request();
        r.method = p[0];
        String target = p[1];
        int q = target.indexOf('?');
        r.path = q >= 0 ? target.substring(0, q) : target;
        try { r.path = URLDecoder.decode(r.path.replace("+", "%2B"), "UTF-8"); } catch (Exception ignored) {}
        if (q >= 0) r.query = target.substring(q + 1);
        for (String h; (h = readLine(in)) != null && !h.isEmpty(); ) {
            int c = h.indexOf(':');
            if (c > 0) r.headers.put(h.substring(0, c).trim().toLowerCase(Locale.ROOT), h.substring(c + 1).trim());
        }
        r.body = in;
        return r;
    }

    static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1; ) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 16384) throw new IOException("header too long");
        }
        if (b.size() == 0) return "";
        return b.toString("UTF-8");
    }

    static String status(int code) {
        switch (code) {
            case 200: return "OK";
            case 204: return "No Content";
            case 206: return "Partial Content";
            case 302: return "Found";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 404: return "Not Found";
            case 405: return "Method Not Allowed";
            case 416: return "Range Not Satisfiable";
            case 502: return "Bad Gateway";
            case 503: return "Service Unavailable";
            default: return "Error";
        }
    }

    static void send(OutputStream out, int code, String type, byte[] body) throws IOException {
        String h = "HTTP/1.1 " + code + " " + status(code) + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                + "Connection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    static void text(OutputStream out, int code, String msg) throws IOException {
        send(out, code, "text/plain; charset=utf-8", msg.getBytes(StandardCharsets.UTF_8));
    }

    static void json(OutputStream out, Object o) throws IOException {
        send(out, 200, "application/json; charset=utf-8", String.valueOf(o).getBytes(StandardCharsets.UTF_8));
    }

    static void noContent(OutputStream out) throws IOException { send(out, 204, "text/plain", new byte[0]); }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[16384];
        for (int n; (n = in.read(buf)) > 0; ) b.write(buf, 0, n);
        in.close();
        return b.toByteArray();
    }

    static void writeAtomic(File f, byte[] b) throws IOException {
        File dir = f.getParentFile();
        if (dir != null) dir.mkdirs();
        File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(b); }
        if (!tmp.renameTo(f)) { f.delete(); if (!tmp.renameTo(f)) throw new IOException("no se pudo guardar " + f.getName()); }
    }

    static String mimeFor(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html; charset=utf-8";
        if (p.endsWith(".js")) return "text/javascript; charset=utf-8";
        if (p.endsWith(".css")) return "text/css; charset=utf-8";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".ico")) return "image/x-icon";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".vtt")) return "text/vtt; charset=utf-8";
        return "application/octet-stream";
    }

    static String jsonStr(String s) { return org.json.JSONObject.quote(s == null ? "" : s); }
}
