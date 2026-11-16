#!/bin/bash
# Builds dist/Switchyard.app. Needs only the Xcode Command Line Tools.
#   SIGN_IDENTITY="My Cert" ./scripts/build-app.sh   # sign with a stable identity
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-0.1.0}"
APP="dist/Switchyard.app"

swift build -c release
BIN="$(swift build -c release --show-bin-path)/Switchyard"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP/Contents/MacOS/Switchyard"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Switchyard</string>
    <key>CFBundleDisplayName</key><string>Switchyard</string>
    <key>CFBundleIdentifier</key><string>dev.switchyard.Switchyard</string>
    <key>CFBundleExecutable</key><string>Switchyard</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>${VERSION}</string>
    <key>CFBundleVersion</key><string>${VERSION}</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# "-" is an ad-hoc signature: fine for local use, but macOS forgets the
# Accessibility grant after every rebuild. A real identity avoids that.
codesign --force --sign "${SIGN_IDENTITY:--}" "$APP"
echo "Built $APP"
