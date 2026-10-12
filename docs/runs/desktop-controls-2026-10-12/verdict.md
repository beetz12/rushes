# Independent desktop controls review

Reviewed on 2026-10-12 by one fresh read-only reviewer. Requirements came from
`contract.md` and `slice.md`, both read in full. The implementation reviewed was
the complete `853ff16..e766577ac8d7f46aaf57267be266c0c8f463a3ba` diff: 17 files,
including 15 code/test files and two requirement/evidence documents. Related
preload, engine parser/supervisor, camera overlay, capture coordinator, socket
mailbox, session request, original exporter and editor handoff code was opened
to trace the changed behavior. The checkout was clean at that source revision
before this verdict was written.

**Source verdict: Yes, ready for root release integration.** No supported
blocking or important defect was found in this range. This verdict does not
declare the installed-app objective complete. The full release gate, packaging,
installation and physical desktop checks remain root-owned; they were not run
by this reviewer while the Mac was locked.

## Requirements and implementation

| Requirement | Independently checked implementation and result |
| --- | --- |
| Camera only without screen capture | `shell/src/shared/contracts.ts:148` produces only camera, microphone, countdown and `systemAudio:false`; stale display/window/area/cursor settings are omitted. `shell/src/renderer/main.tsx:281` enables a camera for this mode, keeps the microphone choice, and does not require a screen grant. Native `targetsResult` still lists camera/microphone devices without screen access, and `resolveSessionRequest` leaves screen nil when no screen argument is sent. Production capture consequently takes its standalone microphone path and creates no screen stream. The current built renderer was clicked with a denied screen grant and emitted the expected camera/microphone-only Start object. |
| Clear combined versus separate-original export | The actual review selector at `shell/src/renderer/main.tsx:2157` calls the shared selection function at `shell/src/shared/contracts.ts:187`. Separate always selects `editor-tracks`; combined retains the chosen existing format. Preload forwards the existing export IPC, main validates the shared preset and chooses a directory, and `PostproductionService.swift:117` takes the original-copy path before rendering. The copy loop at `PostproductionService.swift:211` preserves source media, flattens track names and writes `offsets.json` with `editApplied:false` plus `edit.json`. A fresh headless click-through using this checkout's built renderer and native binary produced all four generated originals and both sidecars. Every original's before/after/export SHA-256 matched; camera +100 ms and microphone -120 ms offsets survived. Returning the UI to combined selected `share`. |
| Selected live camera preview on entry and switch | Main calls `syncIdlePreview` on recorder show/reopen, engine readiness, permission grant and saved camera changes (`shell/src/main/index.ts:149`, `:208`, `:484`, `:892`, `:1355`). Automatic acquisition checks existing camera access. `IdleCameraPreview` serializes stop/start, clears the frame gate immediately on selection, validates the latest acknowledgment before showing, permits retry after failure, and invalidates pending callbacks on close/hide/start/disconnect. Recording takeover awaits idle cleanup before issuing native Start. Scoped tests cover restored selection, rapid switch, stale completion, Off/Close, takeover and failed warm retry. The headless renderer selected camera-only and requested preview without an Off/On cycle. Real device frame delivery remains an installed physical check. |
| Original countdown ticks | Native emits the actual positive countdown steps and zero before opening the gate (`EngineController.swift:1089`). `CountdownSignals` rejects duplicate/increasing steps and wrong take IDs and closes at zero/cancel/end/recovery. Main clears cues on Cancel/Stop/Discard and failed Start. Only the recorder renderer plays the tick; `CountdownAudio` synthesizes its own short sine envelope, with gain 0.08, 8 ms attack and a higher final tone. Its generation guard suppresses delayed AudioContext resume after cancellation, and teardown closes the context. Tests independently passed for 0/3/5 seconds, duplicate steps, cancellation/failure/recovery, the soft cue parameters and delayed audio resume. No copied Photo Booth sound asset is introduced. Audible output and perceived countdown timing remain physical checks. |
| Minimize after a real start while controls remain | Native `recording-started` follows successful `session.openGate` and `rig.gateOpened` (`EngineController.swift:1105`, `:1118`). Main minimizes only recorder/library/settings on that event (`shell/src/main/index.ts:1245`) and opens the independent bar and recording bubble. The startup response no longer hides the recorder. The supervisor's event listener marks capture active before the main listener, so the recorder's minimize handler preserves active capture overlays. The lifecycle deduplicates recording IDs and does not minimize for preparing, armed, failed/canceled startup, pause/resume or reconnect. Reopening an existing minimized main window restores it. Tests cover this event gate and Cancel while idle preview cleanup is pending. Actual macOS window/bubble behavior remains a physical check. |

