# Installed recording verification

2026-10-11, America/New_York. Personal signed application at
`/Applications/Rushes.app`; native source `e107c42`.

The initial camera-format correction did not resolve the installed startup
failure. Instrumented takes exposed AVFoundation -11800 / OSStatus -16364 in
either video writer. The same failure was reproduced without devices by
replaying a cached warm-up frame at zero after footage had started. The
regression and correction are documented in `video-gate-races.md`.

After installing the cache-retirement correction, the desktop recording path
completed a 7.844648625-second take. A separate CLI request through the same
installed application's engine completed a 15.086638792-second take with the
normal three-second countdown. Both used the built-in Retina display, MacBook
Pro Camera, MacBook Pro Microphone and system audio. Both had four present
tracks, no capture warnings and successful full decode/duration/offset checks.
The longer take recorded 689 screen frames and 452 camera frames; one delayed
camera warm-up frame was discarded. All tracks start at zero and report zero
offsets. Native screen size was 3456×2234 and camera size 1920×1080.

An independent FFmpeg decode of the first take's microphone produced 376,543
samples with peak 0.088736 and RMS 0.007157, confirming a non-silent microphone
signal. The longer take's on-device transcription completed and the desktop
displayed timed words. Private media and transcript contents stay local.

The longer take's separate-track export produced `screen.mov`, `camera.mov`,
`mic.mov`, `system.mov` and `offsets.json`. Every exported movie matched the
original byte-for-byte; offsets were zero and `editApplied` was false.
Combined MP4 export and separate original-track export are distinct choices.

Evidence lives under `/Users/dave/.goal-loop/loom-clone/host/camera-repair/`:
`installed-user-take-verify.json`, `installed-real-capture-3.ndjson`,
`installed-real-capture-3-verify.json`, `installed-user-microphone-signal.json`
and `separate-tracks-proof.json`. This report contains no captured pixels or
private transcript text.

The assembled source gate passed 319 native tests in 53 suites, five intent
tests, 45 desktop tests, 16 cloud SDK tests, four viewer browser tests and
18 Worker tests. Release compilation and strict deep signature verification
also passed. These short installed tests are not a new one-hour all-track soak
or proof on another macOS version.
