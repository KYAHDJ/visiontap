package com.visiontap.mobile;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    private WebView webView;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
        }
        startForegroundService(new Intent(this, MonitorService.class));

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(7, 8, 20));

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        bar.setPadding(18, 10, 10, 10);
        TextView title = new TextView(this);
        title.setText(R.string.app_name); title.setTextColor(Color.WHITE); title.setTextSize(20); title.setTypeface(null, Typeface.BOLD);
        bar.addView(title, new LinearLayout.LayoutParams(0, 52, 1));
        Button refresh = new Button(this); refresh.setText(R.string.refresh); refresh.setOnClickListener(v -> webView.reload());
        bar.addView(refresh, new LinearLayout.LayoutParams(-2, 52));
        root.addView(bar);

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        webView.setWebViewClient(new WebViewClient());
        webView.setBackgroundColor(Color.rgb(7, 8, 20));
        webView.loadUrl(Config.DASHBOARD);
        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
    }

    @Override public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }
}
