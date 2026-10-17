# Shared browser recording and CI

The browser client owns a take's selected tracks, recorder instances, composition,
chunk journal and cleanup. Permission requests follow the source controls and
Start action. Each original remains separately exportable; the composition has
its own output. Raw acknowledged bytes survive an interrupted take and recovery
never silently resumes the camera or microphone. Failed media stays inspectable.

MediaRecorder start-event offsets describe callback readiness. They do not align
media samples or prove a common source epoch. Generated tests compare actual
decoded markers, supplied PCM and independently observed source timestamps;
unsupported source timing fails qualification. Existing100ms sync including
uncertainty and250ms continuity/duration checks remain unchanged.

The native-reference generated fixture needs48000Hz processing without a speaker
output. It selects Chrome's silent AudioContext sink, verifies the selector and
requires a real first PCM packet within1000ms before video acquisition. Missing
samples are a failure. Startup diagnostics are captured before independently
closing the witness, any pre-acquired video, audio tracks and context. The usual
Canvas/tone fixture keeps its prior audio configuration. This test setup does not
prove physical sensor or speaker timing, or the cause of an earlier timeout.

Local drafts use the browser profile's origin-private file system. Upload, account
and billing UI talks to an optional configured service; configuration and session
discovery also happen at startup. The service's multi-tenant implementation and
provider acceptance seam are excluded from this repository. The shared selector
refuses either private source path, and negative controls exercise that boundary.

The public workflow runs generated checks with named current/previous Chrome
builds on standard Windows and Mac runners. The repository gate also checks
shared dependencies, notices and clean-room inputs. Short/reference/maximum
results remain distinct. Compact one-day CI artifacts omit encoded180s masters;
full raw-media, provider and distribution acceptance are separate requirements.
No deployment, real footage, production credentials or live billing occurs in CI.

This is an original implementation. Chrome's supported silent-sink API is
documented at https://developer.chrome.com/blog/audiocontext-setsinkid.
