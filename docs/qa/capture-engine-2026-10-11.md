# Capture engine QA — 2026-10-11

All real capture used isolated `/tmp/rush-capture-qa/recordings` and socket
`/tmp/rush-capture-qa/control.sock`. No user recordings overwritten.

## Actual device evidence

- Permissions read native granted screen/camera/microphone/accessibility/input
  monitoring states. Default camera: external HD Pro Webcam C920; default mic:
  MacBook Pro Microphone. Built-in camera produced no frame; now times out after
  three seconds and warns instead of blocking recording forever.
- Real all-track take `01M4P6VE62QFYN8D6PHY0R7K0E`, duration 60,038 ms. Screen,
  camera, mic and system audio all finalized; all four pass full decoded-payload
  verification (none skipped). Received 1,385 real JPEG preview frames over socket.
  Screen/camera/mic/system dropped count 0. Microphone was muted for five seconds;
  media 11–14 seconds measured -91 dBFS mean/max, with full track duration retained.
  The requested microphone was already near digital silence outside mute, so
  this measurement alone does not prove an audible-to-silent transition. Synthetic
  sine-wave mute regressions independently establish that behavior.
- Real pause take `01M4P6Y1PRRF79E8TC0M4SPMWY`: 60 seconds wall time with pauses
  at 10–20 and 30–40 seconds; final media 40,033 ms. All four decoded payloads and
  durations verify within the standard 50 ms tolerance. Drop counts 0; intentional
  paused samples are separately reported as suppressed (449 camera, 1,876 mic,
  1,000 system audio). Input now uses the same shared pause clock.

**The screen above was mostly static and contained only five frames.** That proves
its pixels and duration metadata, not continuous playable screen footage or
moving-content capture. Read-only review found seeking could fail in the empty
intervals. The new periodic writer heartbeat emits cached screen pixels at 60 fps,
with time-limited keyframes, and a synthetic seek regression covers a static
three-second take. The post-fix real moving-window control below establishes moving pixels and
continuous seeking on the repaired native path.

## Post-fix screen-only positive control

Root authorized only screen-only QA while the webcam remained paused. Helper
`tools/qa/moving-screen-control.swift` read IOHIDSystem idle **3.4152495 seconds**
before showing its 180x120 point nonactivating panel behind the user's windows.
No application activation or keystrokes. Recorded only `window-1100` with explicit
camera:none, mic:none, systemAudio:false, selftest:true, duration:10.

Actual package `01M4P7ZB5S4F7FN8SS53TZ3JCC` is under
`/private/tmp/rush-capture-qa/screen-only/2026-10-11_15-45-27_01M4P7ZB5S4F7FN8SS53TZ3JCC`.
Its HEVC screen.mov is 360x240, 10.016667 seconds, 594 encoded frames, 593 decoded
frames, 406 distinct decoded hashes, zero dropped frames. Full decoder verifier
passed. Exact ffmpeg seeks at one, five and nine seconds each produced a PNG;
visually reviewed them: moving square positions differ and the labels advance
from Rushes QA14 to QA54 to QA94. This is actual ScreenCaptureKit window capture,
not synthetic sample injection; its captured subject is an intentionally generated
native test window. The webcam and both audio sources remained closed.

Real sync runs were red. First native flash was not captured. A later run found
a pre flash at 2,570 ms; the stereo audio envelope falsely placed its 2.5-second
tone at 5,001 ms and missed the post tone. Decoder now counts channel groups as
media frames; the original timed sync fixture now uses stereo to verify the fix.
Flash detection no longer treats arbitrary low-contrast movement as a test flash.
No latency value was invented or stored from incomplete measurements. Final real
sync remains unverified.

## User steering and stopped hardware

User reported webcam behaving oddly; root paused webcam/device testing. At receipt
our engine PID 86360 reported idle. `camera.preview.stop` returned ok; the verified
owned engine was gracefully SIGTERM terminated and `kill -0` confirmed absent.
No camera/audio capture started afterwards. Root separately authorized the
10-second screen-only control described above. All test footage remains.
30-second kill/recovery, five physical hand claps, USB-camera unplug, fresh-account
onboarding and 60-minute soak remain unverified; the parent owns integration soak.

## Defects fixed and local gates

Initial real take crashed: activeFormat mutated without lockForConfiguration.
Next take wrote no samples. Retaining ScreenCaptureKit outputs and running a
native event loop restored screen/audio sample delivery.
Input had a separate immutable clock and no heartbeat scheduler. PCM buffers with
one-nanosecond timestamp overlaps were dropped, shortening 60-second mic audio to
40 seconds and system audio to 50 seconds. Exact writer end time fixes camera
overshoot. Socket close could close an unrelated reused file descriptor; close is
idempotent and waits for in-flight reads after shutdown. The test fixture now
allocates a reserved descriptor with F_DUPFD rather than clobbering a parallel
file with dup2. Synthetic catalog and owned-process cleanup keep headless tests
from touching live devices or killing another worktree's test engine.

Maker checkpoint `0fd67c3`: check.sh 179 tests / 27 suites passed, clean-room 0,
three clean-room checker tests and four notice checker tests passed. Follow-up
CFR heartbeat/stereo-source/teardown fixes pass an offline suite of 181 tests. Release build
succeeded. Synthetic tests are not counted as real capture evidence.
