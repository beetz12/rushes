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

## Startup checkpoint repair

A folder error can reject create after OPFS already commits. Creation now releases
its live lease on a rejected initial backup. Capture inspects only its own initial
primary manifest after rejection, terminally marks that draft interrupted, and
releases sources. A duplicate-id create uses DRAFT_EXISTS and is never adopted or
rewritten by this cleanup. The regression uses a committed primary draft followed
by an initial folder failure and proves its lease is gone and sources are ended.

The fresh full suite after this repair exited 0: 11 tests, 11 pass, 0 fail. One
intermediate run was invalidated when the maker edited storage during the Vite
fixture, triggering a page navigation; its execution-context failure is retained.
The exact command was rerun with source unchanged, and all eleven cases passed.

## Consolidated independent repair pass

The independent capture verdict at integration 736d0f0 reproduced C1 (source loss
while primary creation was committed but its create promise was pending) and C2
(an initial-write orphan made list() reject, hiding a healthy completed take).
The root/M1 lane additionally supplied stale interrupted duration and jitter-driven
cadence loss observations. This single repair consolidates those four findings:

- Startup rejection directly awaits the owned draft's terminal finalization even
  if source loss already reported failed. The before/after-primary gated regression
  preserves closed chunk bytes, checks terminal disk state/no live lease, and proves
  a second tab can recover/remove it without an extra Stop. DRAFT_EXISTS remains
  protected; unreadable or unrelated metadata is never adopted as this startup.
- Enumeration isolates unreadable/unfinished metadata into diagnostic interrupted
  rows while retaining healthy rows. It indexes recognized closed chunks for raw
  download, reports unknown date/mode/timing/protection, and never rewrites corrupt
  manifests or deletes unknown bytes. Valid-JSON malformed fields, corrupt JSON,
  empty initial-write orphans and unrecognized folder names are covered together.
- Interrupted recovery derives an estimated length at least as large as the last
  durable checkpoint and validated chunk checkpoints. It remains interrupted and
  explicitly labels the estimate/unclosed tail. The actual reload regression checks
  the recovered length against every acknowledged checkpoint; process-kill and
  decoded maximum-take proof remain in the independent M1 lane.
- Relative nominal cadence buckets admit at most one actual input frame per 30 fps
  bucket, preserving timestamps and closing skipped frames. 33,330/33,334 µs jitter
  now retains 300 frames in the 300-frame fixture; 60 fps input is decimated to the
  nominal target without fabricated frames or catch-up bursts. This is cadence
  logic proof; actual long-take frame rate still requires M1's decoded read-back.

Root's authorized shared optional cloudRecordingId seam 053402f was imported
read-only. Capture copies that reservation into its initial manifest; every
checkpoint/final save retains it. No capture-core network request was added.

The final unchanged-source command `npm --prefix browser run test:capture` exited 0:
16 tests, 16 pass, 0 fail, 45.969 seconds on the same isolated Chrome 155 runtime.
The first target regression included an unused synthetic camera feed when checking
screen-only cleanup; its assertion was corrected to the actual granted screen and
composed preview tracks. The original failure log is retained. The clean scanner
also flagged a generic finite/nonnegative predicate as a source fingerprint; its
independent control-flow form was rewritten without opening the reference source.
Final explicit scanner first line 0; acceptance thresholds remain unchanged.
