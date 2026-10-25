# Installed signed update acceptance

`verification/installed-update.mjs` has two explicit modes. Neither mode touches `/Applications/Rushes.app` or David's recordings/settings.

```sh
node verification/installed-update.mjs --exercise --evidence-root /Users/rushes-qa-abc/RushesAcceptance.noindex/release
node verification/installed-update.mjs --recheck --evidence-root /Users/rushes-qa-abc/RushesAcceptance.noindex/release
```

Use actual Node22.22.0 and the repository's installed dependencies. The source gate includes `node --test verification/update-acceptance/*.test.mjs`. Generated tests never qualify a real installer, signature, provider, capture or transition.

## Explicit exercise and read-only recheck

`--exercise` is consequential: it runs the declared source gate and release build, mounts the selected quarantined DMGs read-only, extracts the selected ZIPs, verifies all selected signed app executables, installs into new owned `.noindex` case directories, drives the actual packaged app updater, and exercises a brief real screen/window busy recording. It requires root's separate GUI/physical/media-lane coordination and reviewed artifact/feed/account authority. There is no default action, ASAR patch, signature bypass, TLS bypass, mocked production updater, profile override or implicit publication.

The four observed cases are corrupt download, interrupted download, capture-busy restart refusal and successful N-to-N+1. Refusal cases require the actual updater to enter downloading and then error, or to refuse an already downloaded update while real capture remains active. Every case reopens protected seeded files and compares them with the actual pre-update snapshot. Every preserved media file is independently decoded with ffmpeg. The successful case observes the original process exit, actual bundle replacement and an automatic new GUI/native/helper process before an explicit later Quit/reopen used for account/UI inspection. That inspection reopen does not install or copy the candidate.

`--recheck` does not run a build, mount, copy, launch, restart, record, update, alter a feed or write a report. It validates the locally authenticated observer transcript against the dedicated account's key outside the evidence folder, requires the latest attempt to be complete, and freshly remeasures signatures, stapling, quarantine, artifact digests, payload identity, gated source outputs, preserved before/after data and media decoding. A JSON status flag or shape alone cannot qualify a transition. Missing, changed, generated or unsigned evidence fails with exit1. A new experiment requires a separate explicit `--exercise` invocation.

The result `updateTransitionQualified:true` covers this observed installer/update subset. `productionAccepted` remains false because authentic provider/billing, physical recording coverage, audience and final release gates remain independent. The root release checker must combine these actual gates; source/fixture success is not a release.

## Dedicated account and ownership prerequisite

Run actual acceptance only in an explicitly provisioned, graphically logged-in disposable macOS account named `rushes-qa-` followed by3–12 lowercase letters/digits. Its real OS home and username must match inputs. Never override HOME. The account marker `~/.rushes-update-acceptance-account.json` must be a real private file owned by that UID:

```json
{"schema":"rushes.acceptance-account/1","username":"rushes-qa-abc","home":"/Users/rushes-qa-abc","purpose":"disposable Rushes acceptance only"}
```

The app's default Rushes settings/recording roots and updater cache must be absent before each experiment. The harness refuses pre-existing state instead of moving it. Only roots it has itself created during the current case are archived into that case's evidence after the app exits. All installation paths live below the supplied evidence root inside the dedicated home and a `.noindex` directory. Do not use a personal account or copy personal credentials/recordings into seeds.

The exercise source checkout must also be owned by and inside this dedicated account; the candidate must have been built from this same checkout. The seed settings must have camera/microphone/system audio and auto-share disabled before launch.

The seed settings must come from this account with a real linked TEST cloud account, and the seed recordings must be owned generated acceptance media. Seeds must be real directories inside the dedicated home, contain no symlinks, and include actual preserved media. The harness disables new idle camera/mic/system-audio input using the app's ordinary settings API before taking the preservation baseline. The busy case's explicit source is a separate bounded physical check, not generated capture.

