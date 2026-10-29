#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ios_project_dir="$project_root/apps/ios"
mode="${1:-build}"
project="$ios_project_dir/Ollaic.xcodeproj"
scheme=Ollaic
if [[ "$mode" == "ui-test" ]]; then scheme=OllaicUI; fi
derived_data="${IOS_DERIVED_DATA_PATH:-$ios_project_dir/.build}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  printf 'Native iOS development requires macOS and Xcode.\n' >&2
  exit 1
fi

case "$mode" in
  open) exec open -a Xcode "$project" ;;
  build|dev|test|unit-test|ui-test|preview-test) ;;
  *) printf 'Unknown iOS command: %s\n' "$mode" >&2; exit 2 ;;
esac

destination="generic/platform=iOS Simulator"
if [[ "$mode" == "preview-test" && ( -z "${WEBGAL_TEST_RUNTIME_ZIP:-}" || ! -f "$WEBGAL_TEST_RUNTIME_ZIP" ) ]]; then
  printf 'Set WEBGAL_TEST_RUNTIME_ZIP to the pinned WebGAL web ZIP before preview-test.\n' >&2
  exit 2
fi
if [[ "$derived_data" != /* ]]; then
  printf 'IOS_DERIVED_DATA_PATH must be absolute.\n' >&2
  exit 2
fi
if [[ "$mode" != "build" ]]; then
  device="${IOS_SIMULATOR_UDID:-$(git -C "$project_root" config --local --get ollaic.iosSimulatorUDID 2>/dev/null || true)}"
  if [[ -z "${IOS_SIMULATOR_UDID:-}" && ( "$mode" == "dev" || -z "$device" ) ]]; then
    device="$(xcrun simctl list --json | /usr/bin/ruby -rjson -ropen3 -e '
      mode, preferred_udid = ARGV
      inventory = JSON.parse(STDIN.read)
      runtimes = inventory.fetch("runtimes").select do |runtime|
        runtime["isAvailable"] && runtime.fetch("identifier").include?(".iOS-") &&
          runtime.fetch("version").split(".").first.to_i >= 17
      end.sort_by { |runtime| runtime.fetch("version").split(".").map(&:to_i) }.reverse
      type_by_identifier = inventory.fetch("devicetypes").each_with_object({}) do |entry, index|
        index[entry.fetch("identifier")] = entry
      end
      regular_iphone_type = lambda do |entry|
        entry && entry["productFamily"] == "iPhone" && !entry.fetch("name").include?("Duo")
      end
      devices = runtimes.flat_map do |runtime|
        inventory.fetch("devices").fetch(runtime.fetch("identifier"), [])
      end.select { |entry| entry["isAvailable"] }
      if mode == "dev"
        booted = devices.select do |entry|
          type = type_by_identifier[entry["deviceTypeIdentifier"]]
          entry["state"] == "Booted" && type && ["iPhone", "iPad"].include?(type["productFamily"])
        end
        device = booted.find { |entry| entry["udid"] == preferred_udid } || booted.first
      end
      if !device && !preferred_udid.empty?
        warn "Using configured iOS simulator: #{preferred_udid}"
        puts preferred_udid
        exit
      end
      regular_iphones = devices.select do |entry|
        regular_iphone_type.call(type_by_identifier[entry["deviceTypeIdentifier"]])
      end
      device ||= regular_iphones.find { |entry| entry["state"] == "Booted" } || regular_iphones.first
      if device
        warn "Using iOS simulator: #{device.fetch("name")}"
        puts device.fetch("udid")
        exit
      end
      if runtimes.empty?
        abort "No iOS 17+ Simulator runtime is installed. Install one supporting a regular iPhone in Xcode > Settings > Components."
      end

      selection = runtimes.lazy.map do |candidate_runtime|
        version = candidate_runtime.fetch("version").split(".").map(&:to_i)
        version_number = (version.fetch(0) << 16) | (version.fetch(1, 0) << 8) | version.fetch(2, 0)
        device_types = candidate_runtime["supportedDeviceTypes"] || inventory.fetch("devicetypes")
        candidate_type = device_types.find do |entry|
          regular_iphone_type.call(entry) &&
            entry.fetch("minRuntimeVersion", 0) <= version_number &&
            entry.fetch("maxRuntimeVersion", 4294967295) >= version_number
        end
        [candidate_runtime, candidate_type] if candidate_type
      end.find { |entry| entry }
      unless selection
        abort "No installed runtime supports a regular iPhone. Install one in Xcode > Settings > Components. Use IOS_SIMULATOR_UDID to explicitly select another device."
      end

      runtime, device_type = selection
      simulator_name = "Ollaic #{device_type.fetch("name")}"
      warn "Creating #{simulator_name} with #{runtime.fetch("name")}."
      udid, status = Open3.capture2("xcrun", "simctl", "create", simulator_name,
        device_type.fetch("identifier"), runtime.fetch("identifier"))
      abort "Failed to create the iOS simulator." unless status.success?
      puts udid.strip
    ' "$mode" "$device")"
  fi
  xcrun simctl bootstatus "$device" -b
  if [[ "$mode" == "dev" || "$mode" == "ui-test" ]]; then
    developer_dir="$(xcode-select -p)"
    simulator_app="$developer_dir/Applications/Simulator.app"
    device_hub_app="$developer_dir/../Applications/DeviceHub.app"
    if [[ -d "$simulator_app" ]]; then
      open -a "$simulator_app" --args -CurrentDeviceUDID "$device"
    elif [[ -d "$device_hub_app" ]]; then
      open -a "$device_hub_app" "devices://device/open?id=$device"
    else
      printf 'No simulator UI was found in the selected Xcode. Complete platform setup in Xcode.\n' >&2
      exit 1
    fi
  fi
  destination="platform=iOS Simulator,id=$device"
fi

build_arguments=(
  -quiet
  -project "$project"
  -scheme "$scheme"
  -configuration Debug
  -destination "$destination"
  -derivedDataPath "$derived_data"
  CODE_SIGNING_ALLOWED=NO
)
test_arguments=(-parallel-testing-enabled NO -collect-test-diagnostics never)
case "$mode" in
  test|unit-test) test_arguments+=(-only-testing:OllaicTests) ;;
  ui-test) test_arguments+=(-only-testing:OllaicUITests) ;;
  preview-test) test_arguments+=(-only-testing:OllaicTests/NativePreviewTests) ;;
esac
if [[ "$mode" == "build" || "$mode" == "dev" ]]; then
  xcodebuild "${build_arguments[@]}" build
else
  fixture="$derived_data/Build/Products/Debug-iphonesimulator/Ollaic.app/WebGALTestEngine.zip"
  trap 'rm -f "$fixture"' EXIT
  rm -f "$fixture"
  xcodebuild "${build_arguments[@]}" "${test_arguments[@]}" build-for-testing
  if [[ -n "${WEBGAL_TEST_RUNTIME_ZIP:-}" ]]; then
    if [[ ! -f "$WEBGAL_TEST_RUNTIME_ZIP" ]]; then printf 'Runtime test ZIP does not exist.\n' >&2; exit 2; fi
    cp "$WEBGAL_TEST_RUNTIME_ZIP" "$fixture"
  fi
  xcodebuild "${build_arguments[@]}" "${test_arguments[@]}" test-without-building
fi

if [[ "$mode" == "dev" ]]; then
  xcrun simctl install "$device" "$derived_data/Build/Products/Debug-iphonesimulator/Ollaic.app"
  xcrun simctl launch --terminate-running-process "$device" com.ollaic.galagame-maker
fi
