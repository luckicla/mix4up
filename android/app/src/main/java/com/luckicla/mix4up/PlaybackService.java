package com.luckicla.mix4up;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Para seguir oyendo el vídeo con la pantalla apagada o con otra app delante:
 * mantiene Mix4Up vivo y pone los controles en la notificación y en la
 * pantalla de bloqueo. El vídeo suena en la página; esto solo pasa los botones.
 */
public class PlaybackService extends Service {
    static final String ACT_TOGGLE = "toggle", ACT_NEXT = "next", ACT_BACK = "back10", ACT_FWD = "fwd10", ACT_QUIT = "quit", ACT_UPDATE = "update";
    static final String CHANNEL = "playback";
    private static final int NOTIF_ID = 1;
    private static final long DETACH_MS = 20 * 60_000;

    static class State { String title = "Mix4Up", channel = "", thumb = ""; boolean playing; long posMs, durMs; Bitmap art; }

    private static PlaybackService instance;
    private static State pending = new State();
    static boolean isPlaying() { return instance != null && instance.state.playing; }

    private MediaSession session;
    private PowerManager.WakeLock wake;
    private android.net.wifi.WifiManager.WifiLock wifi;
    private State state = new State();
    private boolean foreground;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable detach = () -> {
        if (state.playing) return;
        stopForeground(STOP_FOREGROUND_DETACH);
        foreground = false;
        if (wake.isHeld()) wake.release();
        wifiLock(false);
    };

    static void update(Context ctx, State s) {
        new Handler(Looper.getMainLooper()).post(() -> {
            if (instance != null) instance.apply(s);
            else if (s.playing) {
                pending = s;
                Intent i = new Intent(ctx, PlaybackService.class).setAction(ACT_UPDATE);
                try { if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i); } catch (Exception ignored) {}
            }
        });
    }
    static void stop(Context ctx) { ctx.stopService(new Intent(ctx, PlaybackService.class)); }

    // la miniatura del vídeo (en un hilo aparte)
    private static String artFor = "";
    private static Bitmap artBmp;
    static void loadArt(Context ctx, State s) {
        if (s.thumb == null || s.thumb.isEmpty()) return;
        if (s.thumb.equals(artFor)) { s.art = artBmp; return; }
        artFor = s.thumb;
        new Thread(() -> {
            try {
                String u = s.thumb.startsWith("/") ? "http://127.0.0.1:" + MainActivity.serverPort() + s.thumb : s.thumb;
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(u).openConnection();
                if (s.thumb.startsWith("/")) c.setRequestProperty("Cookie", "m4=" + MainActivity.token());
                c.setConnectTimeout(6000); c.setReadTimeout(8000);
                Bitmap b = BitmapFactory.decodeStream(c.getInputStream());
                if (b != null) { artBmp = b; s.art = b; if (instance != null && instance.state == s) new Handler(Looper.getMainLooper()).post(() -> instance.apply(s)); }
            } catch (Exception ignored) {}
        }).start();
    }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
        }
        session = new MediaSession(this, "Mix4Up");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.remote("play"); }
            @Override public void onPause() { MainActivity.remote("pause"); }
            @Override public void onSkipToNext() { MainActivity.remote("next"); }
            @Override public void onRewind() { MainActivity.remote("back10"); }
            @Override public void onFastForward() { MainActivity.remote("fwd10"); }
            @Override public void onStop() { MainActivity.remote("pause"); }
            @Override public void onSeekTo(long pos) { MainActivity.remote("seek:" + (pos / 1000.0)); }
            @Override public void onCustomAction(String action, android.os.Bundle extras) { if (ACT_QUIT.equals(action)) MainActivity.quit(); else MainActivity.remote(action); }
        });
        session.setActive(true);
        wake = ((PowerManager) getSystemService(Context.POWER_SERVICE)).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mix4up:playback");
        wake.setReferenceCounted(false);
    }

    private void wifiLock(boolean on) {
        try {
            if (on) {
                if (wifi == null) { wifi = ((android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE)).createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "mix4up:playback"); wifi.setReferenceCounted(false); }
                if (!wifi.isHeld()) wifi.acquire();
            } else if (wifi != null && wifi.isHeld()) wifi.release();
        } catch (Exception ignored) {}
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String a = intent == null ? null : intent.getAction();
        if (ACT_QUIT.equals(a)) { MainActivity.quit(); return START_NOT_STICKY; }
        if (ACT_TOGGLE.equals(a)) MainActivity.remote("toggle");
        else if (ACT_NEXT.equals(a)) MainActivity.remote("next");
        else if (ACT_BACK.equals(a)) MainActivity.remote("back10");
        else if (ACT_FWD.equals(a)) MainActivity.remote("fwd10");
        apply(ACT_UPDATE.equals(a) ? pending : state);
        return START_NOT_STICKY;
    }

    void apply(State s) {
        state = s;
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title).putString(MediaMetadata.METADATA_KEY_ARTIST, s.channel)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.durMs);
        if (s.art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ART, s.art);
        session.setMetadata(md.build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT
                        | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_REWIND | PlaybackState.ACTION_FAST_FORWARD)
                .setState(s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, s.posMs, s.playing ? 1f : 0f)
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACT_BACK, "−10 s", android.R.drawable.ic_media_rew).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACT_FWD, "+10 s", android.R.drawable.ic_media_ff).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder(ACT_QUIT, "Cerrar Mix4Up", R.drawable.ic_close).build())
                .build());
        Notification n = build(s);
        handler.removeCallbacks(detach);
        if (s.playing || !foreground) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            else startForeground(NOTIF_ID, n);
            foreground = true;
        } else getSystemService(NotificationManager.class).notify(NOTIF_ID, n);
        if (s.playing) { wake.acquire(6 * 3600_000L); wifiLock(true); }
        else { if (wake.isHeld()) wake.release(); wifiLock(false); handler.postDelayed(detach, DETACH_MS); }
    }

    private Notification build(State s) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        b.setSmallIcon(R.drawable.ic_stat_m4).setContentTitle(s.title).setContentText(s.channel).setLargeIcon(s.art)
                .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setVisibility(Notification.VISIBILITY_PUBLIC).setShowWhen(false).setOngoing(s.playing)
                .addAction(action(android.R.drawable.ic_media_rew, "−10 s", ACT_BACK, 1))
                .addAction(action(s.playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, s.playing ? "Pausar" : "Reproducir", ACT_TOGGLE, 2))
                .addAction(action(android.R.drawable.ic_media_ff, "+10 s", ACT_FWD, 3))
                .addAction(action(android.R.drawable.ic_media_next, "Siguiente", ACT_NEXT, 4))
                .addAction(action(R.drawable.ic_close, "Cerrar", ACT_QUIT, 5))
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }
    private Notification.Action action(int icon, String title, String act, int req) {
        Intent i = new Intent(this, PlaybackService.class).setAction(act);
        return new Notification.Action.Builder(Icon.createWithResource(this, icon), title, PendingIntent.getService(this, req, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)).build();
    }

    @Override public void onTaskRemoved(Intent rootIntent) { if (!state.playing) stopSelf(); }

    @Override public void onDestroy() {
        handler.removeCallbacks(detach);
        instance = null;
        if (wake != null && wake.isHeld()) wake.release();
        wifiLock(false);
        if (session != null) session.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }
}
