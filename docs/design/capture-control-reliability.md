# Capture control and reliability

Original implementation from the recording plan. No reference clone source read.

One camera session is owned by a reusable capture coordinator. Selecting a camera
starts this session for JPEG preview; recording attaches its writer to that same
session and detaches it at Stop. Recording appends happen first. JPEG compression
runs on a separate queue with a single in-flight frame. A slow control client can
hold at most one pending preview frame, replacing older frames. Preview writes
never block capture or recording control.

Device format mutations require exclusive device configuration ownership. Camera
loss detaches its writer and records a warning while screen and audio continue.
Audio mute replaces samples with silence through the existing writer, preserving
the timeline. Input telemetry adopts the same clock after every pause and resume,
and a one-second heartbeat persists pointer position even when no tap is allowed.

Recording preparation is reserved before any actor suspension, preventing two
simultaneous start requests. Countdown cancellation sets a generation token, stops
capture and removes only the empty newly-created package. Explicit discard removes
only the current take after writers have closed; restart uses its prior parameters.
Permission checks never prompt. Explicit permission requests invoke native APIs;
screen's asked flag is persisted to distinguish first launch from a prior refusal.
Area rectangles are clamped to the selected display and kept in global points;
stream configuration converts them to display-local points. Cursor-free mode sets
the stream cursor flag and records that choice in metadata. Bubble placement is
stored as normalized center and a point size so review/export can reproduce it.

Camera preview processing forwards one optional pixel transform to the existing
camera preview queue. The coordinator retains it for a future explicit warm,
applies it to a reused camera, and changes no device lifecycle itself. A transform
may suppress a frame; source privacy guards decide whether a queued JPEG is stale.
Microphone observers attach once to the microphone writer in both real and stub
rigs. The writer supplies media-time PCM after its gate, pause and mute rules;
consumers bound their own downstream work. Capture adds no extra worker or clock.

The periodic cached-pixel heartbeat applies only to screen tracks, whose native
stream can report idle content. Camera callbacks deliver frames continuously even
for unchanged pixels. A wall-time camera heartbeat can advance past real capture
timestamps when delivery is delayed; preserve those genuine camera timestamps.

## 2026-10-16 take ownership and teardown

Deterministic barriers reproduced stopped-start publication, source-failure
teardown accepting a new take, retired failure/warning callbacks affecting the
current take, and late pause/resume events. Capture callbacks now carry their
originating recording identity; warnings also carry startup generation/session.
Normal Stop and source failure use the same finishing interlock and cleanup.
Startup/transition continuations re-check ownership after awaits; a canceled
gate hook is stopped again because it may have installed resources after Stop.
A start-owner token prevents a retired start's defer from clearing a newer start.
A rejected late countdown Cancel leaves the active start generation intact.
Countdown-zero publication also follows the ownership check, keeping terminal
events last. These tests use state-only writers and do not establish hardware
or endurance behavior.

## 2026-10-16 finalization budget and retained media

The deadline starts before queue admission. A lock-protected reporting owner
seals new appends, publishes cached queue snapshots and resolves all finalize
callers once. A timer independent of the native serial queue bounds the response
when admission, padding, endSession or finishWriting stalls. Expiry reports
unchecked/degraded media; it does not cancel AVAssetWriter or prove file closure.
Native operations remain serialized and a pending-file lease prevents diagnostic
decode until native completion. Late completion frees ownership without rewriting
the terminal Stop outcome. Known-empty writers alone may be cancelled/deleted.

A degraded track makes the take failed/unchecked rather than complete. Failed
takes with surviving files receive diagnostic-only decode jobs; a good surviving
track cannot turn the failed take into verified success. Pending native work
retries the check for a bounded number of attempts, or resumes after restart.
This supersedes the older docs/PLAN.md Finishing assumption that fragmenting alone
proves timed-out files playable and that every bounded Stop should be complete.
Review labels distinguish saved, checking, independently verified and issues.
AI summary errors remain separate from media health.

