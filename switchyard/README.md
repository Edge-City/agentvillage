# Switchyard

An open source, Windows-style window switcher for macOS. Hold **⌥ Option** and tap **Tab** to flip through every window of every app, with window previews.

- **No update prompts.** There is no updater, no network code, no telemetry.
- **No missing apps.** Windows are gathered from three sources (accessibility, the window server for other Spaces and full screen, and a fallback entry for any app that reports no window), so every app with a Dock icon is always reachable.
- **Small and auditable.** About 1,000 lines of Swift, no dependencies, MIT licensed.

## Keys

| Keys | Action |
| --- | --- |
| ⌥Tab / ⌥⇧Tab | Next / previous window, across all apps |
| ⌥` | Cycle windows of the current app only |
| ← → ↑ ↓ | Move the selection while the panel is open |
| Release ⌥, Return, or click | Switch to the selected window |
| W | Close the selected window |
| Q | Quit the selected app |
| Esc | Cancel |

A quick tap switches straight to the previous window without drawing the panel. W and Q act immediately, with no confirmation.

From the menu bar icon you can change the trigger to ⌃ Control, and turn off the ⌥` shortcut. Turn it off if you type accented letters with ⌥` (it is the grave accent dead key on many layouts).

## Install

There are no prebuilt, notarized downloads yet, so build it yourself. It takes under a minute.

Requires macOS 13 or later and the Xcode Command Line Tools (`xcode-select --install`).

```bash
./scripts/build-app.sh
```

```bash
cp -R dist/Switchyard.app /Applications/ && open /Applications/Switchyard.app
```

## Permissions

- **Accessibility** (required): lists windows, focuses, closes and un-minimizes them, and runs the keyboard listener for the hotkey. Switchyard starts working the moment you grant it, no relaunch needed.
- **Screen Recording** (optional, requested at launch): window previews and the titles of windows on other Spaces. Without it you get app icons.

### What it can see

A global hotkey on macOS requires a listener that receives every key press, so that is what Accessibility grants here. Switchyard looks only at the key code and modifier flags to spot its own shortcuts. Nothing is logged, written to disk, or sent anywhere: the app contains no networking, file-writing, or logging code, and previews are held in memory only. The only thing it saves is your trigger-key preference. The source is short enough to check this yourself; `HotkeyTap.swift` and `SwitcherController.swift` are the relevant files.

The build is signed with the hardened runtime so other processes cannot inject code into Switchyard to borrow these permissions.

Ad-hoc signed builds lose their Accessibility grant on every rebuild, because macOS ties the grant to the binary's signature. To avoid re-granting, sign with a stable certificate: `SIGN_IDENTITY="Your Certificate Name" ./scripts/build-app.sh`.

## Known limits

- ⌘Tab is not replaceable yet. macOS reserves it for the Dock, so the trigger is ⌥ or ⌃.
- Tabs of a window on another Space can show up as separate entries.
- Menu-bar-only apps (no Dock icon) are not listed.
- The ⌥` shortcut uses the physical key left of 1 on US keyboards; on other layouts it is a different key.
- Switchyard uses a handful of undocumented window-server calls (listed in `Sources/Switchyard/PrivateAPI.swift`). They are what makes other-Space windows and exact-window focus possible, and they rule out the Mac App Store.

## Layout

| File | Role |
| --- | --- |
| `WindowCatalog.swift` | Finds and orders windows |
| `HotkeyTap.swift` | Global keyboard tap |
| `SwitcherController.swift` | Key handling and session state |
| `SwitcherPanel.swift` | The preview grid |
| `Thumbnailer.swift` | Window previews |
| `Activator.swift` | Focus, close, quit |
| `AppDelegate.swift` | Menu bar item and permissions |
| `PrivateAPI.swift` | Bindings for undocumented system calls |
