// Generates the Android project, then applies Bus Alarm's icon, theme, alarm
// sound, background alarm service and permissions on top. Safe to run more than once.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

if (!fs.existsSync('android')) run('npx cap add android');
run('npx cap sync android');

// Icon, dark theme, notification icon and alarm sound.
fs.cpSync('android-overlay/res', 'android/app/src/main/res', { recursive: true, force: true });

// Native alarm service, the plugin that controls it, and the main activity.
const javaDir = 'android/app/src/main/java/com/busalarm/app';
fs.mkdirSync(javaDir, { recursive: true });
fs.cpSync('android-native/java', javaDir, { recursive: true, force: true });

// Permissions and the service declaration.
const manifest = 'android/app/src/main/AndroidManifest.xml';
let xml = fs.readFileSync(manifest, 'utf8');

const perms = [
  'ACCESS_FINE_LOCATION',
  'ACCESS_COARSE_LOCATION',
  'FOREGROUND_SERVICE',
  'FOREGROUND_SERVICE_LOCATION',
  'POST_NOTIFICATIONS',
  'VIBRATE',
  'WAKE_LOCK',
  'USE_FULL_SCREEN_INTENT',
  'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
];
for (const p of perms) {
  if (!xml.includes(`android.permission.${p}"`)) {
    xml = xml.replace('</manifest>', `    <uses-permission android:name="android.permission.${p}" />\n</manifest>`);
  }
}

if (!xml.includes('.AlarmService')) {
  xml = xml.replace(
    '</application>',
    '    <service android:name=".AlarmService" android:exported="false" android:foregroundServiceType="location" />\n    </application>'
  );
}
fs.writeFileSync(manifest, xml);

console.log('Android project ready.');
