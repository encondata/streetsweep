#!/usr/bin/env bash
# Why Android Auto is or is not showing StreetSweep's car screen.
#
# Run this on the Mac with the phone plugged in. Straight after a drive is best:
# the log buffer holds a while, but it does roll.
#
#   ./tools/car-log.sh              # what the phone still remembers
#   ./tools/car-log.sh --watch      # follow live, for wireless debugging in the car
set -uo pipefail
export PATH="$HOME/Library/Android/sdk/platform-tools:$PATH"
D="${ANDROID_SERIAL:-$(adb devices | sed 1d | awk 'NF{print $1; exit}')}"
[ -z "$D" ] && { echo "No phone. Plug it in, or pair wireless debugging."; exit 1; }
PKG=com.example.streetsweep

echo "== is the app there, and where did it come from? =="
adb -s "$D" shell dumpsys package $PKG | grep -E "versionName|installerPackageName|pkgFlags" | sed 's/^/  /'

echo
echo "== does the phone answer Android Auto's own lookup with us? =="
adb -s "$D" shell "pm query-services -a androidx.car.app.CarAppService -c androidx.car.app.category.NAVIGATION" \
  | grep -E "^      name=" | sed 's/^      /  /'

echo
echo "== what Android Auto said about it =="
FILTER='gearhead|CarApp|projection|carapp|Unknown source|unknown_source|allowlist|whitelist|streetsweep'
if [ "${1:-}" = "--watch" ]; then
  echo "  (following — connect the car now, Ctrl-C when done)"
  adb -s "$D" logcat -b all -v time | grep -iE "$FILTER"
else
  adb -s "$D" logcat -d -b all -v time | grep -iE "$FILTER" | tail -60
  echo
  echo "  Nothing above mentioning streetsweep means Android Auto never considered it."
  echo "  That is the Unknown sources setting, not the app."
fi
