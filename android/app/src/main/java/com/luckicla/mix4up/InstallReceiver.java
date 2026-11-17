package com.luckicla.mix4up;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/** El resultado de instalar la versión nueva (PackageInstaller). */
public class InstallReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context ctx, Intent i) {
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, -999);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); try { ctx.startActivity(confirm); } catch (Exception ignored) {} }
        } else if (st != PackageInstaller.STATUS_SUCCESS) {
            String msg = i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
            Diag.log("actualizar: " + st + " " + msg);
            MainActivity.updateState("{\"state\":\"error\",\"msg\":" + Http.jsonStr(msg == null ? "no se pudo instalar" : msg) + "}");
        }
    }
}