A dedicated account is required by researched relaunch behavior, not a guessed profile workaround. [Electron44.7.0 DEPS](https://github.com/electron/electron/blob/v44.7.0/DEPS) pins Squirrel.Mac `fffea30e4a339a7f7d69a3391314b72548d209bd`. The pinned [request serialization](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLShipItRequest.m) does not carry app environment/arguments; the [launchd job](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/SQRLShipItLauncher.m) supplies ShipIt's job/state arguments; [ShipIt relaunch](https://github.com/Squirrel/Squirrel.Mac/blob/fffea30e4a339a7f7d69a3391314b72548d209bd/Squirrel/ShipIt-main.m) launches the app with an empty NSWorkspace configuration. Pinned electron-updater6.8.11 `ElectronAppAdapter`/`AppAdapter` derives its macOS cache base from the OS home independently of Rushes' app-data variables. [Electron's app API](https://www.electronjs.org/docs/latest/api/app) also gives userData/session data account-derived defaults. The harness does not assume an initial temporary environment or inspector arguments survive Squirrel.

## Inputs

Place bounded `inputs.json` in the evidence root. Example values are placeholders, not credentials or acceptance evidence:

```json
{
  "schema":"rushes.installed-update-inputs/1",
  "account":{"username":"rushes-qa-abc","home":"/Users/rushes-qa-abc"},
  "expectedTeam":"ABCDEFGHIJ",
  "baseline":{"directory":"/Users/rushes-qa-abc/Artifacts.noindex/N","sourceRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "candidate":{"directory":"/Users/rushes-qa-abc/Artifacts.noindex/N1","sourceRevision":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
  "seed":{"settings":"/Users/rushes-qa-abc/Seed.noindex/settings","recordings":"/Users/rushes-qa-abc/Seed.noindex/recordings"},
  "feed":{"url":"https://updates.example.org/rushes-acceptance/","controlURL":"https://updates.example.org/rushes-acceptance/__acceptance__/scenario","controlTokenEnvironment":"RUSHES_UPDATE_ACCEPTANCE_CONTROL_TOKEN"},
  "busyCapture":{"mode":"display","source":"main"}
}
```

Each release directory must contain the exact strict `latest-mac.json`, versioned DMG and ZIP. N1 must be strictly newer than N. Derive the explicit expected team from the exact codesign TeamIdentifier field or certificate OU; an Apple Development display-name/CN suffix is not a team selector. Both actual signed apps must embed the same reviewed HTTPS feed policy and selected Developer ID team. The candidate source revision must be the clean source checkout running this command. The fresh umbrella gate rebuilds main/renderer/SDK/viewer and a fresh isolated automation helper; helper metadata and compiled code are compared after removing signatures/debug symbols only on owned comparison copies (Mach-O UUID is excluded from that comparison); the native release build and packaged native code are compared independently of replaced code-signature storage. Full signed payload bytes must match between DMG, ZIP and actual installation. All nested Mach-O executables must have the selected Developer ID team, hardened-runtime flag and timestamp; app/DMG staples and app Gatekeeper assessment must pass. [Apple's custom notarization guidance](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) explains stapled tickets and why ZIP contents, rather than the ZIP itself, receive staples.

## Reviewed HTTPS failure feed

`feed.mjs` exports `acceptanceFeed({manifest,directory,token,prefix})`, an acceptance-only Node HTTP request handler. Root may expose it through an already reviewed HTTPS service/reverse proxy. This repository does not deploy that service, create DNS/certificates, install trust roots or activate spend. The signed app's feed URL must already point to it; the harness never changes signed app resources or weakens public HTTPS validation.

The public routes serve only the exact manifest/artifact basenames. The authenticated same-origin control route selects one scenario with a run UUID; the token comes only from `RUSHES_UPDATE_ACCEPTANCE_CONTROL_TOKEN` and is never put in inputs, process arguments, receipts or logs. Corrupt/cut responses alter only outgoing acceptance ZIP bytes; they never modify signed artifacts on disk. The handler defaults to unavailable until a scenario is selected. Its generated transport test is not a real signed-update test.

## Evidence and remaining authority

Every actual command's own exit and bounded output are retained in a private command journal. Build/gate/helper commands use the existing owned-session supervisor with TERM/KILL escalation and descendant retirement; its retained output is explicitly a bounded tail. An account-local Ed25519 observer key seals only a completed observed run and the journal digest; its public anchor lives outside the evidence folder. Recheck verifies that anchor and then measures the referenced files again. This protects against arbitrary/generated receipt substitution, not a malicious owner of the OS account or tampered verifier source. Source revision and clean/gated checkout remain part of the trust boundary.

Failed attempts retain their owned paths and latest-attempt pointer. No earlier successful receipt may hide a newer incomplete attempt. No private key, TEST credential, media, provider implementation or runtime transcript belongs in public Git/CI artifacts. Actual Developer ID/notary authority, the dedicated account, reviewed HTTPS fixture feed, GUI/physical consent and the final non-writer/root acceptance remain external prerequisites. A development build, ad-hoc signature or generated fixture cannot satisfy them.
