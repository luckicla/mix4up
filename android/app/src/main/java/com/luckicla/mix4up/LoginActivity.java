package com.luckicla.mix4up;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * «Conectar con YouTube»: el inicio de sesión de Google en una ventana de
 * Mix4Up. Cuando YouTube ya te reconoce, las cookies de la sesión se guardan
 * en la carpeta privada de Mix4Up (solo en este móvil) y la ventana se cierra.
 */
public class LoginActivity extends Activity {
    private WebView web;
    private final Handler h = new Handler(Looper.getMainLooper());
    private boolean done;

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Google no deja iniciar sesión desde un «WebView»: se presenta como Chrome del móvil
        s.setUserAgentString(s.getUserAgentString().replace("; wv", "").replaceAll("Version/\\d+\\.\\d+ ", ""));
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) { return false; }
            @Override public void onPageFinished(WebView v, String url) { check(); }
        });
        setContentView(web);
        String next = "https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26app%3Dm%26hl%3Des%26next%3D%252F";
        web.loadUrl("https://accounts.google.com/ServiceLogin?service=youtube&hl=es&passive=true&continue=" + next);
        h.postDelayed(poll, 1500);
    }

    private final Runnable poll = new Runnable() { @Override public void run() { check(); if (!done) h.postDelayed(this, 1500); } };

    private void check() {
        if (done || web == null) return;
        String url = web.getUrl() == null ? "" : web.getUrl();
        String c = CookieManager.getInstance().getCookie("https://www.youtube.com");
        if (c == null) return;
        boolean sid = c.contains("SAPISID=") || c.contains("__Secure-3PAPISID="), info = c.contains("LOGIN_INFO=");
        if (url.contains("youtube.com") && sid && info) {
            done = true;
            CookieManager.getInstance().flush();
            new Thread(() -> {
                YtAccount.setFromWebView(c);
                YtAccount.cfg(true);
                h.post(() -> { MainActivity.loggedIn(); finish(); });
            }).start();
        }
    }

    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }

    @Override protected void onDestroy() { h.removeCallbacksAndMessages(null); if (web != null) { web.destroy(); web = null; } super.onDestroy(); }
}
