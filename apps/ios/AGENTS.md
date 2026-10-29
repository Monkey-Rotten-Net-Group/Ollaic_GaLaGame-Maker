# Native iOS development

The app currently supports one independent window scene. Keep
`UIApplicationSupportsMultipleScenes` false in both Debug and Release builds.

Read [native mobile validation](../../docs/mobile/validation.md) before choosing checks.
The agent owns non-interactive validation; the user owns UI clicking and visual acceptance.
Keep the default `Ollaic` scheme and `ios:test` command free of automated UI journeys.
The separate `OllaicUI` scheme is opt-in, not part of routine agent verification.
Respect the existing `IOS_SIMULATOR_UDID` or repository-local `ollaic.iosSimulatorUDID`
preference. Do not override it with a model-specific device unless the user requests one.
