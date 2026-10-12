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

## Implemented surfaces

Both wave-zero seams now have implementations. Capture records source-only screen
and camera videos, distinct microphone and available tab-audio recordings, and
one composed WebM/VP8+Opus file. Screen-only/camera-only/silent combinations are
supported without adding nonexistent tracks. Window processor/generator streams
feed the worker; the worker has a one-frame source queue, retains only its latest
screen frame, and awaits writes. Production composition does not use animation
or interval callbacks. Controls retain a common epoch, start event offsets,
wall-clock pause intervals, effective recording duration and source/error events.
The bubble moves in composed pixels and its changes are encoded in the video.

OPFS writes close and verify digests before descriptors/checkpoints. Saves merge
newer committed descriptors so a stale caller cannot erase chunks. Reload scans
closed chunk files, reconstructs missing journal entries, reports gaps/corruption
and marks an unfinished unleased take interrupted. It neither deletes corrupted
bytes nor reacquires devices. A live-tab lock prevents false recovery and deletion
from a second tab. Optional folder chunks and checkpoints close separately.

All source clones, granted source tracks, preview tracks, worker and audio nodes
are released on stop/cancel/constructor/start failure. Source/encoder/quota/write
failure uses interrupted finalization and preserves acknowledged local bytes.
Final onCheckpoint precedes the terminal onState callback, including automatic
source-ended/max-duration stops. Encoder, queue, read and checkpoint deadlines are
finite; total process memory and suspension behavior are separate measured gates.

## Verification scope and retained failures

Runtime observed: Node 22.22.0, macOS 27.0 build 26A428, isolated headless installed
Google Chrome 155.0.8059.39. No real camera, microphone, screen permission, logged-in
profile, shared GUI, upload or provider account was touched in this slice.
`npm ci --prefix browser` exited 0 (32 packages; audit 0 vulnerabilities).
`npm --prefix browser run build` exited 0 (TypeScript and Vite).
The clean scanner's first line is 0 for all owned source/tests/design paths.
`git diff --check` exited 0. Root owns notices, shared configuration, merged gates,
CI, provider provisioning and independent acceptance.

The initial six-case run failed the 150 ms offset assertion because the epoch was
set before OPFS creation. Moving epoch after draft creation removed that setup
latency from timing. An initial decoded amplitude calibration found~177 ms middle
mismatch from the default compressor envelope; an equal-gain direct mix removes
that effect and keeps summed source peaks bounded. A later fixture whose pattern
changed during Pause exposed a~160–180 ms transient/resume edge ambiguity. A full
25 ms video-edge trace measured later real corresponding edges~37–59 ms apart.
The final decoded calibration pauses its pattern while live streams keep flowing,
and checks corresponding markers at beginning/middle/end with a ≤100ms gate,
including screen/camera originals corrected by their stored start offsets.
This is not proof of arbitrary resumed-content lip sync. The earlier failure
logs and complete edge traces are preserved in the private capture proof folder.
No gate was widened to make that residual disappear.

The first clean scanner flagged a common canvas width/height assignment in a
fixture as a fingerprint match. The independent original expression was rewritten;
no forbidden source was opened. Final scanner result is 0.

The suite exercises actual Chrome MediaRecorders, real transferable worker
streams, decoded video pixels/audio frequencies, pause/resume, rapid repeated
Stop/final chunks, Stop while paused, cancel, missing audio, source ending, encoder
error, OPFS reload/checkpoints/hashes, journal-gap retention, digest corruption,
quota failure, closed backup writes, backup-close failure and cross-tab ownership.
Folder tests use a second OPFS directory as a FileSystemDirectoryHandle fixture;
actual external-directory kill durability is a root physical test.

Remaining independent M1 coverage: 600-second take with ≥5 pauses, actual maximum
memory/chunk rates, real picker denial/cancel and OS permissions, Windows and prior
Chrome major, offline 5 minutes, page background/minimization/freeze/discard, abrupt
browser process kill and physical chosen-folder read-back. Playwright's default
headless flags relax background throttling; these foreground fixtures establish
none of those background/frozen claims. Interrupted assembled bytes are retained;
playability is attempted but never guaranteed for an incomplete encoder tail.

## Final slice command result

On the final implementation, `npm --prefix browser run test:capture` exited 0:
10 tests, 10 pass, 0 fail, 46.240 seconds. The decoded calibration measured
composed drift +19.688/-8.438/+42.188 ms and original screen/camera absolute drift
at most 47.813 ms across its beginning/middle/end sample points. The complete log
is `~/.goal-loop/loom-clone/host/2026-10-12-browser/capture/rushes-capture-release.log`.
The final build exited 0; the explicit clean scan's first line was 0; whitespace
check exited 0. These are slice observations, not an independent M1 release verdict.
