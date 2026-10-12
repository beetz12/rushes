# Desktop controls implementation

Owned checkout: `/Users/dave/Work/rushes-desktop-controls`, branch
`codex/rushes-desktop-controls`, implementation base `766434f` (contract on
release base `853ff16`). Central issue `openbrain-v05d.1` remains root-owned.

## Changes

- Added **Camera only** alongside the three screen source choices. It enables a
  selected/default camera, leaves the microphone selectable, disables system
  audio, and sends no display, window, area or cursor arguments. A screen grant
  is unnecessary in this mode; camera access and an enabled camera are required.
  Native `targets` can list camera/microphone devices without a screen grant, so
  the renderer now requests that catalog for camera-only setup too.
- Added an explicit **Export output** choice between one combined file and
  separate original files. Separate uses the existing `editor-tracks` exporter
  and original timing/edit sidecars. Its copy explains that originals retain
  their full camera background and audio and that edits apply to combined
  exports. The existing top-level separate-tracks shortcut remains available.
- Moved idle camera warm-up lifecycle into a serialized shell coordinator.
  Restored selected cameras warm when the recording window becomes visible or
  is reopened; changing cameras clears stale frames immediately, publishes only
  after the current warm acknowledgment, and suppresses old callbacks after
  Off, hide, navigation close, recording takeover or disconnect. It checks an
  already-granted camera permission before automatic acquisition. Explicit
  camera choices remain the permission-request path.
- Generated original 70 ms sine countdown chirps in Web Audio, with 8 ms soft
  attack, gain 0.08 and a higher final tick. Sounds follow deduplicated native
  positive countdown events, rather than a renderer timer. Zero, cancel,
  failure, stop, recovery and unmount cancel queued/current sounds. No Apple or
  third-party sound assets are used. A startup fence also prevents Cancel/Stop
  during pending idle camera cleanup from later issuing native Start.
- Minimize visible recorder/library/settings windows once at the native
  `recording-started` gate. Failed/canceled startup, preparing/armed responses,
  pause/resume and recovery do not minimize them. The floating control bar and
  recording camera bubble retain their separate lifecycles. Explicitly opening
  a minimized main window restores it. Idle minimization closes its preview;
  active minimization preserves the recording overlays.

Declarations remain in `shell/src/shared/contracts.ts`; main and renderer
consume the existing IPC names. Swift, browser/cloud packages, provider settings,
packaging and manifests are unchanged by this shell commit.

## Evidence

Private proof directory:
`/Users/dave/.goal-loop/loom-clone/host/2026-10-12-desktop-controls/build`.

- Node `22.22.0` shell install/build/typecheck succeeded. `build.log` records the
  actual TypeScript and Vite output; no dependencies were changed.
- Complete shell suite: **107 tests in 15 files**, including 23 new focused
  tests for request shaping, preview acquisition/switch/stop/failure callbacks,
  0/3/5-second countdowns, late audio resume cancellation, startup cancellation
  and the real active event versus failure/cancel/recovery/minimize deduplication.
  See `shell-tests.log`.
- `check_clean.py shell/src` final first line **0**; `git diff --check` succeeded.
  The first scan found eight conventional deferred-promise helper overlaps.
  That small independently written helper was rewritten without opening any
  reference source; the initial output is retained as `clean-initial.log`.
- Isolated headless Chrome `155.0.8059.39` rendered the built desktop UI with a
  synthetic `window.rushes` API. The camera-only choice remained reachable with
  Screen Recording denied, microphone stayed selectable, and actual Start
  called the correct camera/mic-only argument object without an Off/On cycle.
  No personal profile, GUI activation, real device or provider was used.
- The actual review **Separate original files** selection called a separate
  private native capture-stub engine's existing original exporter. Generated
  test-pattern/color video and 440/660 Hz audio yielded `screen.mov`,
  `camera.mov`, `mic.mov`, `system.mov`, `offsets.json` and `edit.json`.
  Every original's before/after/export SHA-256 matched. Timing sidecars retained
  camera `+100 ms`, microphone `-120 ms`, and `editApplied:false`.
  `click-through-result.json` contains the exact hashes, files, API calls and
  empty renderer-error list. Switching back to combined invoked `share`;
  combined rendering was mocked in this UI fixture.
- Screens `camera-only-1120.png` and `separate-export-1120.png` were visually
  inspected. The helper script and generated media remain private. The native
  helper received no record or device/permission request and was terminated
  cleanly after the export check. The headless click-through predates the
  additional startup fence and one caption clarification; those changes are
  covered by the subsequent full shell suite and build.

## Remaining integration checks

Root owns fresh independent review, native/release gates, packaging, installation
and physical screen/camera/microphone, audible countdown, bubble and minimization
tests. This slice does not claim an installed-app pass.

A narrow existing native stale-JPEG seam was reported before expanding ownership:
`CameraSource.stopAndWait` drains session/frame work but not JPEG preview work.
Moreover, `SocketLineIO.offerPreview` has a separate pending-frame mailbox whose
write can occur after a reliable new warm acknowledgment. A source queue drain
alone cannot establish transport freshness. Current shell suppression rejects
frames during stale warm-up/stop callbacks; distinguishing a previously queued
old JPEG after a new acknowledgment requires a source lifecycle token carried
in the native preview event and acknowledgment. Exact proposed fields are
`result.previewToken` on `camera.preview.start`, `camera.preview.subscribe` and
`camera-preview`; EngineController owns token generation/publication and shell
main consumes the shared declaration. Root has been given this proposal and
retains the native ownership/approval decision. No native source was edited in
this shell implementation.
