package com.luckicla.mix4up;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Mix4Up se acaba de actualizar sola: una notificación para que lo sepas. */
public class UpdatedReceiver extends BroadcastReceiver {
    static final String CHANNEL = "m4updates";

    @Override public void onReceive(Context ctx, Intent i) {
        if (!Intent.ACTION_MY_PACKAGE_REPLACED.equals(i.getAction())) return;
        try {
            String ver;
            try { ver = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; } catch (Exception e) { ver = ""; }
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Actualizaciones", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("Aviso cuando Mix4Up se actualiza");
                nm.createNotificationChannel(ch);
            }
            Intent open = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra("m4updated", true);
            PendingIntent pi = PendingIntent.getActivity(ctx, 7, open, PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0));
            Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(ctx, CHANNEL) : new Notification.Builder(ctx);
            b.setSmallIcon(R.drawable.ic_stat_m4)
                    .setContentTitle("Mix4Up se ha actualizado")
                    .setContentText(ver.isEmpty() ? "Ya tienes la versión nueva. Toca para ver lo nuevo." : "Ya tienes la versión " + ver + ". Toca para ver lo nuevo.")
                    .setContentIntent(pi).setAutoCancel(true);
            nm.notify(4242, b.build());
            Diag.init(ctx);
            Diag.log("actualizada a " + ver);
        } catch (Exception ignored) {}
    }
}
