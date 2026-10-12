# Desktop controls implementation

Owned checkout: `/Users/dave/Work/rushes-desktop-controls`, branch
`codex/rushes-desktop-controls`, implementation base `766434f` (contract on
release base `853ff16`). Central issue `openbrain-v05d.1` remains root-owned.

## First shell commit (`377b518`)

- Added **Camera only** alongside the three screen source choices. It enables a
  selected/default camera, leaves the microphone selectable, disables system
  audio, and sends no display, window, area or cursor arguments. A screen grant
  is unnecessary in this mode; camera access and an enabled camera are required.
  Native `targets` can list camera/microphone devices without a screen grant, so
  the renderer now requests that catalog for camera-only setup too.
- Added an explicit **Export output** choice between one combined file and
  separate original files. Separate uses the existing `editor-tracks` exporter
  and original timing/edit sidecars. Its copy explains that originals retain
  their full camera background and audio and that edits apply to combined
  exports. The existing top-level separate-tracks shortcut remains available.
- Moved idle camera warm-up lifecycle into a serialized shell coordinator.
  Restored selected cameras warm when the recording window becomes visible or
  is reopened; changing cameras clears stale frames immediately, publishes only
  after the current warm acknowledgment, and suppresses old callbacks after
  Off, hide, navigation close, recording takeover or disconnect. It checks an
  already-granted camera permission before automatic acquisition. Explicit
  camera choices remain the permission-request path.
- Generated original 70 ms sine countdown chirps in Web Audio, with 8 ms soft
  attack, gain 0.08 and a higher final tick. Sounds follow deduplicated native
  positive countdown events, rather than a renderer timer. Zero, cancel,
  failure, stop, recovery and unmount cancel queued/current sounds. No Apple or
  third-party sound assets are used. A startup fence also prevents Cancel/Stop
  during pending idle camera cleanup from later issuing native Start.
- Minimize visible recorder/library/settings windows once at the native
  `recording-started` gate. Failed/canceled startup, preparing/armed responses,
  pause/resume and recovery do not minimize them. The floating control bar and
  recording camera bubble retain their separate lifecycles. Explicitly opening
  a minimized main window restores it. Idle minimization closes its preview;
  active minimization preserves the recording overlays.

Declarations remain in `shell/src/shared/contracts.ts`; main and renderer
consume the existing IPC names. Swift, browser/cloud packages, provider settings,
packaging and manifests are unchanged by this shell commit.

## Evidence

Private proof directory:
`/Users/dave/.goal-loop/loom-clone/host/2026-10-12-desktop-controls/build`.

- Node `22.22.0` shell install/build/typecheck succeeded. `build.log` records the
  actual TypeScript and Vite output; no dependencies were changed.
- Complete shell suite: **107 tests in 15 files**, including 23 new focused
  tests for request shaping, preview acquisition/switch/stop/failure callbacks,
  0/3/5-second countdowns, late audio resume cancellation, startup cancellation
  and the real active event versus failure/cancel/recovery/minimize deduplication.
  See `shell-tests.log`.
- `check_clean.py shell/src` final first line **0**; `git diff --check` succeeded.
  The first scan found eight conventional deferred-promise helper overlaps.
  That small independently written helper was rewritten without opening any
  reference source; the initial output is retained as `clean-initial.log`.
- Isolated headless Chrome `155.0.8059.39` rendered the built desktop UI with a
  synthetic `window.rushes` API. The camera-only choice remained reachable with
  Screen Recording denied, microphone stayed selectable, and actual Start
  called the correct camera/mic-only argument object without an Off/On cycle.
  No personal profile, GUI activation, real device or provider was used.
- The actual review **Separate original files** selection called a separate
  private native capture-stub engine's existing original exporter. Generated
  test-pattern/color video and 440/660 Hz audio yielded `screen.mov`,
  `camera.mov`, `mic.mov`, `system.mov`, `offsets.json` and `edit.json`.
  Every original's before/after/export SHA-256 matched. Timing sidecars retained
  camera `+100 ms`, microphone `-120 ms`, and `editApplied:false`.
  `click-through-result.json` contains the exact hashes, files, API calls and
  empty renderer-error list. Switching back to combined invoked `share`;
  combined rendering was mocked in this UI fixture.
- Screens `camera-only-1120.png` and `separate-export-1120.png` were visually
  inspected. The helper script and generated media remain private. The native
  helper received no record or device/permission request and was terminated
  cleanly after the export check. The headless click-through predates the
  additional startup fence and one caption clarification; those changes are
  covered by the subsequent full shell suite and build.

