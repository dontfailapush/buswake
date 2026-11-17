// Generates the Android project, then applies Bus Alarm's icon, theme, alarm
// sound and permissions on top. Safe to run more than once.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

if (!fs.existsSync('android')) run('npx cap add android');
run('npx cap sync android');

// Icon, dark theme, notification icon and alarm sound.
fs.cpSync('android-overlay/res', 'android/app/src/main/res', { recursive: true, force: true });

// Vibration for the alarm (the location and notification permissions come from the plugins).
const manifest = 'android/app/src/main/AndroidManifest.xml';
let xml = fs.readFileSync(manifest, 'utf8');
if (!xml.includes('android.permission.VIBRATE')) {
  xml = xml.replace('</manifest>', '    <uses-permission android:name="android.permission.VIBRATE" />\n</manifest>');
  fs.writeFileSync(manifest, xml);
}

console.log('Android project ready.');
