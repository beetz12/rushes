# Screen writer gate failure — source evidence

2026-10-12 UTC. The camera repair was integrated at `c11fe4f`; this lane merged
that main tree before the screen-writer correction. The parent owns the installed
application, physical capture and assembled release gates.

## Reported native failure

Only the 3,924-byte metadata log
`/Users/dave/.goal-loop/loom-clone/host/camera-repair/installed-real-capture-1.ndjson`
was read. Take `01M4PYD3R6P0C1NTDZVEE8MVTF` stopped after 251 ms. Camera accepted
eight frames without drops and finalized; both audio writers finalized. Screen
accepted eight frames, dropped two and failed with AVFoundation -11800 and
underlying OSStatus -16364. Its first input was 420v, 3456×2234. The failed status
and retained other tracks were honest. No user pixels, audio or transcript were
opened.

## Reproduction before the fix

The existing warm-up cache bypassed the live-frame monotonic check. A delayed
pre-gate callback after an accepted frame repopulated the cache; the next live
frame appended it at zero again. The second route held encoder readiness at gate
opening, then supplied the first live frame at zero. That real frame was accepted
but the old cache remained available for a second zero on the next callback.

Two exact observer traces from the old source were:

- Delayed callback: `0, 16666666, 0, 33333332, …` ns.
- Busy gate, live zero: `0, 0, 16666666, 33333332, …` ns.

Both schedules reproduced **the exact -11800/-16364 chain** with real AVAssetWriter
on generated 320×240 NV12 frames, for both HEVC and H.264. The native writer first
accepted five frames, then failed. The old regression run had 33 expected failures
across two tests/six cases. Log `/tmp/rush-video-gate-baseline.log`.

This establishes a reachable production defect that produces the installed
signature without a camera, concurrent encoders or the large display dimensions.
Those conditions are unnecessary to reproduce this defect; the parent still
needs physical confirmation of the installed take after the correction.

The opened macOS 27 SDK VideoToolbox header states: “Each presentation timestamp
passed to a session must be greater than the previous one.” See the primary
[compression API](https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionencodeframe(_:imagebuffer:presentationtimestamp:duration:frameproperties:sourceframerefcon:infoflagsout:)).
The opened AVAssetWriter adaptor header documents inspecting writer status/error
after a failed append. No public definition of -16364 was found in the inspected
AVFoundation, CoreMedia, CoreVideo or VideoToolbox headers; no invented symbolic
error name is used.

## Correction and source checks

The first successful append permanently retires the warm-up cache. Delayed
pre-gate frames are discarded and counted after footage starts. Cached-zero
appending is additionally guarded by the absence of accepted footage. A live
first frame at zero supersedes a cache that could not be written at gate opening.
Existing newest-pre-gate-frame behavior remains covered by the writer tests.

The same calibrated gate passed after the fix: two tests/six cases, 1.835 s,
exit 0. Every native case required successful finalization, no error/fallback,
exact source and decoded frame counts, first PTS zero, and strictly increasing
decoded PTS. Log `/tmp/rush-video-gate-fixed.log`. No assertions were weakened.

Broader changed-surface verification passed 47 tests in six suites (3.271 s),
including the unchanged warm-up-zero, pause, static-screen heartbeat, camera
encoding, native time precision and salvage checks. Screen buffer routing also
passed all four tests. Logs `/tmp/rush-video-gate-changed-surfaces.log` and
`/tmp/rush-video-gate-screen-routing.log`. The existing opt-in live test kept its
unchanged disabled gate. `swift build -c release` passed, exit 0, in 31.14 s;
log `/tmp/rush-video-gate-release.log`. Apple Swift 6.4, macOS 27 SDK. The explicit
changed-file contamination scan printed `0` on its first line, unchanged scanner.

The correction changes no codec, timescale, pixel format, heartbeat cadence or
existing media file. No physical devices or GUI/provider services were opened by
this lane. Source checks do not substitute for the installed physical retest.
