package com.busalarm.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.content.res.AssetFileDescriptor;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;

/**
 * Runs in the background (foreground service) while the alarm is armed.
 * It watches GPS, works out the distance to the stop, and rings on the ALARM
 * audio stream when the phone gets close. None of this depends on the web page.
 */
public class AlarmService extends Service {

    public static final String ACTION_START = "com.busalarm.app.START";
    public static final String ACTION_STOP = "com.busalarm.app.STOP";

    static final String PREFS = "busalarm_state";
    static final String CH_TRACK = "bus_tracking";
    static final String CH_ARRIVE = "bus_arrival";
    static final int NOTIF_TRACK = 41;
    static final int NOTIF_ARRIVE = 42;

    // Read by the plugin so the screen can show the current state when reopened.
    static volatile boolean running = false;
    static volatile boolean ringing = false;
    static volatile double lastDistance = -1;
    static volatile double lastLat = 0, lastLng = 0;
    static volatile float lastAccuracy = 0;
    static volatile long lastFixTime = 0;
    static volatile double startDistance = -1;

    private double stopLat, stopLng;
    private int radius = 805;
    private String stopName = "your stop";
    private boolean armed = false; // true once the first fix has been checked
    private boolean triggered = false; // true once the alarm has gone off (so it never re-triggers)

    private LocationManager locationManager;
    private PowerManager.WakeLock wakeLock;
    private MediaPlayer player;
    private ToneGenerator tone;
    private Vibrator vibrator;
    private AudioManager audioManager;
    private AudioFocusRequest focusRequest;
    private int previousAlarmVolume = -1;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastNotifyAt = 0;
    private boolean destroyedByStop = false;

    /* ------------------------------------------------------------ */
    /*  Lifecycle                                                    */
    /* ------------------------------------------------------------ */

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        if (ACTION_STOP.equals(action)) {
            shutdown(true);
            return START_NOT_STICKY;
        }

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        if (intent != null && ACTION_START.equals(action)) {
            stopLat = intent.getDoubleExtra("lat", 0);
            stopLng = intent.getDoubleExtra("lng", 0);
            radius = intent.getIntExtra("radius", 805);
            String n = intent.getStringExtra("name");
            stopName = (n == null || n.isEmpty()) ? "your stop" : n;
            armed = false;
            ringing = false;
            startDistance = -1;
            lastDistance = -1;
            lastFixTime = 0;
            triggered = false;
            sp.edit().putBoolean("active", true).putString("latS", String.valueOf(stopLat))
                    .putString("lngS", String.valueOf(stopLng)).putInt("radius", radius).putString("name", stopName)
                    .putBoolean("armed", false).putBoolean("ringing", false).apply();
        } else {
            // The system restarted us after killing the process: pick up where we left off.
            if (!sp.getBoolean("active", false)) {
                stopSelf();
                return START_NOT_STICKY;
            }
            try {
                stopLat = Double.parseDouble(sp.getString("latS", "0"));
                stopLng = Double.parseDouble(sp.getString("lngS", "0"));
            } catch (NumberFormatException e) {
                stopSelf();
                return START_NOT_STICKY;
            }
            radius = sp.getInt("radius", 805);
            stopName = sp.getString("name", "your stop");
            armed = sp.getBoolean("armed", false);
            ringing = sp.getBoolean("ringing", false);
            triggered = ringing;
        }

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        createChannels();

