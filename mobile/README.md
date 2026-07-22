# AOD Mobile

Android client for the local AOD orchestrator. It connects to a Windows-hosted AOD instance over Tailscale and stores the device session in Android secure storage.

## Development

```powershell
npm install
npm run android:run
```

## Android Emulator Browser Preview

Build the web bundle once, then start the same-origin preview proxy:

```powershell
npx expo export --platform web
npm run preview
```

Alternatively, double-click `run-preview.cmd`. Open `http://10.0.2.2:4173`
inside the Android emulator and use that same URL as the AOD address on the
login screen. The preview proxy forwards `/api` to `http://127.0.0.1:4830`,
avoiding browser CORS errors without changing the production AOD API policy.

The preview server binds to loopback by default. Do not expose it to a LAN or
Tailscale network because it is intended only for local emulator testing.

Use the desktop console's **手机连接** dialog to enable mobile access, set the mobile account, and obtain the Tailscale URL. The Android client signs in with that URL, account, and password.

## Release Builds

Preview builds produce an installable APK:

```powershell
npm run android:apk
```

Production builds produce an Android App Bundle for Play distribution:

```powershell
npm run android:aab
```

The first EAS build prompts for Expo authentication and Android signing credentials. Keep credentials in Expo/EAS; do not commit keystores, passwords, or downloaded signing files.
