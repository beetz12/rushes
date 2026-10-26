# Mac App Store feasibility spike

The native recorder can run as an inherited child inside an enforced Apple App
Sandbox in the local ad-hoc diagnostic. This is an encouraging architectural
result, not acceptance of the Electron MAS application or physical capture.
The current direct-download app is unchanged.

## Reproduce the bounded experiment

Use macOS with the repository's supported Xcode/Swift toolchain and native build.
The source gate provisions each package's pinned Node runtime before its tests.

```sh
bash scripts/check-mac-web.sh
python3 scripts/mas-spike/run.py --output /absolute/durable/evidence
python3 verification/mas-spike/verify.py /absolute/durable/evidence/receipt.json
```

The complete union gate is `python3 scripts/mas-spike/check.py`. Its optional
`--output` selects a durable log directory; otherwise the default is a retained
`.build/mas-spike-gate-*.noindex` directory. Failed tool output is preserved.
The diagnostic uses generated media exclusively and makes no provider requests,
changes to installed Rushes, permission prompts, Keychain changes or purchases.

Each run compiles a small native parent, copies the unchanged built engine and
CLI into an owned `.noindex` bundle and signs only those copies. Signed loadable
Mach-O sections must match the original built helper sections. An exclusive
diagnostic lock prevents two runs from sharing the probe's container at once.
Each run uses a fresh nonce for recordings, logs and socket. No user originals
are read or moved. Generated diagnostic data remain available for inspection.

## Observed native boundary, October 25, 2026

The actual local experiment observed:

| Check | Measured result | Limit |
|---|---|---|
| Runtime entitlement | `SecTaskCopyValueForEntitlement` reports App Sandbox; signed parent/child entitlements independently read back. | Native ad-hoc parent only. |
| Filesystem enforcement | The same owned home-directory target is writable by the unsandboxed control and denied with POSIX EPERM by the sandboxed parent. Container write succeeds. | Does not prove Powerbox or bookmark grants. |
| Inherited helper | The unchanged sandbox/inherit-signed native engine and CLI exchange real ping/status/record/verify/export requests inside the container. An outside-container SQLite index is refused. | Generated capture does not require physical permission. |
| Saved tracks | Two three-second generated takes finalize separate screen, camera, microphone and system-audio MOV files. | Generated video and silence, not physical device identity or lip-sync. |
| Export | Combined MP4 and four separate originals decode through the independent every-sample AVFoundation probe. Pre-export, post-export and copied-original SHA256 values agree. | Exports are inside the container. |
| Restart and Quit | The next helper sees the prior take; both helpers exit 0 and remove their sockets. The external driver observes the owned POSIX session empty twice. | Product windows, App Intents and physical capture cleanup are separate checks. |

The receipt verifier reopens actual source, signed payload, manifests, original
media and exported bytes. Raw independent decoder command arguments must name
the correct originals plus combined output. Actual process/session and socket
absence are checked again. Tests intentionally falsify acceptance, entitlement,
cleanup, restart, decode extent and original/source hash observations and require
rejection. A failed parent cannot bypass external descendant/socket cleanup.

Every native result remains separate from `electronMASAccepted`,
`provisionedMASAccepted`, `physicalCaptureAccepted` and `appStoreReady`; this
native-only diagnostic requires all four to remain false. Local certificate and
profile inventories are retained only in private evidence, not this source.
The current host inventory contains no applicable Rushes macOS profile in the
two standard local profile directories. This is a scoped local observation,
not a query of Apple account membership or remote certificates.

## Full MAS application: not yet exercised

The desktop pins Electron 44.7.0 in [shell/package.json](../../shell/package.json).
The current targets are DMG/ZIP and its current entitlement file does not enable
App Sandbox. A standard Electron binary is not interchangeable with the MAS
binary. The diagnostic deliberately does not launch a full Electron MAS shell.
It does not create an app identifier/profile, use another company's signing
team, enroll an account or fetch a distribution credential.

