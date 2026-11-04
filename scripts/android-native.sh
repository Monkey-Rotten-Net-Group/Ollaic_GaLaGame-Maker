#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
android_project_dir="$project_root/apps/android"
mode="${1:-build}"

if [[ "$mode" == "open" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    exec open -a "Android Studio" "$android_project_dir"
  fi
  exec studio "$android_project_dir"
fi

if [[ -z "${JAVA_HOME:-}" && -x /usr/libexec/java_home ]]; then
  JAVA_HOME="$(/usr/libexec/java_home -v 21)"
  export JAVA_HOME
fi
if [[ -z "${ANDROID_HOME:-}" && -d "$HOME/Library/Android/sdk" ]]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi

case "$mode" in
  build|dev|test|unit-test|bindings-test|ui-test|preview-test) ;;
  *) printf 'Unknown Android command: %s\n' "$mode" >&2; exit 2 ;;
esac
if [[ "$mode" == "preview-test" && -z "${WEBGAL_TEST_RUNTIME_ZIP:-}" ]]; then
  printf 'Set WEBGAL_TEST_RUNTIME_ZIP to the pinned WebGAL web ZIP for real-engine tests.\n' >&2
  exit 2
fi
if [[ -n "${WEBGAL_TEST_RUNTIME_ZIP:-}" && ! -f "$WEBGAL_TEST_RUNTIME_ZIP" ]]; then
  printf 'WebGAL test ZIP does not exist: %s\n' "$WEBGAL_TEST_RUNTIME_ZIP" >&2
  exit 2
fi

tasks=(:app:assembleDebug)
case "$mode" in
  unit-test) tasks=(:app:testDebugUnitTest) ;;
  test) tasks+=(:app:assembleDebugAndroidTest :app:testDebugUnitTest) ;;
  bindings-test|ui-test|preview-test) tasks+=(:app:assembleDebugAndroidTest) ;;
esac
"$android_project_dir/gradlew" -p "$android_project_dir" "${tasks[@]}"

if [[ "$mode" == "dev" || "$mode" == "test" || "$mode" == "bindings-test" || "$mode" == "ui-test" || "$mode" == "preview-test" ]]; then
  adb_command="${ANDROID_HOME:-}/platform-tools/adb"
  if [[ ! -x "$adb_command" ]]; then adb_command="$(command -v adb)"; fi
  device="${ANDROID_SERIAL:-}"
  if [[ -z "$device" ]]; then
    device="$("$adb_command" devices | awk '$1 ~ /^emulator-/ && $2 == "device" {print $1; exit}')"
  fi
  if [[ -z "$device" ]]; then
    printf 'Start an Android emulator in Android Studio, then rerun this command.\n' >&2
    exit 1
  fi
  "$adb_command" -s "$device" install -r "$android_project_dir/app/build/outputs/apk/debug/app-debug.apk"
  if [[ "$mode" != "dev" ]]; then
    "$adb_command" -s "$device" install -r "$android_project_dir/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
    filters=()
    runtime_args=()
    original_ime_setting=""
    runtime_fixture=""
    cleanup_tests() {
      if [[ -n "$original_ime_setting" ]]; then
        if [[ "$original_ime_setting" == "null" ]]; then
          "$adb_command" -s "$device" shell settings delete secure show_ime_with_hard_keyboard >/dev/null 2>&1 || true
        else
          "$adb_command" -s "$device" shell settings put secure show_ime_with_hard_keyboard "$original_ime_setting" >/dev/null 2>&1 || true
        fi
      fi
      if [[ -n "$runtime_fixture" ]]; then
        "$adb_command" -s "$device" shell rm -f "$runtime_fixture" >/dev/null 2>&1 || true
      fi
    }
    trap cleanup_tests EXIT
    if [[ "$mode" == "test" || "$mode" == "ui-test" ]]; then
      original_ime_setting="$("$adb_command" -s "$device" shell settings get secure show_ime_with_hard_keyboard | tr -d '\r')"
      "$adb_command" -s "$device" shell settings put secure show_ime_with_hard_keyboard 1
    fi
    if [[ -n "${WEBGAL_TEST_RUNTIME_ZIP:-}" ]]; then
      runtime_fixture=/data/local/tmp/ollaic-preview-runtime.zip
      "$adb_command" -s "$device" push "$WEBGAL_TEST_RUNTIME_ZIP" "$runtime_fixture"
      runtime_args=(-e previewRuntimeArchive true)
    fi
    case "$mode" in
      bindings-test) filters=(-e package com.ollaic.galagame_maker.core,com.ollaic.galagame_maker.workspace) ;;
      ui-test) filters=(-e package com.ollaic.galagame_maker.ui) ;;
      preview-test) filters=(-e package com.ollaic.galagame_maker.preview) ;;
    esac
    if [[ -n "${ANDROID_TEST_CLASS:-}" ]]; then filters=(-e class "$ANDROID_TEST_CLASS"); fi
    "$adb_command" -s "$device" shell cmd statusbar collapse >/dev/null 2>&1 || true
    if ! result="$("$adb_command" -s "$device" shell am instrument -w "${filters[@]}" "${runtime_args[@]}" com.ollaic.galagame_maker.test/androidx.test.runner.AndroidJUnitRunner 2>&1)"; then
      printf '%s\n' "$result" >&2
      exit 1
    fi
    printf '%s\n' "$result"
    if ! grep -Eq 'OK \([0-9]+ tests?\)' <<< "$result" || grep -Eq 'FAILURES|INSTRUMENTATION_FAILED|Process crashed' <<< "$result"; then
      exit 1
    fi
  else
    "$adb_command" -s "$device" shell am start -n com.ollaic.galagame_maker/.MainActivity
  fi
fi
