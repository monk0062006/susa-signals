#!/usr/bin/env bash
# Runs the instrumented suite on a connected device and reports the result.
#
# Gradle's connectedAndroidTest currently runs the tests correctly but fails to
# retrieve their results ("Failed to receive the UTP test results"), reporting a
# green run as a build failure with an empty report. The flag that used to
# disable UTP is deprecated in AGP 8.7 and no longer takes effect.
#
# Driving the instrumentation runner directly sidesteps the broken transport and
# prints an authoritative pass/fail.
set -euo pipefail

SERIAL="${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')}"
[ -n "$SERIAL" ] || { echo "no device connected"; exit 1; }

cd "$(dirname "$0")"
./gradlew :feedback:assembleDebug :feedback:assembleDebugAndroidTest --no-daemon -q

adb -s "$SERIAL" install -r -t feedback/build/outputs/apk/debug/feedback-debug.apk >/dev/null 2>&1 || true
adb -s "$SERIAL" install -r -t feedback/build/outputs/apk/androidTest/debug/feedback-debug-androidTest.apk >/dev/null

# Lets the end-to-end analytics test reach an ingest service on this machine.
adb -s "$SERIAL" reverse tcp:4000 tcp:4000 >/dev/null 2>&1 || true

adb -s "$SERIAL" shell am instrument -w \
  io.markerusa.feedback.test/androidx.test.runner.AndroidJUnitRunner