## Remaining integration checks

Root owns fresh independent review, native/release gates, packaging, installation
and physical screen/camera/microphone, audible countdown, bubble and minimization
tests. This slice does not claim an installed-app pass.

A narrow existing native stale-JPEG seam was reported before expanding ownership
for the following separate amendment:
`CameraSource.stopAndWait` drains session/frame work but not JPEG preview work.
Moreover, `SocketLineIO.offerPreview` has a separate pending-frame mailbox whose
write can occur after a reliable new warm acknowledgment. A source queue drain
alone cannot establish transport freshness. Current shell suppression rejects
frames during stale warm-up/stop callbacks; distinguishing a previously queued
old JPEG after a new acknowledgment requires a source lifecycle token carried
in the native preview event and acknowledgment. Exact proposed fields are
`result.previewToken` on `camera.preview.start`, `camera.preview.subscribe` and
`camera-preview`; EngineController owns token generation/publication and shell
main consumes the shared declaration. Native source remained untouched in the
first shell commit; root subsequently approved this exact extension in `60c17a9`.

## Preview lifetime design, before native implementation

Root approved the exact previewToken amendment in `60c17a9` after inspecting both
queues. Each idle camera warm and each recording rig obtains an opaque UUID
token. EngineController activates that token before handing a captured publisher
to the source, and the publication helper attaches the captured value to every
JPEG event while rejecting callbacks whose value is no longer current. Idle
stop, canceled/failed warm-up and idle owner loss invalidate publication; active
unsubscribe only disables publication and preserves the writer/source lifetime.
An enabled `camera.preview.subscribe` acknowledges the current recording-source
token without acquiring or changing a device. Tokens are correlation metadata,
never credentials or permission grants.

The native start/subscription result and each JPEG result use the same field,
`previewToken`. Shell shared contracts validate acknowledgments and frame tokens.
The idle warm coordinator installs a token only for its latest successful warm;
the recording bubble coordinator installs the token only after its latest
subscription acknowledgment and recording-ID check. A shared main-process frame
gate is cleared at hide/stop/new take/disconnect and refuses missing tokens.
Frames arriving before an acknowledgment are dropped and the next live frame is
shown. Frames already queued by SocketLineIO retain their old token, so they are
rejected even when delivered after the new acknowledgment. Delayed obsolete
acknowledgments cannot rearm the gate after a newer selection, Close or Cancel.
There is no fallback that accepts untagged native frames.

Tests will separately exercise obsolete source callbacks before publication and
old already-published frames reordered across an acknowledgment. Controller
tests use synthetic factories and dummy/no-op writers for subscription/start
boundaries; state tests use generated byte arrays, not a physical camera or
encoder. CameraSource and SocketLineIO need no implementation change: the token
must remain attached through both existing queues rather than assuming either
one drains in a particular order.

## Preview token implementation and bounded evidence

EngineController now returns `previewToken` in successful idle warm and
subscription results and hands captured tokens to an extracted publication
helper. That helper drops superseded source callbacks and tags accepted JPEGs.
An absent source returns `previewToken:null` on subscription; it cannot establish
a shell preview. Idle close, failed/canceled warm and idle owner loss invalidate
publication. Recording source tokens persist across publication-only
unsubscribe/re-subscribe; writer acquisition and clocks are unchanged.

Shell main uses the shared acknowledgment declaration and a frame gate for both
idle preview and recording bubbles. It installs only the latest acknowledged
token, clears the gate on lifecycle boundaries, rejects every untagged or
mismatched JPEG, and keeps missing-token acknowledgments closed. Its generation
guard rejects delayed obsolete acknowledgments before validating/installing them.
No CameraSource or SocketLineIO implementation change was necessary.

Bounded proof files in the private evidence directory:

- `preview-token-native.log`: `swift test --filter PreviewLifetimeTests` exited
  0; **8 state tests** passed in **0.022 seconds**, following a successful Swift
  compile. Tests exercise actual controller warm/subscribe results, obsolete
  publishers, warm failure, idle owner loss, canceled attach and recording
  subscription, including a take whose effective inputs contain no camera. Their
  capture factory and TrackWriter backend are synthetic
  state fixtures; no AVAssetWriter, physical camera or encoder is created.
- `preview-token-shell.log`: complete shell suite **117 tests in 16 files**,
  exit 0. The additional tests cover missing tokens, obsolete idle and recording
  acknowledgments, Close/Cancel/Stop/new take, and both transport delivery orders.
  The transport fixture feeds old/new NDJSON through the actual EngineClient
  parser after retaining an old serialized payload; it tests consumer order
  handling without claiming to force the operating system's mailbox scheduler.
