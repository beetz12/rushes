# Native App Intents for Rushes

Original implementation, 2026-10-11. Sources: Phase6/platform/clean-room plan sections, current Automation/RushURLRoute, current ControlClient/engine request parsing, Apple's installed macOS27 AppIntents and ExtensionFoundation interfaces, current Apple primary documentation and the SDK's macOS App Intents Extension template metadata. No reference clone source is used.

RushIntents defines Start Recording and Stop Recording AppIntent types, explicit source/camera/microphone selections and an AppShortcutsProvider. Camera and microphone default off. The extension has no capture code and never instantiates a recording engine. It sends the same record.start/record.stop requests as the CLI to the current user's private engine socket. Invalid combinations fail before any mutation. Stop returns the preserved package path. A closed app produces an actionable open-Rushes error; discovery does not launch the app or warm devices.

The Electron main executable cannot itself execute Swift intent types. The current integration candidate is a native main-process helper under Contents/Helpers/RushesAutomation.app; AppIntentsPackage makes the original library types available to its compiled metadata. An ExtensionKit candidate was also implemented and its observed execution/discovery constraint is retained below. Packaging extracts actual Swift compiler constants and runs appintentsmetadataprocessor, then checks generated action metadata and signs locally. Root owns final Electron embedding/signing. No remote profiles, app groups or security grants are requested.

Tests use a dedicated mode0600 socket beneath an owner0700 temporary folder and a stub ControlHandling implementation. QA binaries compile a fail-closed stub-only socket guard, plus a QA-only bundle identifier and explicit signed stub path; production binaries cannot use that override. No real screen, camera, microphone or audio capture is permitted in this lane. Compile, metadata extraction, plug-in registration, actual Shortcuts discovery and running a saved shortcut are separate evidence levels; only observed levels are reported. Existing user shortcuts are never modified or deleted.

Primary references:
- https://developer.apple.com/documentation/appintents/appintent
- https://developer.apple.com/documentation/appintents/appintentsextension
- https://developer.apple.com/documentation/appintents/appintentspackage
- https://developer.apple.com/documentation/appintents/appshortcut
- macOS27 SDK AppIntents.swiftinterface and Xcode App Intents Extension template

## CONSTRAINT — 2026-10-11, real system probe

Refuted configuration: hand-packaged native AppIntentsExtension under Contents/PlugIns; changing to Contents/Extensions, mirroring metadata into the containing app and declaring macOS27 extension execution target still produced action-not-found. The public ExtensionFoundation identity probe returned matchingRegisteredExtensions=0. The Shortcuts action catalog did show both original actions, but catalog appearance is not executable registration. No stub start request landed and no device capture occurred.

Opened installed SDK sources:
- /Applications/Xcode.app/Contents/SharedFrameworks/SwiftBuild.framework/Versions/A/PlugIns/SWBBuildService.bundle/Contents/Frameworks/SWBCore.framework/Versions/A/Resources/CoreBuildSystem.xcspec:3494 — BUNDLE_EXTENSIONS_FOLDER_PATH defaults to Contents/Extensions.
- /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/Library/Xcode/Templates/Project Templates/macOS/Base/macOS ExtensionKit Extension Base.xctemplate/TemplateInfo.plist:38 — ENABLE_APP_SANDBOX is YES for the supported ExtensionKit target.
- macOS27 AppIntents.swiftinterface:3097 and4585 — AppIntent/AppIntentsPackage can live in an app bundle; AppIntentsExtension is a separate supported execution target.

Do not retry the same failed extension shape or change system permissions/profiles/app groups. Verified supported alternative: an original Swift AppKit helper app embedded under Electron Contents/Helpers, linking the same AppIntentsPackage and running those intents in its own native main process. It uses the existing protected engine socket, initializes no capture engine, requires no extra entitlements and was verified against a compiler-enforced stub-only QA bundle. Final helper packaging and real-engine behavior still belong to root's signed Electron installation.

Main-process alternative runtime evidence, 2026-10-11: signed local helper metadata declares allowedTargets type1 (main), rather than extension type3. After the user provided an idle UI window, the separately identified com.nexai.rushes.intentqa helper actually launched through native UI. Owned saved Rushes QA Start and Rushes QA Stop executed using native actions on macOS27.0 (26A428), both through the Shortcuts UI and Apple shortcuts CLI. Start output was 01J00000000000000000000000; Stop output was /tmp/rushes-iqa/stub-recording. The dedicated owner700/mode600 stub log recorded record.start with camera/mic none, followed by record.stop, for both execution routes. Final stub state was idle. The current-user workflow database contains only our two QA identifiers plus the original13 other workflows. The signed QA override cannot select a real engine; no capture occurred. See scripts/app-intents/qa-proof.json. The previous Mac-locking interruption was resolved by the user; no locking or security setting was bypassed.

Production gate: embed and sign the helper under the final Electron bundle, start its background executable during normal app launch and verify actual saved Start/Stop workflows against the running real engine only in a root-authorized capture slot. The helper initializes no engine or device. Current proof covers real Shortcuts execution on macOS27 with a stub, not final production installation, real media capture or macOS26.4 compatibility. The broader repository gate previously failed in existing RushCore media tests; its failure remains visible and root owns the serialized merged-tree gate.
