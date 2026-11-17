#!/bin/bash
# sign.sh — turn repack.py's output into something an iPhone will install.
# macOS only (needs the Apple toolchain). Run on any runner with Xcode CLT.
#
#   ./sign.sh bs757-hud.ipa "iPhone Developer: A B (XXXXXXXXXX)" 1234567890
#
# Team ID comes from `security find-identity -v -p codesigning`.

set -euo pipefail

IPA="${1:?usage: sign.sh <ipa> <signing-identity> [team-id]}"
IDENTITY="${2:?signing identity required}"
TEAM="${3:-}"
OUT="${IPA%.ipa}-signed.ipa"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v codesign >/dev/null || { echo "codesign missing — install Xcode command line tools" >&2; exit 1; }
[ -f "$IPA" ] || { echo "no such ipa: $IPA" >&2; exit 1; }

echo "== unpack"
unzip -q "$IPA" -d "$WORK"
APP="$(find "$WORK/Payload" -maxdepth 1 -name '*.app' | head -1)"
[ -n "$APP" ] || { echo "no .app in Payload" >&2; exit 1; }

BUNDLE_ID=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP/Info.plist")
echo "   $APP"
echo "   bundle: $BUNDLE_ID"

if [ -z "$TEAM" ]; then
  TEAM=$(security find-identity -v -p codesigning \
    | grep -F "$IDENTITY" | sed -n 's/.*"\(.*\)"/\1/p' \
    | sed -n 's/.*(\([A-Z0-9]\{10\}\))$/\1/p' | head -1)
fi
[ -n "$TEAM" ] || { echo "could not infer team id — pass it as arg 3" >&2; exit 1; }
echo "   team:   $TEAM"

cat > "$WORK/ent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>application-identifier</key>
    <string>$TEAM.$BUNDLE_ID</string>
    <key>com.apple.developer.team-identifier</key>
    <string>$TEAM</string>
    <key>get-task-allow</key>
    <true/>
    <key>keychain-access-groups</key>
    <array>
        <string>$TEAM.$BUNDLE_ID</string>
    </array>
</dict>
</plist>
EOF

echo "== sign nested code"
# frameworks first, deepest path first — codesign verifies inner-out
find "$APP/Frameworks" -name '*.framework' -type d 2>/dev/null | sort -r | while read -r fw; do
  bin="$fw/$(basename "$fw" .framework)"
  [ -f "$bin" ] || continue
  codesign -f -s "$IDENTITY" --timestamp=none "$fw" >/dev/null 2>&1 \
    && echo "   ok  $(basename "$fw")" \
    || echo "   skip $(basename "$fw") (nested app extension?)"
done

find "$APP/Frameworks" -name '*.dylib' -type f 2>/dev/null | while read -r d; do
  codesign -f -s "$IDENTITY" --timestamp=none "$d" >/dev/null && echo "   ok  $(basename "$d")"
done

echo "== sign app"
codesign -f -s "$IDENTITY" \
  --entitlements "$WORK/ent.plist" \
  --timestamp=none \
  --generate-entitlement-der \
  "$APP"
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -3

echo "== repack"
rm -rf "$APP/_CodeSignature" 2>/dev/null || true
( cd "$WORK" && zip -qry "$OLDPWD/$OUT" Payload )
echo "out: $OUT  ($(du -h "$OUT" | cut -f1))"
echo "install: xcrun devicectl device install app --device <udid> \"$APP\"  (or the IPA via Apple Configurator)"
