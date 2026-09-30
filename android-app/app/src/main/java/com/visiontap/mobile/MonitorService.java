package com.visiontap.mobile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.DecimalFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class MonitorService extends Service {
    private static final String MONITOR_CHANNEL = "visiontap_monitor";
    private static final String ALERT_CHANNEL = "visiontap_alerts";
    private final ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor();
    private final Map<String, Boolean> verification = new HashMap<>();
    private final Map<String, Boolean> running = new HashMap<>();
    private final Map<String, Integer> errors = new HashMap<>();
    private boolean baselineReady;
    private boolean scannerUp = true;
    private boolean loopPaused;
    private int networkFailures;
    private boolean networkAlerted;
    private String withdrawalFingerprint = "";
    private int alertId = 2000;

    @Override public void onCreate() {
        super.onCreate();
        createChannels();
        startForeground(1, monitorNotification("Connecting to Oracle…"));
        executor.scheduleWithFixedDelay(this::pollSafe, 0, 30, TimeUnit.SECONDS);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onDestroy() { executor.shutdownNow(); super.onDestroy(); }

    private void createChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel monitor = new NotificationChannel(MONITOR_CHANNEL, "VisionTap monitoring", NotificationManager.IMPORTANCE_LOW);
        monitor.setDescription("Keeps live account monitoring active");
        NotificationChannel alerts = new NotificationChannel(ALERT_CHANNEL, "VisionTap alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Verification, withdrawal, worker and recovery alerts");
        nm.createNotificationChannel(monitor); nm.createNotificationChannel(alerts);
    }

    private PendingIntent openApp() {
        return PendingIntent.getActivity(this, 7, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification monitorNotification(String text) {
        return new Notification.Builder(this, MONITOR_CHANNEL).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("VisionTap monitoring").setContentText(text).setOngoing(true).setContentIntent(openApp()).build();
    }

    private void notifyAlert(String title, String text) {
        Notification n = new Notification.Builder(this, ALERT_CHANNEL).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title).setContentText(text).setStyle(new Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true).setContentIntent(openApp()).build();
        getSystemService(NotificationManager.class).notify(alertId++, n);
    }

    private void pollSafe() {
        try {
            JSONObject root = fetch();
            networkFailures = 0;
            if (networkAlerted) { notifyAlert("VisionTap connected", "The phone can reach the Oracle dashboard again."); networkAlerted = false; }
            process(root);
        } catch (Exception e) {
            Log.e("VisionTap", "Dashboard poll failed", e);
            networkFailures++;
            if (networkFailures >= 3 && !networkAlerted) {
                networkAlerted = true;
                notifyAlert("VisionTap dashboard unreachable", "Three consecutive checks failed. Tap to open the dashboard.");
            }
        }
    }

    private JSONObject fetch() throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(Config.API).openConnection();
        c.setConnectTimeout(8000); c.setReadTimeout(8000); c.setUseCaches(false);
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream()))) {
            StringBuilder b = new StringBuilder(); String line;
            while ((line = r.readLine()) != null) b.append(line);
            return new JSONObject(b.toString());
        } finally { c.disconnect(); }
    }

    private void process(JSONObject root) {
        boolean nextScanner = root.optBoolean("scannerUp", false);
        boolean nextPaused = root.optBoolean("loopPaused", false);
        JSONArray pilots = root.optJSONArray("chromePilots");
        JSONArray slots = root.optJSONArray("slots");
        Map<String, JSONObject> pilotMap = new HashMap<>();
        Map<String, JSONObject> slotMap = new HashMap<>();
        if (pilots != null) for (int i=0;i<pilots.length();i++) { JSONObject p=pilots.optJSONObject(i); if(p!=null) pilotMap.put(p.optString("account").toLowerCase(Locale.US),p); }
        if (slots != null) for (int i=0;i<slots.length();i++) { JSONObject s=slots.optJSONObject(i); if(s!=null) slotMap.put(s.optString("accountName").toLowerCase(Locale.US),s); }

        SharedPreferences.Editor edit = getSharedPreferences("visiontap", MODE_PRIVATE).edit();
        DecimalFormat money = new DecimalFormat("0.00#");
        int healthy = 0;
        for (int i=0;i<Config.ACCOUNTS.length;i++) {
            String account = Config.ACCOUNTS[i]; JSONObject p=pilotMap.get(account), s=slotMap.get(account);
            boolean isRunning = p != null && p.optBoolean("running", false);
            boolean isVerify = p != null && p.optBoolean("verificationHold", false);
            int errorCount = p == null ? 0 : p.optInt("errors", 0);
            double balance = s == null ? 0 : s.optDouble("withdrawable", 0);
            if (account.equals("kyaiko")) balance /= 100.0;
            String state = isVerify ? "VERIFY" : (isRunning ? "RUNNING" : "STOPPED");
            if (isRunning && !isVerify) healthy++;
            edit.putString("row_"+i, account + "   ₱" + money.format(balance) + "   " + state);

            if (baselineReady) {
                Boolean oldVerify=verification.get(account), oldRunning=running.get(account); Integer oldErrors=errors.get(account);
                if (isVerify && Boolean.FALSE.equals(oldVerify)) notifyAlert(account + " needs verification", "Open VisionTap and complete the manual security check.");
                if (!isVerify && Boolean.TRUE.equals(oldVerify)) notifyAlert(account + " verification cleared", "The account returned to its normal solving loop.");
                if (!isRunning && Boolean.TRUE.equals(oldRunning)) notifyAlert(account + " stopped", "The Chrome worker is no longer running.");
                if (isRunning && Boolean.FALSE.equals(oldRunning)) notifyAlert(account + " recovered", "The Chrome worker is running again.");
                if (oldErrors != null && errorCount > oldErrors) notifyAlert(account + " error", "Error count increased from " + oldErrors + " to " + errorCount + ".");
            }
            verification.put(account,isVerify); running.put(account,isRunning); errors.put(account,errorCount);
        }

        if (baselineReady) {
            if (!nextScanner && scannerUp) notifyAlert("Scanner offline", "The Oracle scanner stopped responding.");
            if (nextScanner && !scannerUp) notifyAlert("Scanner recovered", "The Oracle scanner is online again.");
            if (nextPaused && !loopPaused) notifyAlert("VisionTap loop paused", "The global solving loop is paused.");
            if (!nextPaused && loopPaused) notifyAlert("VisionTap loop resumed", "The global solving loop is running again.");
        }
        scannerUp=nextScanner; loopPaused=nextPaused;

        JSONObject adaihbi=slotMap.get("adaihbi"), enc=adaihbi==null?null:adaihbi.optJSONObject("encashment");
        if (enc != null) {
            String fp=enc.optString("status")+"|"+enc.optString("payoutStatus")+"|"+enc.optString("transactionId")+"|"+enc.optString("reference")+"|"+enc.optString("message");
            if (baselineReady && !fp.equals(withdrawalFingerprint) && !fp.replace("|","").isEmpty()) {
                String summary=enc.optString("message"); if(summary.isEmpty()) summary="Status: "+enc.optString("status",enc.optString("payoutStatus","updated"));
                notifyAlert("Withdrawal update", summary);
            }
            withdrawalFingerprint=fp;
        }

        String time=new SimpleDateFormat("h:mm:ss a",Locale.US).format(new Date());
        edit.putString("updated", healthy+"/5 clear • updated "+time).apply();
        VisionTapWidget.updateAll(this);
        getSystemService(NotificationManager.class).notify(1,monitorNotification(healthy+"/5 accounts clear • "+time));
        baselineReady=true;
    }
}
