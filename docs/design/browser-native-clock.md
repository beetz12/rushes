# Generated browser clock qualification

The supplied-reference matrix needs a native monotonic scalar to exercise its
three generator sentinels. It does not need a camera for that scalar.

Chromium155 and154 define the exact CDP Performance metric `Timestamp` as
`TimeTicks::Now().since_origin().InSecondsF()`:
[155 source](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc),
[154 source](https://raw.githubusercontent.com/chromium/chromium/154.0.8037.92/third_party/blink/renderer/core/inspector/inspector_performance_agent.cc).
The page-scoped sampler requires one finite value, safe microsecond conversion,
a fresh unchanged document, timeTicks mode, and acknowledged session retirement.
An invalid supplied seed never falls back to device acquisition.

The [generator sink](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/third_party/blink/renderer/modules/breakout_box/media_stream_video_track_underlying_sink.cc)
only promotes plausible native timestamps, with the feature enabled. All three
actual pixel, mediaTime, captureTime, frame-count, unit-slope and intersecting-origin
checks remain. Camera acquisition for the real generated1280x720 recording remains.
Removing the scalar helper acquisition also removes its incidental warm-up; old
media qualification cannot be borrowed for the resulting cold recording.

An independent optional native-short trace verifies seven prescribed marks and
actual native callTime values against page call brackets. Performance.now
subtracts two independently coarsened native values
([implementation](https://raw.githubusercontent.com/chromium/chromium/155.0.8059.84/third_party/blink/renderer/core/timing/performance.cc)).
The bracket therefore charges two privacy resolutions. This coordinate proof
adds no tolerance to recorded A/V synchronization and never fits an output offset.
Invalid origins, shifted callTime, feature disablement and invalid seeds fail closed.

PCM observation intentionally begins before native video acquisition. The
source qualifier keeps all of that PCM and its full head/tail coverage checks.
It checks the first ordinal at actual observed video-first presentation+80ms,
using the nearest actual PCM coordinate, and requires the whole spectral window
inside the observed initial optical state. It charges nearest-coordinate distance
in addition to crossed-window discontinuities and conversion uncertainty. The
ordinary file decoder's initial sample anchor remains unchanged. Pre-video silence
is allowed; silence inside the actual initial video state is rejected.37ms
perturbations remain measured;300ms displacement remains rejected.

All existing1500ms clock stages,1000ms first-PCM deadline,250ms source/Stop/media
bounds and100ms including measured uncertainty remain mandatory. Native-short
tracing includes audio callback, WebAudio and media-stream categories, retains PCM
before trace qualification and retires independently on setup or capture failure.
Only existing short qualifications opt in; no180s/600s trace or acceptance waiver.

This is test instrumentation. It neither changes production recording nor
establishes a physical sensor clock, a historical stall cause, or release readiness.
