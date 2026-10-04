#!/usr/bin/env bash
# Drives the Android app on the emulator with adb input only — no instrumentation in the app, so
# what is exercised is the shipped build. Each step screenshots the real screen.
#
#   bash .agents/evidence/harness/android-drive.sh <outPrefix>
set -u
PREFIX="${1:-/c/np-prove/evidence/40-android}"
PKG=com.nowplaying.player

shot() { adb exec-out screencap -p > "${PREFIX}-$1.png"; echo "saved ${PREFIX}-$1.png"; }
tap() { adb shell input tap "$1" "$2"; sleep "${3:-2}"; }
swipe() { adb shell input swipe "$1" "$2" "$3" "$4" "${5:-300}"; sleep "${6:-2}"; }
back() { adb shell input keyevent 4; sleep 1.5; }

adb shell am start -n "$PKG/.MainActivity" > /dev/null 2>&1
sleep 10
echo "screen size: $(adb shell wm size | tr -d '\r')"

# The content tabs sit under the player, roughly y=1290 on a 1080x2400 screen.
echo "--- tap Radio tab"
tap 424 1290 4
shot radio

echo "--- open the first station in Radio"
tap 540 1500 5
shot radio-playing

echo "--- back out"
back
echo "--- tap Live TV tab"
tap 654 1290 5
shot livetv

echo "--- logcat: crashes and WebView errors since launch"
adb logcat -d 2>&1 | grep -iE "FATAL|AndroidRuntime|Uncaught|SecurityException|net::ERR|ERR_ACCESS|chromium.*CONSOLE.*(Error|error)" | grep -v AppsFilter | tail -20
echo "(end)"