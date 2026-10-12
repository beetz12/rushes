# Browser capture slice evidence

Implementation input: reviewed paid plan and immutable browser-cloud contract.
No reference recorder implementation was opened. Primary sources opened 2026-10-12:
https://w3c.github.io/mediacapture-transform/
https://w3c.github.io/mediacapture-record/
https://developer.chrome.com/docs/capabilities/web-apis/file-system-access

Original design: Window creates a processor per cloned video source and one
video generator. Transfer readable/writable streams into a dedicated worker.
The worker retains one latest screen frame; camera frames drive the composition
when both sources are selected. Output is bounded to 1280x720 and 30 fps, with
awaited writes and closed replaced frames. Originals consume untouched sources.
Audio originals remain separate, and an AudioContext mixes available sources.
All recorders share a monotonic session epoch and pause coordinator. Stop waits
for final recorder data and durable queue completion before a decode check.
Failures request the same bounded finalization, preserve durable bytes and report
an interrupted state. Cancel releases every source and removes only this draft.

Local chunks close and verify before a sidecar descriptor and manifest checkpoint.
A per-draft lock serializes append/save operations. Recovery reconciles sidecars
and unjournaled chunk files, validates hashes, and marks unfinished sessions as
interrupted without reacquiring devices. Optional backup writes close each chunk
and then the manifest; backup failures preserve the OPFS copy and end capture.
Individual chunks or interrupted combined files are not promised playable.

Verification commands and observed limitations will be appended after execution.

The bubble's top-left and diameter are expressed in composed 1280x720 pixels.
Inputs are constrained to a maximum 1280x720/30 before cloning; the worker draws
letterboxed screen/camera originals and clips the camera bubble to a circle.
A separate live-draft browser lock is held until terminal save/removal or page
termination. Another tab can inspect a live journal, but cannot mark it crashed
or remove it while its owner is recording.

Encoder stop has a 15-second deadline; queued storage, journal reads and track
reads have 20-second deadlines; terminal checkpoint has a 10-second deadline.
Devices close before disk/decode verification. Requested bitrate is a browser
hint, not a guaranteed rate. One chunk is limited to 64 MiB; aggregate saved bytes
are limited to 2 GiB; a pending 32 MiB queue requests safe finalization. These bounds
are implemented guards, not a measured total browser/native-process memory cap.
The 600-second active timeline is checked from worker frames and the coordinator;
frozen/discarded pages can still delay controls and require independent M1 proof.

Calibration compares corresponding visual/audio tone edges in decoded media,
including original start offsets. The calibration pattern pauses during a Pause
while source streams keep flowing. Arbitrary source-content changes while paused
are a separate residual measurement (see slice evidence), not implied by this
calibration result. No standard promises exact sample synchronization across
independent MediaRecorders merely because their start calls were adjacent.

Independent repair refinement: creation may resolve after an earlier source-loss
callback, so the start rejection itself joins terminal persistence rather than
relying on the failed-state notification to request another Stop. Enumeration is
per-entry: damaged metadata produces an in-memory diagnostic view, leaving the
original bytes untouched. Recognized chunk filenames/digests allow raw recovery
without asserting a known epoch/date/source mode. Interrupted length is an
estimated lower bound from durable checkpoints; complete decoded recordings keep
their terminal duration. Composition uses relative nominal cadence buckets to
avoid repeatedly rejecting near 30 fps input timestamps with small clock jitter.
Optional cloud recording identity is initial immutable metadata only; upload
ownership remains with the separate UI/protocol lane.

Original C3 readiness refinement (2026-10-12): initializing a canvas/worker does
not establish a usable composed input. The worker signals readiness once, after
the required screen/camera inputs have produced frames, the draw has succeeded
and the first generated-frame write has completed. Only then does the coordinator
allow a recording epoch and recorder starts. Source ending or composition error
rejects this preflight immediately, while a ten-second deadline bounds missing
input. A released session cannot escape through a late ready message. Actual
recorder start offsets remain measured; this barrier does not guarantee encoder
warm-up or resolve the sustained native-input stall. A delayed-camera fixture and
both protected Chrome versions must validate its effect without relaxing drift
or duration assertions. No additional long-lived frame observer is introduced.

Original maximum-boundary refinement: the ten-minute ceiling stays strict in
manifest validation, upload reservations and provider-measured duration. Automatic
stop is scheduled 200ms before that ceiling, within the protected 250ms target
tolerance, to leave bounded scheduling/codec headroom. A dedicated active-time
deadline is rearmed across Pause/Resume and cleared on release; worker-frame and
periodic checks remain redundant safeguards. Actual elapsed metadata is never
clamped. If a delayed/frozen event loop still exceeds the hard ceiling, the saved
take is interrupted with an explicit timing warning rather than cloud-eligible
complete. This does not guarantee a deadline on a frozen page or substitute for
the full ten-minute/background proof. Short test ceilings scale this headroom.

Startup/Pause ownership refinement: a take may be paused while the initial
recording checkpoint is still saving. The periodic source-health watcher belongs
to the live take, including that paused state; its callback only acts while
recording. Install it after the checkpoint if the take has neither released nor
begun ending. Pause suspends active-time deadlines and Resume rearms them, without
losing or duplicating the watcher. Release always clears it. A regression holds
the real initial save, pauses before start resolves, then checks resume and
terminal cleanup at the timer boundary.

Cancellation completion refinement: setting a MediaRecorder inactive synchronously
does not establish delivery of its final asynchronous data/stop events. One shared
cancel completion is claimed before notification; cancellation suppresses later
discarded bytes. Stops, source/worker release and timer cleanup happen immediately,
then existing terminal-event promises for successfully started recorders are
awaited with the15-second bound. Never-started slots cannot supply a stop event.
Repeated callers join the same completion. Existing in-flight Stop, storage queue
cleanup and draft removal remain joined even when encoder confirmation fails;
report that failure after cleanup. This is an observable event boundary, not a
claim that all native GPU resources are freed. It is not an established cause or
cure for the observed104ms calibration spread after a preceding canceled take.
Keep the original calibration as the first capture in its shared browser process.
