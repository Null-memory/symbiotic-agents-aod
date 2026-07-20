# AOD Mobile

Android client for the local AOD orchestrator. It connects to a Windows-hosted AOD instance over Tailscale and stores the device session in Android secure storage.

## Development

```powershell
npm install
npm run android:run
```

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
