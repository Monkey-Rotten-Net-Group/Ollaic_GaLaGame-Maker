# Ollaic iOS

Independent SwiftUI application for iPhone and iPad, targeting iOS 17 or later.
Open `Ollaic.xcodeproj` directly in Xcode; no project generator or third-party
Swift packages are required.

## Requirements

- macOS and Xcode 15 or later, with first-launch setup completed.
- iOS platform support, including the iOS Simulator SDK.
- To run the app: an iOS 17+ Simulator runtime installed in Xcode settings.

Install a runtime supporting a regular iPhone in Xcode > Settings > Components.
Under Other Installed Platforms, choose Add Platforms to select a specific OS
version. For Xcode 27 on an Apple Silicon Mac, install iOS 27.0 explicitly:

```sh
xcodebuild -downloadPlatform iOS -buildVersion 27.0 -architectureVariant arm64
```

The iOS 27.1 runtime currently provided for this setup supports only iPhone Duo.
Omitting `-buildVersion` may download it as well as other available versions.

Simulator builds do not require a development team or paid developer membership.
For a physical device, choose your team in the target's Signing & Capabilities
settings and use a bundle identifier available to that team.

## Development

From the repository root:

```sh
pnpm ios:open
pnpm ios:build
pnpm ios:dev
```

`ios:open` opens the checked-in project in Xcode. Select the `Ollaic` scheme and
an iPhone or iPad simulator, then click Run.

`ios:build` produces an unsigned Debug simulator app at
`ios/.build/Build/Products/Debug-iphonesimulator/Ollaic.app`.

`ios:dev` reuses a booted regular iPhone or selects and boots an available regular
iPhone. If none exists, it creates one using the newest installed runtime that
supports a regular iPhone. Duo-only runtimes are skipped for default selection.
It then builds, installs, and launches the app, restarting it if it is already
running. Runtime downloads remain a separate setup step.

The helper opens the Simulator app bundled with the selected Xcode, or DeviceHub
on Xcode 27 and later. DeviceHub is focused on the selected simulator.

To select a particular existing simulator, including an iPad or iPhone Duo, set
`IOS_SIMULATOR_UDID`:

```sh
xcrun simctl list devices available
IOS_SIMULATOR_UDID=YOUR_SIMULATOR_UDID pnpm ios:dev
```

Set `IOS_DERIVED_DATA_PATH` to an absolute path to change the build output directory.
The shell commands can also be run directly without pnpm:

```sh
bash scripts/ios-native.sh build
```

The `dev` helper parses the simulator inventory with macOS's built-in Ruby.

## Runtime Management

A runtime is the shared operating-system image. A simulator device is a particular
model with its own installed apps and data. Several devices can share one runtime.

- Install or remove OS versions in Xcode > Settings > Components. Use Add Platforms
  to install another version, or the information button beside an installed version
  to remove it.
- Create, start, shut down, or delete devices in DeviceHub on Xcode 27. Removing a
  device does not remove its runtime.
- Removing a runtime makes devices using that OS version unavailable until the
  runtime is installed again.

Inspect installed versions, runtime image identifiers, and available devices:

```sh
xcrun simctl list runtimes
xcrun simctl runtime list
xcrun simctl list devices available
```

See Apple's [Xcode component management documentation](https://developer.apple.com/documentation/xcode/downloading-and-installing-additional-xcode-components).

## Initial Scope

This is an application skeleton with a native navigation stack, an empty project
library, system light/dark appearance, English and Simplified Chinese strings,
and the same accent colors as the native Android application. The app icon catalog
is a placeholder for the final product artwork.

Project creation, storage, the editor, and Rust bindings are not connected yet.
The shared Rust core and Swift/Kotlin bindings are a future integration step.
This target does not build React, Tauri, Rust, or the matting model.