        try {
            android.app.Notification n = buildTrackingNotification("Waiting for GPS…");
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_TRACK, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            } else {
                startForeground(NOTIF_TRACK, n);
            }
        } catch (Exception e) {
            emitError("service_failed", String.valueOf(e.getMessage()));
            shutdown(true);
            return START_NOT_STICKY;
        }

        running = true;
        acquireWakeLock();
        startLocationUpdates();
        if (ringing) startRinging(lastDistance >= 0 ? lastDistance : 0, true);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (!destroyedByStop) cleanup();
        super.onDestroy();
    }

    private void shutdown(boolean userInitiated) {
        destroyedByStop = true;
        cleanup();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("active", false).putBoolean("ringing", false).apply();
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIF_ARRIVE);
        } catch (Exception ignored) { }
        try {
            stopForeground(true);
        } catch (Exception ignored) { }
        stopSelf();
        if (userInitiated) BusAlarmPlugin.emit("stopped", new JSObject());
    }

    private void cleanup() {
        running = false;
        stopRinging();
        try {
            if (locationManager != null) locationManager.removeUpdates(locationListener);
        } catch (Exception ignored) { }
        handler.removeCallbacksAndMessages(null);
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) { }
        }
    }

    /* ------------------------------------------------------------ */
    /*  Location                                                     */
    /* ------------------------------------------------------------ */

    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location loc) {
            handleFix(loc);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) { }

        @Override
        public void onProviderEnabled(String provider) { }

        @Override
        public void onProviderDisabled(String provider) { }
    };

    private void startLocationUpdates() {
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        try {
            boolean gps = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
            boolean net = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
            if (gps) {
                locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, locationListener, Looper.getMainLooper());
            } else if (net) {
                locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 4000L, 0f, locationListener, Looper.getMainLooper());
            } else {
                emitError("location_off", "Location is turned off");
            }
        } catch (SecurityException e) {
            emitError("not_authorized", "Location permission missing");
            shutdown(true);
        } catch (Exception e) {
            emitError("location_failed", String.valueOf(e.getMessage()));
        }
    }

    private void handleFix(Location loc) {
        if (loc == null || !running) return;
        double d = distanceMeters(loc.getLatitude(), loc.getLongitude(), stopLat, stopLng);
        float acc = loc.hasAccuracy() ? loc.getAccuracy() : 0f;
        lastDistance = d;
        lastLat = loc.getLatitude();
        lastLng = loc.getLongitude();
        lastAccuracy = acc;
        lastFixTime = System.currentTimeMillis();

        if (!armed) {
            if (d <= radius) {
                // Started already inside the wake-up zone: nothing sensible to wait for.
                JSObject o = new JSObject();
                o.put("distance", d);
                BusAlarmPlugin.emit("inside", o);
                shutdown(false);
                BusAlarmPlugin.emit("stopped", new JSObject());
                return;
            }
            armed = true;
            startDistance = d;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("armed", true)
                    .putString("startS", String.valueOf(d)).apply();
        } else if (startDistance < 0) {
            try {
                startDistance = Double.parseDouble(getSharedPreferences(PREFS, MODE_PRIVATE).getString("startS", "-1"));
            } catch (NumberFormatException e) {
                startDistance = d;
            }
        }

        JSObject o = new JSObject();
        o.put("distance", d);
        o.put("accuracy", acc);
        o.put("latitude", loc.getLatitude());
        o.put("longitude", loc.getLongitude());
        o.put("startDistance", startDistance);
        o.put("time", lastFixTime);
        BusAlarmPlugin.emit("fix", o);

        // Counting a poor fix in the user's favour so a sleeper is never woken late.
        double slack = Math.min(acc, 100f);
        if (!triggered && d - slack <= radius) {
            startRinging(d, false);
        } else if (!triggered) {
            updateTrackingNotification(d);
        }
    }

    private static double distanceMeters(double lat1, double lng1, double lat2, double lng2) {
        double r = 6371000.0, rad = Math.PI / 180.0;
        double dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        return 2 * r * Math.asin(Math.sqrt(a));
    }

    private static String fmtDistance(double m) {
        if (m < 161) return Math.max(10, Math.round(m * 3.28084 / 10.0) * 10) + " ft";
        double mi = m / 1609.344;
        return String.format(java.util.Locale.US, mi >= 10 ? "%.0f mi" : "%.1f mi", mi);
    }

    /* ------------------------------------------------------------ */
    /*  Alarm                                                        */
    /* ------------------------------------------------------------ */

    private void startRinging(double d, boolean restored) {
        triggered = true;
        ringing = true;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("ringing", true).apply();

        acquireWakeLock();
        playAlarmSound();
        startVibration();
        showArrivalNotification(d);
        updateTrackingNotification(d);

        // Stop the noise after 10 minutes so a forgotten alarm can't run the battery flat.
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                stopRinging();
            }
        }, 10 * 60 * 1000L);

        JSObject o = new JSObject();
        o.put("distance", d);
        o.put("restored", restored);
        BusAlarmPlugin.emit("alarm", o);
    }

    private void playAlarmSound() {
        stopRinging();
        ringing = true;
        try {
            if (audioManager != null) {
                int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_ALARM);
                previousAlarmVolume = audioManager.getStreamVolume(AudioManager.STREAM_ALARM);
                try {
                    audioManager.setStreamVolume(AudioManager.STREAM_ALARM, max, 0);
                } catch (Exception ignored) { }
                requestFocus();
            }
        } catch (Exception ignored) { }

        try {
            int resId = getResources().getIdentifier("alarm", "raw", getPackageName());
            AssetFileDescriptor afd = getResources().openRawResourceFd(resId);
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            player.setLooping(true);
            player.setVolume(0.6f, 0.6f);
            player.prepare();
            player.start();
            rampVolume(0.6f);
        } catch (Exception e) {
            // Fall back to a plain alarm-stream beep so there is always some sound.
            releasePlayer();
            startBeepFallback();
        }
    }

    private void rampVolume(final float from) {
        final float next = Math.min(1f, from + 0.05f);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (player == null) return;
                try {
                    player.setVolume(next, next);
                } catch (Exception ignored) { }
                if (next < 1f) rampVolume(next);
            }
        }, 750L);
    }

    private void startBeepFallback() {
        try {
            tone = new ToneGenerator(AudioManager.STREAM_ALARM, 100);
            handler.post(new Runnable() {
                @Override
                public void run() {
                    if (tone == null || !ringing) return;
                    tone.startTone(ToneGenerator.TONE_CDMA_ABBR_ALERT, 900);
                    handler.postDelayed(this, 1200L);
                }
            });
        } catch (Exception ignored) { }
    }

    private void requestFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_ALARM)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build())
                    .build();
            audioManager.requestAudioFocus(focusRequest);
        } else {
            audioManager.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    private void abandonFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                if (focusRequest != null) audioManager.abandonAudioFocusRequest(focusRequest);
            } else {
                audioManager.abandonAudioFocus(null);
            }
        } catch (Exception ignored) { }
        focusRequest = null;
    }

    private void releasePlayer() {
        if (player != null) {
            try { player.stop(); } catch (Exception ignored) { }
            try { player.release(); } catch (Exception ignored) { }
            player = null;
        }
    }

    private void startVibration() {
        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null) return;
            long[] pattern = {0, 700, 300, 700, 300, 700, 1200};
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0),
                        new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build());
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception ignored) { }
    }

    private void stopRinging() {
        boolean wasRinging = ringing;
        ringing = false;
        handler.removeCallbacksAndMessages(null);
        releasePlayer();
        if (tone != null) {
            try { tone.stopTone(); } catch (Exception ignored) { }
            try { tone.release(); } catch (Exception ignored) { }
            tone = null;
        }
        try {
            if (vibrator != null) vibrator.cancel();
        } catch (Exception ignored) { }
        abandonFocus();
        if (wasRinging && audioManager != null && previousAlarmVolume >= 0) {
            try {
                audioManager.setStreamVolume(AudioManager.STREAM_ALARM, previousAlarmVolume, 0);
            } catch (Exception ignored) { }
            previousAlarmVolume = -1;
        }
    }

    /** Plays a short sample at full alarm volume so you can hear what it will sound like. */
    static void playTest(final Context context) {
        final AudioManager am = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        final int prev = am != null ? am.getStreamVolume(AudioManager.STREAM_ALARM) : -1;
        try {
            if (am != null) am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0);
        } catch (Exception ignored) { }
        try {
            int resId = context.getResources().getIdentifier("alarm", "raw", context.getPackageName());
            AssetFileDescriptor afd = context.getResources().openRawResourceFd(resId);
            final MediaPlayer mp = new MediaPlayer();
            mp.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mp.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            mp.prepare();
            mp.start();
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override
                public void run() {
                    try { mp.stop(); } catch (Exception ignored) { }
                    try { mp.release(); } catch (Exception ignored) { }
                    try {
                        if (am != null && prev >= 0) am.setStreamVolume(AudioManager.STREAM_ALARM, prev, 0);
                    } catch (Exception ignored) { }
                }
            }, 2600L);
        } catch (Exception ignored) { }
    }

    /* ------------------------------------------------------------ */
    /*  Notifications                                                */
    /* ------------------------------------------------------------ */

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;
        NotificationChannel track = new NotificationChannel(CH_TRACK, "Alarm is on", NotificationManager.IMPORTANCE_LOW);
        track.setDescription("Shown while Bus Alarm is watching for your stop");
        track.setShowBadge(false);
        nm.createNotificationChannel(track);

        NotificationChannel arrive = new NotificationChannel(CH_ARRIVE, "Arrival alarm", NotificationManager.IMPORTANCE_HIGH);
        arrive.setDescription("Appears when you are close to your stop");
        arrive.setSound(null, null);
        arrive.enableVibration(false);
        arrive.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
        nm.createNotificationChannel(arrive);
    }

    private PendingIntent openAppIntent(boolean ringingFlag) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        i.putExtra("ringing", ringingFlag);
        return PendingIntent.getActivity(this, ringingFlag ? 1 : 0, i, piFlags());
    }

    private PendingIntent stopIntent() {
        Intent i = new Intent(this, AlarmService.class);
        i.setAction(ACTION_STOP);
        return PendingIntent.getService(this, 2, i, piFlags());
    }

    private static int piFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
    }

    private android.app.Notification buildTrackingNotification(String text) {
        return new NotificationCompat.Builder(this, CH_TRACK)
                .setSmallIcon(R.drawable.ic_stat_busalarm)
                .setContentTitle("Bus Alarm is on")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setContentIntent(openAppIntent(false))
                .addAction(0, "Cancel alarm", stopIntent())
                .build();
    }

    private void updateTrackingNotification(double d) {
        long now = System.currentTimeMillis();
        if (now - lastNotifyAt < 8000 && !ringing) return;
        lastNotifyAt = now;
        String text = ringing ? "You're arriving at " + stopName : fmtDistance(d) + " to " + stopName;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIF_TRACK, buildTrackingNotification(text));
        } catch (Exception ignored) { }
    }

    private void showArrivalNotification(double d) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm == null) return;
            android.app.Notification n = new NotificationCompat.Builder(this, CH_ARRIVE)
                    .setSmallIcon(R.drawable.ic_stat_busalarm)
                    .setContentTitle("Wake up! Your stop is close")
                    .setContentText(stopName + " is " + fmtDistance(d) + " away")
                    .setPriority(NotificationCompat.PRIORITY_MAX)
                    .setCategory(NotificationCompat.CATEGORY_ALARM)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setOngoing(true)
                    .setAutoCancel(false)
                    .setFullScreenIntent(openAppIntent(true), true)
                    .setContentIntent(openAppIntent(true))
                    .addAction(0, "I'm awake", stopIntent())
                    .build();
            nm.notify(NOTIF_ARRIVE, n);
        } catch (Exception ignored) { }
    }

    /* ------------------------------------------------------------ */
    /*  Helpers                                                      */
    /* ------------------------------------------------------------ */

    private void acquireWakeLock() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "busalarm:tracking");
            }
            if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
        } catch (Exception ignored) { }
    }

    private void emitError(String code, String message) {
        JSObject o = new JSObject();
        o.put("code", code);
        o.put("message", message);
        BusAlarmPlugin.emit("error", o);
    }
}
