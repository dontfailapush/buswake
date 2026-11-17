# Bus Alarm

Sleep on the bus. Bus Alarm tracks your location (even with the screen locked) and sounds a loud alarm when you get within a set distance of your stop.

## Get the app on your Samsung (no Play Store, no installs on your computer)

GitHub builds the installable file (APK) for you, for free.

1. Make a free account at github.com, then click **New repository**. Name it `bus-alarm` (Private is fine) and create it.
2. On the repo page click **Add file → Upload files**. Unzip this folder and drag **everything inside it** into the page. Click **Commit changes**.
3. Make sure the build file made it. Open the **Code** tab and look for `.github/workflows/build-apk.yml`. If you don't see it:
   **Add file → Create new file**, type `.github/workflows/build-apk.yml` as the name, paste in the contents of `build-apk-workflow.yml` from this folder, and commit.
4. Click the **Actions** tab. A run called **Build Bus Alarm APK** starts by itself (about 5 to 8 minutes). Wait for the green check.
5. Open that run, scroll to **Artifacts**, and download **bus-alarm-apk**. Unzip it to get `app-debug.apk`.
6. Get the APK onto your phone (email it to yourself, Google Drive, or USB). Tap it, allow **Install unknown apps** for that app when asked, and install. The Bus Alarm icon appears on your home screen.

If the build fails, open the failed run, copy the red error text, and send it to me.

## Using it

1. Search an address or tap the map to drop a pin on your stop. Drag the pin to fine-tune. Tap the star to save a stop for next time.
2. Pick how far from the stop to wake up (¼, ½, 1 or 2 miles).
3. Tap **Start Alarm**, lock your phone, and play your music.
4. When the alarm rings, tap **I'm awake**.

## Before your first ride

- Tap **Test alarm sound** once and set your media volume where you'd hear it over your music.
- Allow location when asked ("While using the app" is enough). A small "Bus Alarm is on" notification stays up while it's tracking; that's what keeps it alive.
- Samsung: **Settings → Apps → Bus Alarm → Battery → Unrestricted**.
- Don't swipe Bus Alarm away from your recent apps while the alarm is on. Use the home button instead.
- The map and address search need internet. The alarm itself only needs GPS.

## Notes

- Alarm sound plays at media volume, over your music. A notification sound also fires as a backup.
- GPS can be weak in tunnels or between tall buildings; the screen shows "GPS signal weak" if it loses you. A larger wake-up distance gives more cushion.
- Map data: OpenStreetMap contributors, tiles by CARTO. Address search by Nominatim.