- `preview-token-build.log`: Node22.22 shell build/typecheck exit 0.
- `preview-token-clean.log`: changed native source/tests, shell source and this
  design/evidence slice scan first line **0**. `git diff --check` exit 0.

Root's independent review, full native gate and installed physical checks remain
required. The private synthetic export proof from the first shell commit was not
repeated while root ran its real browser recording; the token extension does not
change original export or media contents. No public push, install, credentials,
provider mutation, shared Beads write or shared GUI control occurred.

## Transport repair design, before implementation

Root approved the bounded transport amendment in `8563fea` after successful
installed recording checks left an invalid-json alert visible. A generated-byte
socketpair investigation independently demonstrated that the current 250 ms
send timeout can leave a partial JSON prefix on the stream: 4,096 of 262,217
fixture bytes were sent before errno 35, and a later reliable event appended to
that prefix to produce an invalid 4,136-byte JSON line. This is a transport
defect; it does not establish the installed alert's exact cause or explain the
earlier native PID change. Installed exit/signal evidence is unavailable.

SocketLineIO will mark a terminal write failure closed and shut down that socket
while still holding its existing writer lock. Reliable, preview and error
writers will then refuse any later append to the truncated prefix. The same
locked close operation will preserve the existing active-reader descriptor hold,
waking readers before releasing their descriptor; repeated Close remains safe.
The native process, camera/device lifecycle, recording clock and writers will
not be stopped by a peer's write failure.

EngineClient will treat malformed NDJSON as terminal for the affected socket:
clear partial input, reject pending requests, stop parsing trailing messages,
and destroy the socket. A connection-local failure latch will reject queued
input until a new connection is established. Existing Supervisor recovery must
reuse the native process and preserve its cached active take, then validate fresh
status before emitting engine-reconnected. The invalid-json classification will
be cleared by the existing UI only after that verified event; neither successful
syntax parsing nor a TCP/socket connect clears it. No image/message contents
will be printed or stored by diagnostics; only bounded lengths and error codes
may be retained. Preview token and payload validation stay strict.

Tests will force real generated-byte socketpair backpressure, observe a partial
prefix without its newline, and prove subsequent writes are refused. They will
also cover a blocked reader's descriptor lifetime. Isolated Node socket fixtures
will inject a malformed line before an apparently valid trailing status/event,
prove it cannot mutate recording state or settle a pending request as success,
and verify recovery from held fresh status without launching/killing a sidecar
or issuing Stop. No physical device, shared GUI or media encoder is required.

## Transport implementation and bounded evidence

SocketLineIO now uses one lock-held close operation for terminal write failure
and explicit Close. A truncated prefix is followed by stream shutdown, not by a
new response/event. Reader descriptor holds and repeated Close remain intact.
EngineClient rejects a malformed JSON line or non-object protocol envelope,
rejects pending requests, clears partial input, latches that connection as failed,
and destroys only its socket. New connections reset the latch. Valid object
envelopes and primitive/null result payloads retain their prior behavior.
Malformed diagnostics expose only `code`, a fixed message and `lineBytes`.

The connection-error classifier now includes invalid-json; the existing UI's
verified engine-reconnected callback can clear it. No change was made to the
Supervisor's fresh-status gate, active take cache, launch/kill behavior, Quit
finalization holds, native preview tokens, recording clocks or device ownership.

Private proof files under the existing `build` evidence directory:

- `transport-original-probe.json` and `transport-fixed-probe.json` execute the
  actual original/current SocketLineIO class extracted into standalone Swift
  generated-byte probes. Original: a **4,096-byte** prefix stayed open, accepted
  a subsequent **41-byte** event and formed invalid JSON. Fixed: the same prefix
  ended at EOF, the connection was closed, the next write was rejected and **0
  later bytes** arrived. Probe sources are retained privately. This is a
  negative control of the transport defect, not an installed-incident trace.
- `transport-native.log`: **4 filtered native tests** passed in **0.535 seconds**
  after successful compilation. The two new tests exercise actual socketpair
  timeout/prefix/subsequent-write rejection and blocked-reader/descriptor reuse;
  the two existing descriptor lifetime tests also passed. No media encoder or
  device was created.
