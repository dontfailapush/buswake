# Bus Alarm

Sleep on the bus. Bus Alarm watches your location in the background (screen locked, music playing) and rings a loud alarm when you get within a set distance of your stop.

## How it works

- A background service on your phone checks your GPS and works out the distance to your stop. The web page is only the screen you tap on, so locking the phone doesn't stop the alarm.
- The alarm rings on the phone's **alarm volume** (set to maximum while it rings), pauses your music while it sounds, vibrates, and shows a full-screen "Wake up!" on the lock screen.
- A small "Bus Alarm is on" notification stays up while it's watching. That is what keeps Android from putting it to sleep.

## Getting the app

GitHub builds the installable file (APK) for you: **Actions** tab → newest run → **Artifacts** → **bus-alarm-apk**.

Every build is signed with the same key, so a new build installs over the old one. (If you have a build from before the signing key was fixed, uninstall it once first.)

## Using it

1. Search an address or tap the map to drop a pin on your stop. Drag the pin to fine-tune. Tap the star to save a stop.
2. Pick how far from the stop to wake up (¼, ½, 1 or 2 miles).
3. Tap **Start Alarm**. The first time, allow location (and notifications) and tap **Allow background**.
4. Lock your phone and play your music.
5. When the alarm rings, tap **I'm awake** (on the screen or in the notification).

## Before your first ride

- Tap **Test alarm sound** once. It plays at full alarm volume.
- Location permission: choose **Allow only while using the app** with **Precise** on.
- Do a test ride while you're awake, using a stop you know.
- The map and address search need internet. The alarm itself only needs GPS.

## Notes

- GPS can be weak in tunnels or between tall buildings. A bigger wake-up distance gives more cushion.
- If the alarm is ignored, it stops ringing by itself after 10 minutes.
- Map data: OpenStreetMap contributors. Address search by Nominatim.
