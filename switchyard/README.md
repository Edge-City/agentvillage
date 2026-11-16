# Switchyard

An open source, Windows-style window switcher for macOS. Hold **⌥ Option** and tap **Tab** to flip through every window of every app, with live previews.

- **No update prompts.** There is no updater, no network code, no telemetry.
- **No missing apps.** Windows are gathered from three sources (accessibility, the window server for other Spaces and full screen, and a fallback entry for any app that reports no window), so every running app is always reachable.
- **Small.** About 900 lines of Swift, no dependencies, MIT licensed.

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

A quick tap switches straight to the previous window without drawing the panel. The trigger key can be changed to ⌃ Control from the menu bar icon.

## Build and install

Requires macOS 13 or later and the Xcode Command Line Tools (`xcode-select --install`).

```bash
./scripts/build-app.sh
```

```bash
cp -R dist/Switchyard.app /Applications/ && open /Applications/Switchyard.app
```

## Permissions

- **Accessibility** (required): reads the window list and listens for the hotkey. Switchyard starts working the moment you grant it, no relaunch needed.
- **Screen Recording** (optional): window previews. Without it you get app icons.

Ad-hoc signed builds lose their Accessibility grant on every rebuild, because macOS ties the grant to the binary's signature. To avoid re-granting, sign with a stable certificate: `SIGN_IDENTITY="Your Certificate Name" ./scripts/build-app.sh`.

## Known limits

- ⌘Tab is not replaceable yet. macOS reserves it for the Dock, so the trigger is ⌥ or ⌃.
- Tabs of a window on another Space can show up as separate entries.
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
