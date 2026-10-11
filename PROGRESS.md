# Rushes integration progress

2026-10-11: Continued saved ZCode Loom-clone session in Codex. Central issue openbrain-v05d; authoritative plan docs/PLAN.md; current goal-loop run /Users/dave/.goal-loop/loom-clone/20261011T190538Z-p47025-0.

Integrated: recovered selftest checkpoint, strengthened source/licence gates, package path/empty/decode checks, rapid-take full-ULID naming with legacy lookup, desktop shell first checkpoint, export/edit module and independent process/export probes. Transcription design/services are being integrated from their verified lane.

Verified in component lanes: see goal result JSON and docs/design files. This status does not assert the assembled app works. Real capture currently under repair in the capture lane; root waits for its stable checkpoint before installed-app QA. Cloud account selected by David; Cloudflare R2 activation required (API10042), no external resources created.

Unverified: assembled command routing/jobs, native packaged recording/playback, independent final export/process probes, multi-width UI, full60minute soak, real cloud deployment. First unfinished step: merge native transcript/capture final commits and wire one engine command table.

## Capture lane checkpoint history
Historical checkpoint below is superseded by later capture evidence; camera testing remains paused.

REAL evidence update: retained SCStream output delegates and native application
runloop restore capture callback delivery. External default HD Pro Webcam C920,
screen and both audio sources produced a complete 60s take. Verifier found audio
shortening by 20s/10s due to sub-sample nanosecond rounding overlaps dropping real
PCM buffers. Corrected overlap snapping and added explicit AVAssetWriter end time
to prevent camera duration overshoot. These fixes await rerun. Built-in camera
never produced a frame (lid status unknown); warm-up now fails with a warning after
3s. Added command contracts, shared input pause clock, heartbeat, permission checks,
countdown events, bounded camera preview, mute, restart/discard, area/cursor/bubble.

Current checkpoint gate: scripts/check.sh passed 175 tests in 27 suites plus
three clean-room checker tests, four notices checker tests, and source scan0.
Native socket descriptor lifecycle now idempotent and retains descriptors through
blocked readers; regression proves double-close cannot close a reused file fd.
Diagnostic catalog prevents synthetic tests from touching real devices. Root
package/full-decode/path/collision prerequisites incorporated. New CLI on-demand
launch regression is running (isolated synthetic roots only).

Maker checkpoint verified: check.sh179 tests/27 suites pass, clean-room0, checker3
and notices4 tests pass. Includes explicit camera loss end-time metadata guarded
by verifier, silent microphone meter, App Nap/idle sleep activity, maintenance
silence filling and low-disk stop. Pause suppression is distinct from lost frames.
CLI on-demand startup isolated synthetic regression passes. Actual final battery
still pending; 60minute soak belongs to parent integration.

User paused webcam/device tests after reporting webcam behaving oddly. At receipt
own engine PID86360 was idle; camera.preview.stop acknowledged, then verified
owned engine gracefully terminated; kill-0 proves absent. No devices reopened.
Final REAL60/preview and REAL pause60→40 passed full4-track decode/duration checks,
but sparse5-frame static screen was not enough to prove playable screen footage.
Strengthened static heartbeat to60fps with bounded catch-up and seek regression.
REAL sync red; stereo audio envelope doubled media time, now fixed with stereo
regression. Real crash30, clap, unplug, fresh-account onboarding/60m soak pending.
Native binary uses stable copied QA path for any future authorized capture.

Screen-only positive control authorized by root under webcam pause is GREEN:
actual moving180x120 native window behind user work, IOHID idle3.415s before show,
no keys/activation, camera/mic/system explicitly off. Package01M4P7ZB5S4F7FN8SS53TZ3JCC:
10.016667s,594encoded/593decoded,406uniquehashes,0drops, exact1/5/9s PNG seeks.
Visually checked positions differ and labels14/54/94 advance. Full decode passes.
Final targets/preflight permission gating now prevents unasked screen catalog API
calls, including camera-only takes; tests running. CLI cameras without explicit
preview now close atStop; explicit close awaits native session shutdown. Camera
selection/cancel generation prevents reopening after checkbox cancellation.

Final namespace/bubble followup:183/27 suites passed (live catalog gatedoff),
clean0/checker3/notices4. Screen-request marker is scoped per signed shell bundle
or bare executable, so QA request history cannot misclassify fresh app onboarding.
record.bubble optional sizeFraction valid0<f<=1 added; old pointsize+center preserved.
Root assigns60m SCREEN-only main-display soak; explicitly no camera/mic/system.
Native footprint utility successfully measured physicalfootprint14680928B on idle
ownscreenengine PID16316; aggregate JSON756B, not a memory-content dump. RSS will
also be recorded as a proxy. Fullall-track soak deferred under webcam pause.