## Preview lifetime seam

The amendment addresses both queues, rather than assuming source stop drains
all delivery. `CameraSource` captures its preview handler before asynchronous
JPEG work; `SocketLineIO.offerPreview` stores a serialized pending frame whose
write can follow a newer reliable acknowledgment. Both unchanged paths were
read this turn.

`EngineController.swift:354` activates a distinct token for each idle warm;
`:1038` uses the effective recording inputs and activates a distinct recording
token only when a camera remains. Each source publisher captures that token.
`PreviewPublication.swift:23` rejects superseded publishers and attaches the
captured token to accepted events. Even a publication racing invalidation still
retains its old token in the event. Failed/canceled warm, idle owner loss,
camera-absent recording and shutdown invalidate publication. Recording
unsubscribe disables publication without reacquiring/stopping the camera or
changing its source token/clock; re-subscribe acknowledges that current token.

The shared acknowledgment schema (`shell/src/shared/contracts.ts:265`) requires
a nonempty token. `PreviewFrames` clears at lifecycle boundaries, refuses
obsolete acknowledgments before validation, and rejects missing/mismatched
tokens. The idle coordinator only installs its latest successful acknowledgment;
recording bubble installation additionally checks overlay generation, recording
ID and active state (`shell/src/main/index.ts:563`). A missing-token
acknowledgment stays closed and reports an error. There is no untagged fallback.

Fresh native state tests exercised controller start/subscribe results, old/new
source publishers, failed warm, idle owner loss, canceled attach and absent
camera. Fresh shell tests exercised old serialized NDJSON delivered both before
and after a new acknowledgment through the actual `EngineClient.ingest` parser,
including a split fresh line. Those tests prove handling of either delivery
order; they do not claim to force the operating system mailbox scheduler.

## Fresh verification

All commands ran against this review checkout. Private logs and generated proof
remain under
`~/.goal-loop/loom-clone/host/2026-10-12-desktop-controls/review` (directory mode
0700).

| Check | Observed result |
| --- | --- |
| Changed shell/native source, native tests and contract/slice clean scan | `python3 -I tools/checks/check_clean.py ...`: first line **0**, actual exit **0**, no skipped-source warning. `clean.log` records the output. |
| Pinned dependencies | Fresh `npm --prefix shell ci --no-audit --no-fund`, Node **22.22.0**, actual exit **0**. No tracked manifest/lock change. The initial checkout lacked dependencies; its failed attempts are retained separately. A brief temporary dependency symlink was removed before this authoritative install and both repeated shell gates. |
| Shell build/typecheck | `npm run build` in shell, Node **22.22.0**, actual exit **0**. TypeScript and Vite completed; `shell-build.log` contains substantive output. |
| Complete shell suite | `npm test`, actual exit **0**: **117 tests in 16 files passed**, 8.39 seconds. `shell-test.log`. |
| Bounded native state suite | Swift **6.4**, `swift test --filter PreviewLifetimeTests`, actual exit **0**: successful compile, **8 tests in one suite passed**, 0.039 seconds. `preview-lifetime.log`. The opened fixture uses no-op capture rigs and a state-only TrackWriter backend, creating no AVAssetWriter, physical device or encoder. Existing compiler warnings in untouched tests did not fail compilation. |
| Current renderer → native original export | Fresh Chrome **155.0.8059.39** in an isolated headless context; actual probe exit **0**, no renderer errors. Generated nonsensitive MOV fixtures were reused, copied into a private review library, and hashed independently. No encoder was run. The current review native engine received only `show`, `edit.get` and original `export` requests. `ui-export-review.log` and `click-through-result.json`. |
| Whitespace and ownership | `git diff --check 853ff16..e766577` exited **0**. Business source remained unchanged; this verdict is the reviewer's only tracked edit. |

The headless fixture uses a synthetic `window.rushes` API for permissions,
camera/start behavior and the Electron save dialog boundary. It exercises the
actual rendered selector and routes separate export to the real current native
exporter. Combined rendering is mocked in that probe. The headless screenshots
were visually inspected for the camera-only choice and separate export controls;
no live camera frame or actual combined-video playback is claimed from them.

## Release boundary

No public push/PR, app install, provider/credential change, shared Beads write,
personal browser/profile or shared GUI action was performed. The Mac's locked
state was preserved. No full Swift/media/encoder suite or physical recording
test was started. Root must apply its full release and installed-app gate after
unlock and a fresh input-idle check before reporting these installed fixes as
complete. No code repair is required by this bounded review.
