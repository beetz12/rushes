# Generated audio startup

The native-reference fixture must observe real PCM before native video exists.
Its1000ms first-packet wait, natural sample coverage, strict Stop crossing,
100ms decoded sync including uncertainty and250ms continuity limits stay intact.
A completed prepare step is not proof of physical capture or sample playout.

Generated test audio has no speaker output requirement. Use Chrome's documented
AudioContext silent sink at construction, preserving the prescribed48000Hz for
the native-reference source and existing waveform/ordinal behavior. The ordinary
Canvas/tone fixture, production device capture and decode-only contexts retain
their existing configuration. Native-reference setup refuses a
runtime that ignores the silent selector; it must never silently use a hardware
output. Missing PCM still fails instead of synthesizing data or delaying video.

Before cleanup, retain context state, advancing time, selected sink, source-track
state and bounded witness progress in a startup failure. Keep the original error,
then independently retire witness, tracks and context. Do not log PCM samples.

The historical timeout has no saved startup state. A later locked-host sample
does not prove its cause. Fresh default/silent output probes both delivered actual
finite PCM; this was a non-reproduction. A server-instrumented second pair verified
independent rendering and the actual silent selector. The silent sink changes
both physical-output dependency and callback scheduling, so new media evidence
needs its own source identity and cannot borrow earlier timing qualification.

A causal source control models an unavailable physical output: old actual fixture
setup fails, silent setup succeeds. A second control refuses an ignored selector;
existing missing-PCM and ordered-admission controls remain. Actual browser runs
must still observe samples within the original deadline and pass all saved-media
and retirement assertions. No retry, sleep, timestamp correction or limit change.

Primary references: Chrome's AudioContext sink documentation
https://developer.chrome.com/blog/audiocontext-setsinkid and pinned Chromium155.84
renderer_webaudiodevice_impl.cc/NullAudioSink. They describe a supported test
configuration, not the cause of the old intermittent failure.


The first broader prototype also changed the ordinary tone generator's implicit
rate context. Its full suite failed the existing mixed-tone amplitude and100ms
edge checks. That change was reverted to the exact baseline; no predicate moved.
The selected native-reference path has an explicit48000Hz rate and keeps its own
fresh timing qualification requirement. Auxiliary setup already owns video before
audio validation, so failure cleanup independently retires that source as well.
