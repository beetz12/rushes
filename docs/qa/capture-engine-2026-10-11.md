# Capture engine QA — 2026-10-11

All real capture used isolated roots and sockets under `/tmp/rush-capture-qa`.
No user recordings overwritten. Each test's scope and root are identified below.

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
30-second actual all-track kill/recovery, five physical hand claps, USB-camera
unplug, fresh-account onboarding and the full all-track 60-minute soak remain
unverified under the user's webcam/device pause. Screen-only endurance evidence
is below; it does not replace the full all-track battery.

## Actual 60-minute screen-only endurance take

Root authorized main-display capture with explicit camera:none, mic:none and
systemAudio:false. Copied release `09a383e`, PID 48464, socket
`/tmp/rush-capture-qa/soak/control.sock`, started 15:58:17 ET. Actual package
`01M4P8PVHSZZVNW5YPHVT4EDP4` remains preserved at
`/private/tmp/rush-capture-qa/soak/recordings/2026-10-11_15-58-17_01M4P8PVHSZZVNW5YPHVT4EDP4`.
No new camera or audio capture occurred. Minute-by-minute CSV and native footprint
JSON are in `/tmp/rush-capture-qa/soak`.

| Minute | UTC sample | Physical footprint bytes | RSS bytes (proxy) | Written frames | Writer drops |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | 19:59:17.878327 | 15,041,376 | 51,085,312 | 3,044 | 2 |
| 5 | 20:03:17.882048 | 14,287,712 | 50,397,184 | 14,757 | 9 |
| 60 | 20:58:17.905879 | 17,613,664 | 47,644,672 | 173,132 | 158 |

Native `/usr/bin/footprint` measured physical footprint, with its output units
checked as bytes; RSS is separately labeled as a proxy. Minute 5→60 growth
3,325,952 bytes (3.17 MiB) passes the 50 MiB budget. Minute 60 writer drop rate
158/(173132+158)=0.0912% passes the 1% writer-counter budget. Pending depth 0,
no writer errors. Counts are not a claim of measuring every native display refresh.

The MOV finalized normally: status complete, no warnings, firstSampleNs 0, HEVC
3456x2234, size 7,266,105,349 bytes. Manifest duration 3600.078797833s; ffprobe media
duration 3600.078333s, deviation 0.465ms, start 0. The previously inferred 3840x2160
was incorrect for this take; actual source display-1 uses 1728x1117 global points
with 3456x2234 backing pixels.

**The original end-to-end Stop test failed.** The caller's record.stop timed out
after 180s because EngineController.finish awaited full decoded-payload verification
of the entire one-hour file before returning. Manifest/media remained complete,
and PID 48464 gracefully terminated. Parent moved this validation into a durable
background job and owns assembled/installed Stop response validation. The original
failed run remains `/tmp/rush-capture-qa/soak/failure.json`; no fake verified stamp
was written, and native PackageVerifier did not complete on that run.

Independent saved-file FFmpeg VideoToolbox full decode completed with exit 0 and
progress=end: 173,133 decoded frames, no input decoder errors. The declared 173,134
versus decoded 173,133 count is consistent with end-time trimming previously seen
in the ten-second control. All 2,971 null-output DTS timing warnings are preserved;
the original MOV selected timebase 1/600 and close input PTS can coincide, while
null output further quantizes at nominal 60fps. These warnings are not hidden or
treated as corrupt input decoding. Exact seek 3595s returned a frame, MD5
`b8c2f9201d63d60faa67e6ed0579d256`. Evidence: `probe.json`, `decode.progress`,
`decode.log`, `tail-seek-md5.log`, and `independent-final.json` under the soak root.
The source movie is unchanged. Capture slot returned after decoder completion;
no test engine or physical camera session was left active.

## Precision and control follow-ups without physical capture

Future video files use AVAssetWriterInput.mediaTimeScale 1e6. Candidate 1e9 failed
actual HEVC and H264 MOV finalization with a sparse sixty-second gap. Supported 1e6
passed both native codecs: decoded PTS 0, 100000ns, 59.98s, 60.02s remain exact/distinct;
duration 60.04s within 50ms, full reader completes, stale-manifest recovery preserves
movie bytes, strict package verifier passes. Audio keeps its native clock. These
are synthetic pixel fixtures through native encoders, not physical capture.

Targeted checks also passed drawing-window ownership/title/mode restrictions,
five-second Trash expiry/collision/symlink protection, late preview subscription,
disconnect camera leases, stale raw JPEG suppression and mic PCM media-clock
forwarding across mute/pause. Native Trash API smoke moved/restored only an owned
text fixture and verified its bytes. Read-only display geometry matched current
1728x1117 points with 3456x2234 backing dimensions; no UI or devices opened.

The heartbeat now applies only to idle screen video. Camera callbacks continuously
supply real frames, and a synthetic delayed-camera-PTS regression proves that a
wall-time tick cannot move ahead of a genuine camera frame. The two native H264
clock fixtures now feed at the declared 60fps cadence, retaining their exact PTS,
frame counts, pause remap and assertions. Dedicated burst backpressure tests remain
unchanged. Five targeted clock/heartbeat/timescale tests passed in two suites;
these changes have no new physical camera QA under the pause.

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
Static-heartbeat/stereo-source/teardown fixes passed subsequent offline gates. Release build
succeeded. Synthetic tests are not counted as real capture evidence.