The independent short qualification exposed heartbeat/source timestamp conflict:
screen maintenance must synthesize pixels only after250ms without a valid input
arrival, measured on a separate monotonic receipt clock. A direct regression
keeps delayed genuine frames; static-screen fragment cadence remains tested.
Post-read actor checkpoints also reproduced Cancel/gate/replacement, discard
cleanup, maintenance silence and start/wait/index races. These diagnostic seams
exist only in DEBUG builds; release behavior uses the same ownership guards.
A controller countdown owner is cleared before opening the gate; discard retains
its interlock through every cleanup await; startup retains ownership until its
waiter is registered or terminal outcome consumed. Finishing identity lets that
waiter join an in-progress Stop. Capture failures during attach are latched until
the scoped rig returns, then cleaned up without a healthy-start publication.

## Incoming PCM continuity

The audio heartbeat's 250ms look-behind is not an incoming-gap threshold. After
a partial-buffer pause, the first resumed buffer may overlap the prior PCM end
and be dropped. The next buffer can leave only 12–20ms of missing PCM. AAC
compacts those holes unless actual silent samples are appended, even if the
writer reports monotonically increasing PTS and a common tail.

TrackWriter fills incoming gaps greater than one PCM sample, snaps sub-sample
jitter and carries the actual rounded silence extent. An unsuccessful gap fill
cannot authorize a later discontinuous append. Full real AAC decode across five
deterministic partial-buffer pauses verifies the common end; the original
whole-buffer overlap drop policy and50ms media acceptance remain in force.

## Selected-input feedback

Idle setup checks the selected native microphone through AVFoundation Float32
PCM (RMS, peak and full-scale clipping), and the selected display/window/area
through a bounded SCK JPEG. Permission reads never request a grant. Areas use
the captured display origin; missing or Rushes-owned windows fail explicitly.
The generated-capture mode supplies labeled native catalog inputs and generated
PCM/JPEGs, exercising the same command and validation path without devices.

A connection-scoped monotonic selection revision preserves Stop intent when
NDJSON request tasks arrive at the controller out of order. Publication carries
an independent native token, and clients reject retired frames and levels.
Native acquisitions/drains serialize; a response timeout retains ownership until
actual completion. One screenshot slot, two pending Starts, coalesced drains and
completion waiters removed at deadline bound retained work during repeated
failures. A permission check released after deadline cannot initiate capture.

Stop reports quiescence of native ownership and invalidated intent, independently
of obsolete queued tasks that are guaranteed to skip acquisition. Recording
reserves startup before draining previews, then rechecks cancellation before
creating a take. Hidden setup independently closes microphone/screen feedback
and camera feedback; one failure cannot suppress the other cleanup. Failed
cleanup remains retryable. Camera unsubscribe can carry the captured source
token so a delayed old cleanup cannot disable a replacement source.

## Preview transport pressure

Camera and microphone preview messages are best effort. A timed-out send that
has written zero bytes can drop that complete preview without changing NDJSON
framing or closing the control connection. Once any prefix is sent, failure
still closes the stream before another line can append. A reliable reply or
event also remains terminal on failure, including a zero-byte timeout. The
existing send deadline and bounded one-pending-preview mailbox stay in place.
Metadata-only diagnostics record category, errno, byte counts and dropped/closed
disposition; they never include a frame, PCM or request contents.

An explicit Cancel/Discard retains the same terminal recording-stopped ordering,
with discardRequested:true on the event while that take owns the discard
interlock. This describes requested cleanup, not proof that deletion finished.
Desktop clients keep cleanup busy until fresh idle, return to setup and skip
auto-share for that event. Ordinary failed Stop has no discard marker and keeps
its diagnostic review. Cancel before active publication already removes its
unpublished package and returns the cancelled Start response without a terminal
media review; the desktop treats that response as expected cancellation.
