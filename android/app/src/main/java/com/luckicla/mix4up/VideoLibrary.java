package com.luckicla.mix4up;

import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Size;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Los vídeos del móvil (los que Android conoce) y los descargados con Mix4Up. */
final class VideoLibrary {
    static final class Video {
        String id, name, title, folder, ext, mime;
        long size, mtime;
        double dur;
        Uri uri;   // de MediaStore
        File file; // descargado por Mix4Up
    }

    private final Context ctx;
    private final Map<String, Video> byId = new HashMap<>();
    private List<Video> list = new ArrayList<>();
    private long scannedAt;

    VideoLibrary(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    File downloadDir() {
        File base = ctx.getExternalFilesDir(Environment.DIRECTORY_MOVIES);
        if (base == null) base = new File(ctx.getFilesDir(), "Movies");
        File d = new File(base, "Mix4Up");
        d.mkdirs();
        return d;
    }

    private static final String[] NATIVE = {"mp4", "m4v", "webm", "mkv", "3gp", "mov", "ts"};
    static boolean nativeExt(String e) { for (String n : NATIVE) if (n.equals(e)) return true; return false; }

    synchronized JSONObject scan(boolean force) {
        if (force || System.currentTimeMillis() - scannedAt > 20_000 || list.isEmpty()) {
            List<Video> found = new ArrayList<>();
            try {
                String[] cols = {MediaStore.Video.Media._ID, MediaStore.Video.Media.DISPLAY_NAME, MediaStore.Video.Media.SIZE,
                        MediaStore.Video.Media.DATE_MODIFIED, MediaStore.Video.Media.DURATION, MediaStore.Video.Media.BUCKET_DISPLAY_NAME, MediaStore.Video.Media.MIME_TYPE};
                Uri base = Build.VERSION.SDK_INT >= 29 ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL) : MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                try (Cursor c = ctx.getContentResolver().query(base, cols, null, null, MediaStore.Video.Media.DATE_MODIFIED + " DESC")) {
                    if (c != null) while (c.moveToNext()) {
                        Video v = new Video();
                        long id = c.getLong(0);
                        v.id = "m" + id;
                        v.name = c.getString(1) == null ? ("video" + id) : c.getString(1);
                        v.size = c.getLong(2);
                        v.mtime = c.getLong(3) * 1000;
                        v.dur = c.getLong(4) / 1000.0;
                        v.folder = c.getString(5) == null ? "Vídeos" : c.getString(5);
                        v.mime = c.getString(6) == null ? "video/mp4" : c.getString(6);
                        v.uri = ContentUris.withAppendedId(base, id);
                        fill(v);
                        if (v.size > 32 * 1024) found.add(v);
                    }
                }
            } catch (SecurityException e) {
                Diag.log("vídeos: sin permiso");
            } catch (Exception e) {
                Diag.log("vídeos: " + e);
            }
            File[] fs = downloadDir().listFiles();
            if (fs != null) for (File f : fs) {
                if (!f.isFile() || f.getName().endsWith(".part") || f.getName().endsWith(".ytdl") || f.length() < 32 * 1024) continue;
                String e = ext(f.getName());
                if (!nativeExt(e) && !e.equals("m4a")) continue;
                Video v = new Video();
                v.id = "f" + Integer.toHexString(f.getAbsolutePath().hashCode());
                v.name = f.getName(); v.size = f.length(); v.mtime = f.lastModified(); v.file = f;
                v.folder = "Mix4Up"; v.mime = e.equals("webm") ? "video/webm" : e.equals("m4a") ? "audio/mp4" : "video/mp4";
                v.dur = fileDuration(f);
                fill(v);
                found.add(0, v);
            }
            byId.clear();
            for (Video v : found) byId.put(v.id, v);
            list = found;
            scannedAt = System.currentTimeMillis();
        }
        JSONObject out = new JSONObject();
        try {
            JSONArray arr = new JSONArray();
            for (Video v : list) {
                JSONObject o = new JSONObject();
                o.put("id", v.id); o.put("key", "lv:" + v.name.toLowerCase(Locale.ROOT) + "|" + v.size);
                o.put("title", v.title); o.put("file", v.name); o.put("folder", v.folder); o.put("size", v.size);
                o.put("mtime", v.mtime); o.put("dur", v.dur); o.put("ext", v.ext); o.put("native", nativeExt(v.ext)); o.put("thumb", true);
                arr.put(o);
            }
            out.put("videos", arr);
            out.put("folders", new JSONArray().put("Vídeos del móvil"));
            out.put("downloads", downloadDir().getAbsolutePath());
        } catch (Exception ignored) {}
        return out;
    }

    private static String ext(String name) { int i = name.lastIndexOf('.'); return i < 0 ? "" : name.substring(i + 1).toLowerCase(Locale.ROOT); }
    private static void fill(Video v) {
        v.ext = ext(v.name);
        String stem = v.name.contains(".") ? v.name.substring(0, v.name.lastIndexOf('.')) : v.name;
        v.title = stem.contains(" ") ? stem : stem.replaceAll("[._]+", " ").trim();
    }

    synchronized Video get(String id) {
        if (byId.isEmpty()) scan(true);
        return byId.get(id);
    }

