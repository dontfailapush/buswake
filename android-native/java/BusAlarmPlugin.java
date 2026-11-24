package com.busalarm.app;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.util.ArrayList;
import java.util.List;

/** Bridge between the web screen and the background AlarmService. */
@CapacitorPlugin(
    name = "BusAlarm",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = "notifications", strings = { "android.permission.POST_NOTIFICATIONS" })
    }
)
public class BusAlarmPlugin extends Plugin {

    private static BusAlarmPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    /** Called by the service to tell the screen what is happening (ignored if the screen isn't open). */
    static void emit(String event, JSObject data) {
        BusAlarmPlugin p = instance;
        if (p == null) return;
        try {
            p.notifyListeners(event, data);
        } catch (Exception ignored) { }
    }

    private boolean hasFineLocation() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    /* ---------------- Permissions ---------------- */

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        List<String> need = new ArrayList<>();
        if (!hasFineLocation()) need.add("location");
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) need.add("notifications");
        if (need.isEmpty()) {
            resolvePermissions(call);
        } else {
            requestPermissionForAliases(need.toArray(new String[0]), call, "permissionsDone");
        }
    }

    @PermissionCallback
    private void permissionsDone(PluginCall call) {
        resolvePermissions(call);
    }

    private void resolvePermissions(PluginCall call) {
        JSObject r = new JSObject();
        r.put("location", hasFineLocation());
        r.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(r);
    }

    /* ---------------- Alarm control ---------------- */

    @PluginMethod
    public void start(PluginCall call) {
        if (!hasFineLocation()) {
            call.reject("Location permission is missing", "NOT_AUTHORIZED");
            return;
        }
        Double lat = call.getDouble("lat");
        Double lng = call.getDouble("lng");
        if (lat == null || lng == null) {
            call.reject("Missing stop location");
            return;
        }
        Intent i = new Intent(getContext(), AlarmService.class);
        i.setAction(AlarmService.ACTION_START);
        i.putExtra("lat", lat.doubleValue());
        i.putExtra("lng", lng.doubleValue());
        i.putExtra("radius", call.getInt("radius", 805));
        i.putExtra("name", call.getString("name", "your stop"));
        try {
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Exception e) {
            call.reject("Couldn't start the alarm service: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent i = new Intent(getContext(), AlarmService.class);
        i.setAction(AlarmService.ACTION_STOP);
        try {
            getContext().startService(i);
        } catch (Exception ignored) { }
        getContext().getSharedPreferences(AlarmService.PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("active", false).putBoolean("ringing", false).apply();
        call.resolve();
    }

    @PluginMethod
    public void getState(PluginCall call) {
        SharedPreferences sp = getContext().getSharedPreferences(AlarmService.PREFS, Context.MODE_PRIVATE);
        boolean active = AlarmService.running || sp.getBoolean("active", false);
        JSObject r = new JSObject();
        r.put("active", active);
        r.put("ringing", AlarmService.ringing || (active && sp.getBoolean("ringing", false)));
        r.put("distance", AlarmService.lastDistance);
        r.put("accuracy", AlarmService.lastAccuracy);
        r.put("latitude", AlarmService.lastLat);
        r.put("longitude", AlarmService.lastLng);
        r.put("time", AlarmService.lastFixTime);
        double startD = AlarmService.startDistance;
        if (startD < 0) {
            try { startD = Double.parseDouble(sp.getString("startS", "-1")); } catch (NumberFormatException ignored) { }
        }
        r.put("startDistance", startD);
        r.put("name", sp.getString("name", ""));
        r.put("radius", sp.getInt("radius", 805));
        try {
            r.put("lat", Double.parseDouble(sp.getString("latS", "0")));
            r.put("lng", Double.parseDouble(sp.getString("lngS", "0")));
        } catch (NumberFormatException ignored) { }
        call.resolve(r);
    }

    @PluginMethod
    public void testSound(PluginCall call) {
        AlarmService.playTest(getContext());
        call.resolve();
    }

    /* ---------------- Settings helpers ---------------- */

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        try {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (Build.VERSION.SDK_INT >= 23 && pm != null && !pm.isIgnoringBatteryOptimizations(getContext().getPackageName())) {
                Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                i.setData(Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            } else {
                openSettingsInternal();
            }
        } catch (Exception e) {
            openSettingsInternal();
        }
        call.resolve();
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        openSettingsInternal();
        call.resolve();
    }

    private void openSettingsInternal() {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + getContext().getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) { }
    }
}
