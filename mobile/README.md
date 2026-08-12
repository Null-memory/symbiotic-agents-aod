# AOD Mobile

Android client for the local AOD orchestrator. It connects to a Windows-hosted AOD instance over LAN, Tailscale, or VPN, and stores the device session in Android secure storage.

## Install On A Phone

Install the APK from the project's GitHub Releases when one is available. APK files are release assets, not git-tracked source files.

Before opening the Android app, start the desktop AOD service with mobile access enabled:

```powershell
$env:AOD_MOBILE_ENABLED = "1"
$env:AOD_BIND_HOST = "0.0.0.0"
$env:AOD_PUBLIC_URL = "http://192.168.1.10:4821"
npm start
```

Use the desktop console's **手机连接** dialog to enable mobile access, set the mobile account, and obtain the reachable AOD URL. The Android client signs in with that URL, account, and password. For a physical phone on the same Wi-Fi, use the Windows LAN address shown there, such as `http://192.168.1.10:4821`; `127.0.0.1` and emulator-only addresses such as `10.0.2.2` will not work on a real phone. Windows Firewall must allow inbound access to the selected AOD port.

Run and task detail screens include verified deliverables. A run aggregates artifacts from every verified task, prioritizes the primary document, and previews text directly from the acceptance commit without requiring a GitHub PR.

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
login screen. The preview proxy forwards `/api` to `http://127.0.0.1:4821`,
avoiding browser CORS errors without changing the production AOD API policy.

The preview server binds to loopback by default. Do not expose it to a LAN or
Tailscale network because it is intended only for local emulator testing.

## Release Builds

Preview builds produce an installable APK:

```powershell
npm run android:apk
```

The command uses the `preview` profile from `eas.json`, where Android `buildType` is `apk`. The first EAS build prompts for Expo authentication and Android signing credentials. Keep credentials in Expo/EAS; do not commit keystores, passwords, or downloaded signing files.

After the APK is downloaded, publish it as a GitHub Release asset from the repository root:

```powershell
gh release create mobile-v0.2.3-preview .\AOD-Mobile-0.2.3-arm64-preview.apk --title "AOD Mobile v0.2.3 Preview" --notes "Experimental APK build. Use with caution."
```

Production builds produce an Android App Bundle for Play distribution:

```powershell
npm run android:aab
```