Next proof requires the dedicated MAS Electron flavor/configuration, an
applicable development provisioning profile for the chosen Rushes identifier,
the owner's authorized signing setup, and execution of the actual packaged
shell. It must cover screen, window, area, camera, microphone, system audio,
preview, user-selected export, restart and Quit. Native ad-hoc results do not
transfer to those unrun cases or establish App Review approval.

## Separate actual Electron MAS bootstrap experiment

A separate local experiment downloaded the official pinned Electron44.7.0
MAS-arm64 archive and matched its published SHA256
`a9bfda0de8836d8a1db337d8f11b7c3baee800d9c144ae429d8cb6a169023ae7`.
It used an isolated ad-hoc sandboxed test bundle, without a provisioning profile
or registered application group. It did not launch the full Rushes application
or ask for device permissions.

The runtime emitted `mas:true` and version44.7.0, then exited on signal5 before
`app.whenReady()`. The actual failure was a MachPortRendezvousServer
`bootstrap_check_in` permission denial1100. The external driver confirmed the
owned session retired. This proves the actual MAS binary was attempted; it
does not establish compatibility of a properly provisioned configuration or a
recording failure in the native engine.

The supported next attempt must use the owner's legitimate application-group,
ElectronTeamID and provisioning/signing configuration from the Electron MAS
guide. Do not work around this denial with a temporary sandbox exception or
call this incomplete ad-hoc bootstrap a passing full-MAS test. The native-only
receipt's `electronMASAccepted:false` remains correct.

## Source-grounded changes before Store qualification

| Surface | Current source | Required follow-up |
|---|---|---|
| Storage and migration | `shell/src/main/index.ts:87-105` constructs home-relative state and `Movies/Rushes` library paths. The native helper accepts explicit index/recording/socket paths. | Choose intentional container storage, keep old originals untouched, and offer explicit import/folder authorization. Test old-library and credential reconnect behavior. |
| Socket length | `Sources/RushCore/Control/ControlServer.swift:358` requires `path.count < 104`. The normal bundle container path on the measured short username is 100 ASCII bytes. | A longer username/bundle identifier can exceed this bound. Use a short private path inside the container and test byte limits. The spike uses a short per-run container socket; the product is not repaired by that choice. |
| User-selected export | `shell/src/main/index.ts:1425-1464` selects an export path and passes it to an already-running engine; scoped-bookmark handling is absent from that inspected flow. | Prove user grants survive helper handoff and restart. Inherited static rights do not automatically grant post-launch Powerbox extensions. Prefer rendering inside the container and copying through the parent-held user grant, or a supported explicit bookmark handoff with tests. |
| Helper signing | `shell/src/main/engine.ts:366-379` launches the bundled executable; current packaging applies the direct-download entitlement file to binaries. | Separate MAS parent and inherit-only child entitlements, app identity/group configuration and code signing. Test the actual MAS bundle, not only the small native parent. |
| Updater | `shell/src/main/updater.ts` implements the direct-download updater. | MAS uses Apple-managed updates; prevent the Store edition from initializing the direct-download update path. Retain the optional direct edition separately. |
| Automation/hotkeys | `shell/src/main/index.ts:1790-1806` registers global shortcuts. `scripts/app-intents/README.md` currently describes a helper deliberately packaged without App Sandbox. | Qualify or explicitly omit unsupported Store controls. Test actual sandbox/provisioned helpers and permissions rather than carrying over direct-download results. |
| Quit and capture | `shell/src/main/index.ts:2097-2120` coordinates before-quit cleanup; the production rig uses ScreenCaptureKit and AVCaptureSession. | Exercise actual previews/capture cancellation, recording finalization, windows and helper shutdown in the provisioned MAS shell. Preserve originals when a stop or permission check fails. |

Sources: [Electron MAS submission guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide),
[Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox),
[Apple sandbox entitlement/inheritance guide](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/EnablingAppSandbox.html).

Decision: continue with a dedicated MAS build and the listed file-access and
distribution changes. The native helper does not currently require a rewrite
based on the measured sandbox mechanics. Paid cloud, StoreKit, Apple sign-in,
account deletion and TestFlight remain subsequent independent production gates.
Shared source/CI stay public, backend remains private, and this spike consumes
no private Actions credits.
