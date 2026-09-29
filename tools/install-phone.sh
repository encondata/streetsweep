#!/usr/bin/env bash
# Installs StreetSweep on a plugged-in phone so Android Auto keeps listing it.
#
# Android Auto shows apps the Play Store installed and nothing else, unless its
# Developer settings -> Unknown sources is on; its own updates switch that off again,
# which is why the car screen worked straight after setting it up and then vanished.
# Installed from here with the Play Store recorded as installer, it is listed like any
# other app and the Unknown sources setting stops mattering. Data on the phone is kept.
#
#   ./tools/install-phone.sh                  # the latest local build
#   ./tools/install-phone.sh path/to/app.apk  # a particular APK
#   ./tools/install-phone.sh --release        # the latest GitHub release
set -euo pipefail
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
PKG=com.example.streetsweep
REPO=encondata/streetsweep

# The phone: ANDROID_SERIAL if set, otherwise the first device that is not an emulator.
D="${ANDROID_SERIAL:-$(adb devices | sed 1d | awk '$2=="device" && $1 !~ /^emulator-/ {print $1; exit}')}"
[ -n "$D" ] || { echo "No phone. Plug it in (and allow USB debugging), or pair wireless debugging."; exit 1; }

if [ "${1:-}" = "--release" ]; then
  TMP="$(mktemp -d)"
  if command -v gh >/dev/null 2>&1; then
    gh release download -R "$REPO" -p '*.apk' -D "$TMP"
  else
    URL="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -n 's/.*"browser_download_url": *"\([^"]*\.apk\)".*/\1/p' | head -1)"
    curl -fsSL -o "$TMP/app.apk" "$URL"
  fi
  APK="$(ls "$TMP"/*.apk | head -1)"
elif [ -n "${1:-}" ]; then
  APK="$1"
else
  APK="$HOME/Library/Caches/StreetSweep-build/app/outputs/apk/debug/app-debug.apk"
fi
[ -f "$APK" ] || { echo "No APK at $APK. Build one first, or pass a path, or --release."; exit 1; }

echo "Installing $(basename "$APK") on $(adb -s "$D" shell getprop ro.product.model | tr -d '\r')…"
adb -s "$D" install -r -i com.android.vending "$APK"

INSTALLER="$(adb -s "$D" shell dumpsys package $PKG | sed -n 's/.*installerPackageName=//p' | head -1 | tr -d '\r')"
VERSION="$(adb -s "$D" shell dumpsys package $PKG | sed -n 's/.*versionName=//p' | head -1 | tr -d '\r')"
echo
echo "  StreetSweep $VERSION, installer: $INSTALLER"
if [ "$INSTALLER" = "com.android.vending" ]; then
  echo "  Android Auto will list it without Unknown sources. Its app list is rebuilt the"
  echo "  next time the car connects, so unplug and reconnect (or restart the car) once."
else
  echo "  The phone did not record the Play Store as installer, so Android Auto still needs"
  echo "  Developer settings -> Unknown sources turned on."
fi
