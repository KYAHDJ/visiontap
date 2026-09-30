package com.visiontap.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

public class VisionTapWidget extends AppWidgetProvider {
    static final int[] ROW_IDS = {R.id.row1, R.id.row2, R.id.row3, R.id.row4, R.id.row5};

    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        context.startForegroundService(new Intent(context, MonitorService.class));
        updateAll(context);
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, VisionTapWidget.class);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_bar);
        SharedPreferences prefs = context.getSharedPreferences("visiontap", Context.MODE_PRIVATE);
        for (int i = 0; i < ROW_IDS.length; i++) {
            String fallback = Config.ACCOUNTS[i] + "  —  waiting for update";
            views.setTextViewText(ROW_IDS[i], prefs.getString("row_" + i, fallback));
        }
        views.setTextViewText(R.id.updated, prefs.getString("updated", "Starting monitor…"));
        Intent open = new Intent(context, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(context, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        views.setOnClickPendingIntent(R.id.widget_root, pending);
        manager.updateAppWidget(component, views);
    }
}