- `transport-shell.log`: complete shell suite **124 tests in 17 files**, exit
  0. Seven new parser/socket tests verify malformed input cannot accept trailing
  replies or alter a cached recording state, missing protocol objects terminate
  safely, reconnect resets the latch, and primitive/null result payloads remain
  supported. A held fresh-status recovery leaves both the invalid-json alert and
  active take intact after reconnect and a valid ordinary event; only verified
  recording status clears the error. It launches/kills no sidecar and sends no
  Stop.
- `transport-build.log`: Node22.22 shell build/typecheck exit 0.
- `transport-clean.log`: changed source/tests and this slice clean scan first
  line **0**; `git diff --check` exit 0.
  `transport-clean-initial.log` retains five standard-library import overlaps
  from the first scan. Independent namespace aliases replaced that fixture
  import grouping without opening any reference implementation; the final
  source scan passed.

Root still owns independent review, the full merged release gate and installed
verification. The original successful recordings and their exports were neither
opened nor modified by these generated-byte tests. The native PID change remains
unattributed. No repository-public push, install, GUI, provider or Beads write
was performed by this writer.

## Renderer recovery latch design, before implementation

Independent review of `e98c3d7` found that App.run's action-start clear removed
invalid-json before any fresh-status response or verified recovery event, and a
pending request's legitimate engine-disconnected rejection replaced the original
notice. Root approved a narrowly scoped renderer/error-state amendment in
`f42f59b`.

Connection errors will occupy a separate latched status from ordinary action
errors. The first connection notice remains the phase's cause; later coded
connection failures update a latest detail, without erasing that cause or an
ordinary failure. Both kinds remain visible independently. Action start and
ordinary dismissal clear only the ordinary slot; successful actions and normal
events do not clear the connection status. The existing engine-reconnected
handler is the sole caller of a verified-recovery transition, which clears only
the connection slot and leaves unrelated action errors intact.

The shared reducer will preserve error codes and messages and make these
transitions explicit. Main-window connection alerts will have no dismiss control;
ordinary alerts retain dismissal. Compact bubble/bar/drawing views will consume
the same combined message representation. Generic catches will keep classifying
their real codes rather than suppressing them. A new connection failure will
remove only a prior connection-restored note, so stale success copy cannot
contradict the current latch; unrelated notes remain. Pure transitions and the actual
built renderer with a synthetic API/held status promise will test successful
actions, pending disconnected rejections, ordinary failures/dismissal and
verified recovery. No native process, device, shared GUI or provider is needed.

## Renderer latch implementation and evidence

App now uses a shared reducer with independent connection and action slots. It
retains the first connection cause and the latest coded detail, displays ordinary
failures separately, and clears connection only in the existing verified
engine-reconnected handler. Main-window connection notices have no dismiss
button; ordinary dismissal and action-start clears affect only ordinary errors.
Generic option/preset catches retain their codes. Compact views preserve both
kinds through the same combined text. A new connection failure removes only
stale connection-restored copy, leaving unrelated notes alone.

Bounded evidence in the private `build` proof directory:

- `renderer-latch-shell.log`: complete shell suite **128 tests in 18 files**,
  exit 0. Four new reducer regressions cover first/latest connection errors,
  action starts/dismissal/success, unrelated failures and verified recovery.
  The last small stale-note display adjustment subsequently passed those four
  focused reducer tests and the actual renderer probe again.
- `renderer-latch-build.log`: final Node22.22 shell build/typecheck exit 0.
- `renderer-latch-result.json` and `renderer-latch-probe.log`: actual built
  renderer in isolated headless Chrome155 with a synthetic API and held status
  promise. A successful Show-preview action and a pending disconnected rejection
  both retained the original notice at **0 fresh responses / 0 verified events**.
  A fresh reply alone still retained it at **1 / 0**. Ordinary permission/disk
  errors stayed visible independently; dismissing ordinary error kept connection
  latched. Verified recovery at **1 / 1** cleared only connection and left the
  disk failure visible. Stale restored copy disappeared on a new failure;
  connection had no dismiss button. Renderer exception list was empty.
- `renderer-errors-independent.png`: visually inspected independent error
  notices; all messages/data in this screenshot are generated fixtures.
- `renderer-latch-clean.log`: changed renderer/helper/test plus this slice scan
  first line **0**; `git diff --check` exit 0.

The checker's original e98 failure proof remains in the separate read-only
`review/transport/error-gate-result.json`. This repair did not rerun Swift,
physical devices, media encoders or the full repository gate during root's M1
resource window. Root retains independent review, release/install verification
and owns `release.md`; that file is excluded from this writer's commit.