    private double fileDuration(File f) {
        android.media.MediaMetadataRetriever r = new android.media.MediaMetadataRetriever();
        try { r.setDataSource(f.getAbsolutePath()); String d = r.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION); return d == null ? 0 : Long.parseLong(d) / 1000.0; }
        catch (Exception e) { return 0; }
        finally { try { r.release(); } catch (Exception ignored) {} }
    }

    /** /video/<id>: el archivo, con «Range» (hace falta para saltar a cualquier punto). */
    void serve(Http.Request r, OutputStream out, String id) throws IOException {
        Video v = get(id);
        if (v == null) { Http.text(out, 404, "no está"); return; }
        ParcelFileDescriptor pfd = v.file != null ? ParcelFileDescriptor.open(v.file, ParcelFileDescriptor.MODE_READ_ONLY) : ctx.getContentResolver().openFileDescriptor(v.uri, "r");
        if (pfd == null) { Http.text(out, 404, "no está"); return; }
        try (FileInputStream fin = new ParcelFileDescriptor.AutoCloseInputStream(pfd)) {
            long size = pfd.getStatSize();
            if (size <= 0) size = v.size;
            long start = 0, end = size - 1;
            boolean partial = false;
            String range = r.headers.get("range");
            if (range != null && range.startsWith("bytes=")) {
                String[] p = range.substring(6).split("-", 2);
                try {
                    if (!p[0].isEmpty()) start = Long.parseLong(p[0]);
                    if (p.length > 1 && !p[1].isEmpty()) end = Math.min(Long.parseLong(p[1]), size - 1);
                    if (p[0].isEmpty() && p.length > 1) { start = Math.max(0, size - Long.parseLong(p[1])); end = size - 1; }
                    partial = true;
                } catch (NumberFormatException ignored) {}
            }
            if (start > end || start >= size) {
                out.write(("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */" + size + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").getBytes());
                return;
            }
            long len = end - start + 1;
            String mime = v.mime;
            if ("mkv".equals(v.ext)) mime = "video/webm";
            if ("mov".equals(v.ext)) mime = "video/mp4";
            String h = (partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n")
                    + "Content-Type: " + mime + "\r\nAccept-Ranges: bytes\r\nContent-Length: " + len + "\r\n"
                    + (partial ? "Content-Range: bytes " + start + "-" + end + "/" + size + "\r\n" : "")
                    + "Cache-Control: no-cache\r\nConnection: close\r\n\r\n";
            out.write(h.getBytes(StandardCharsets.UTF_8));
            if (r.method.equals("HEAD")) return;
            fin.getChannel().position(start);
            byte[] buf = new byte[128 * 1024];
            long left = len;
            while (left > 0) {
                int n = fin.read(buf, 0, (int) Math.min(buf.length, left));
                if (n < 0) break;
                out.write(buf, 0, n);
                left -= n;
            }
        }
        out.flush();
    }

    /** /thumb/<id>: la guardada, o hecha aquí por Android. */
    void thumb(Http.Request r, OutputStream out, String id) throws IOException {
        if (!id.matches("[A-Za-z0-9_-]{1,64}")) { Http.text(out, 404, ""); return; }
        File f = new File(ctx.getFilesDir(), "miniaturas/" + id + ".jpg");
        if (r.method.equals("PUT")) {
            byte[] b = r.body(4 * 1024 * 1024);
            if (b.length > 2 && (b[0] & 0xff) == 0xFF && (b[1] & 0xff) == 0xD8) Http.writeAtomic(f, b);
            Http.noContent(out);
            return;
        }
        if (!f.exists()) {
            Video v = get(id);
            Bitmap bm = null;
            try {
                if (v != null && v.uri != null && Build.VERSION.SDK_INT >= 29) bm = ctx.getContentResolver().loadThumbnail(v.uri, new Size(480, 270), null);
                else if (v != null && v.file != null && Build.VERSION.SDK_INT >= 29) bm = android.media.ThumbnailUtils.createVideoThumbnail(v.file, new Size(480, 270), null);
                else if (v != null && v.uri != null) bm = MediaStore.Video.Thumbnails.getThumbnail(ctx.getContentResolver(), Long.parseLong(v.id.substring(1)), MediaStore.Video.Thumbnails.MINI_KIND, null);
                else if (v != null && v.file != null) bm = android.media.ThumbnailUtils.createVideoThumbnail(v.file.getAbsolutePath(), MediaStore.Video.Thumbnails.MINI_KIND);
            } catch (Exception ignored) {}
            if (bm == null) { Http.text(out, 404, ""); return; }
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            bm.compress(Bitmap.CompressFormat.JPEG, 82, b);
            Http.writeAtomic(f, b.toByteArray());
        }
        byte[] img;
        try (InputStream in = new FileInputStream(f)) { img = Http.readAll(in); }
        String h = "HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: " + img.length + "\r\nCache-Control: max-age=86400\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
        out.write(img);
        out.flush();
    }

    /** Borrar un vídeo descargado con Mix4Up (los de la galería, desde la galería). */
    boolean delete(String id) {
        Video v = get(id);
        if (v == null || v.file == null) return false;
        boolean ok = v.file.delete();
        new File(ctx.getFilesDir(), "miniaturas/" + id + ".jpg").delete();
        scan(true);
        return ok;
    }
}
