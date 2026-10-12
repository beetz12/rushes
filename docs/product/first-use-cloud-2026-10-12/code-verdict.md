---
node: C1
skill: graph-design
graph: first-use-cloud
run: 2026-10-12
inputs:
  - docs/PLAN.md
  - docs/product/first-use-cloud-2026-10-12/graph.md
  - shell/package.json
  - shell/.nvmrc
  - shell/src/main/index.ts
  - shell/src/main/camera-overlay.ts
  - shell/src/main/onboarding-store.ts
  - shell/src/main/atomic.ts
  - shell/src/main/engine.ts
  - shell/src/shared/onboarding.ts
  - shell/src/shared/contracts.ts
  - shell/src/preload/index.ts
  - shell/src/renderer/main.tsx
  - shell/src/renderer/style.css
  - shell/src/renderer/onboarding-tour.tsx
  - shell/src/renderer/onboarding-state.ts
  - shell/src/renderer/onboarding-state.test.ts
  - shell/tests/camera-overlay.test.ts
  - shell/tests/onboarding-store.test.ts
  - shell/tests/engine-recovery.test.ts
  - Sources/RushCore/Control/EngineController.swift
  - Sources/RushCore/Control/ControlGuide.swift
status: passed
attempt: 2
base: 2639408441fc00b04f14ab3c8ec45ef7a628894d
checked_head: 0394158e2ce2e2a8bdae52a6a510757fcc233f0e
checked_at: 2026-10-12T07:28:45-04:00
---

# Independent code verdict

**Pass for the code gate after bounded repairs.** No remaining actionable defect was found in the reviewed surfaces. This is a source and unit-test verdict, not an installed-app or camera verification. No GUI, camera, provider access, application preferences or shared Beads state was used. N5 must complete the installed checks below before delivery.

## Findings caught and resolved

1. **[P1] Use the actual native new-take event when clearing an idle preview.** Before repair, the main listener at the then-current `shell/src/main/index.ts:1140` closed the existing bubble only on `preparing` from idle. The native `recordStartPerform` first emits `armed` at `Sources/RushCore/Control/EngineController.swift:1059`, then `recording-started` at line 1090; this function does not emit `preparing`. With an idle preview bubble already visible, an external CLI camera-less take could therefore retain that bubble. The later camera-less lookup returned false and merely skipped a new bubble. The required repair was to clear and invalidate the previous bubble at the actual armed/new-take boundary, while preserving a hide choice for that same take, with focused coverage and an installed camera-less CLI check.

   **Resolved:** `CameraOverlayLifecycle.newTake` now handles idle → armed/preparing (`shell/src/main/camera-overlay.ts:18`), and the main listener closes the old bubble and sets the armed take ID (`shell/src/main/index.ts:1140`). The added regression invalidates a delayed idle-preview callback at armed, keeps a camera-less take clear, and avoids treating Pause/Resume or preparing → armed as another take boundary. A source-derived event-handler stub verified old-window closure and preservation of local-start suppression. Installed camera-less CLI behavior remains required below.

2. **[P2] Explicit replay must reset an already-open guide to welcome.** The Library/Settings sidebar calls `api.onboarding('reset')` (`shell/src/renderer/main.tsx:398`). Before repair, the main process broadcast the resulting `unseen` record without its action; `OnboardingTour` responded with `session.load()` at its then-current line 85, and `GuideSession.load()` retained the current step when the guide was already open (`shell/src/renderer/onboarding-state.ts:31`). A user who advanced the unseen guide, switched to Library/Settings and chose Recording guide returned to that old step. The required repair was a revision-safe replay/reset event handler, covering external reset and invalidation of an older pending read. Replaying a dismissed/completed guide already worked because that session was closed.

   **Resolved in 0394158:** successful durable reset broadcasts `action: reset` (`shell/src/main/index.ts:648`); the tour routes it through `replaySaved` (`shell/src/renderer/onboarding-tour.tsx:85`). That method resets to welcome, then uses the existing revision-checked load (`shell/src/renderer/onboarding-state.ts:43`). The new regression verifies already-open replay resets, ordinary focus refresh preserves progress, and read errors remain visible. The revision check invalidates an older pending read. Installed Library/Settings replay still needs checking.

## Repair already checked

The maker repaired the deferred idle cleanup race identified during review: `hideCameraBubble` now captures a generation and checks `sameGeneration` after unsubscribe before sending preview stop or hidden metadata (`shell/src/main/index.ts:420`). A source-derived stub of the actual function confirmed that a newer explicit idle preview survives delayed unsubscribe; the command trace contained unsubscribe and the new start, without preview stop. The added unit regression passes. `record.start` also now closes an existing idle bubble before its native start request, and the repaired armed boundary covers external starts.

## Evidence and limits

Under the pinned Node **v22.22.0**, these commands completed with their own exit code **0**:

```text
cd shell
PATH=/Users/dave/.nvm/versions/node/v22.22.0/bin:$PATH npm test -- tests/camera-overlay.test.ts tests/onboarding-store.test.ts src/renderer/onboarding-state.test.ts tests/engine-recovery.test.ts
# Final run: 4 files, 29 tests passed; exit 0.
PATH=/Users/dave/.nvm/versions/node/v22.22.0/bin:$PATH npm run typecheck
```

The first focused run passed 26 tests before repairs; final rereview passed 29 after the cleanup, armed-boundary and replay regressions. The inspected working tree includes uncommitted main-process changes after the recorded HEAD. SHA-256 identifiers bind the reviewed code to those changes:

```text
21ef21afe0a5e852a13d684e1303c207b5a3e9fd10435767dc9484a3d281740e shell/src/main/index.ts
e12794c2d1b40e0188c083aada5e74210080bde838aa4b816f9d6ae83e3114e5 shell/src/main/camera-overlay.ts
28c1ee907ce3d338dbd33c8c6315e30bddfa86e4002ebf33a850678b5afb60a1 shell/tests/camera-overlay.test.ts
6012d43169907e2ff895a9a4f964b2891b5ae7352271b8bef9c5a4def77dfdda shell/src/renderer/onboarding-tour.tsx
49b9d2666d5800fdabb833dcf3e480430a2f4442b32e93b2fd10a27ba3c5aa80 shell/src/renderer/onboarding-state.ts
26f15dae2659b9aeab63cff1dfa6b561c0b64b684388485d816aa4903dcd5cdc shell/src/renderer/onboarding-state.test.ts
```

Source establishes these properties:

- `cameraOverlay.hide()` invalidates warm-up and take-lookup completions after Stop, recorder idle close/hide, overlay hide, Quit and disconnect. Queued bubble metadata checks take identity and suppression before writing visibility.
- Active overlay hide sends `camera.preview.subscribe {enabled:false}` and hidden metadata; it avoids `camera.preview.stop`. The native subscribe handler only changes preview publication (`EngineController.swift:322`); it does not stop capture. Active camera recording duration and playable frames still require installed verification.
- Idle recorder hide/close runs cleanup; generation checking protects a newer explicit preview. Start requests and native armed states are counted as busy, protecting an active track from idle cleanup.
- The original fresh native status → Stop → fresh idle status shutdown guard remains in `shell/src/main/engine.ts:335`. The recovery tests cover failed Stop, pending finalization, malformed status and reconnect. `before-quit` adds callback invalidation without bypassing that guard.
- Guide choice is stored separately with validated version/status, serialized actions, atomic fsync/rename and private file mode. Restart tests preserve dismissed and completed choices. Failed writes leave the guide available and do not report durable dismissal.
- Renderer mount checks permission status/catalog/status; it no longer starts a camera or requests permission because a saved camera is present. Device preview and permission requests occur in explicit handlers. Completion/skip requests issue no recording command.
- The spotlight layer ignores pointer events while its nonmodal card is interactive; the native controls remain present. Named dialog content, heading focus, Escape skip, local arrow navigation and focus restoration are implemented. Geometry tests cover clipping, missing targets, narrow windows and shrinking around a tall permissions panel. Real focus/Tab behavior and rendered overlap cannot be established by these pure helpers.

## Required installed checks before delivery

1. Fresh temporary app data, plus saved camera preferences: launch without a permission prompt or camera indicator; Skip; relaunch and verify hidden; replay from Library and Settings; Finish; relaunch and verify hidden again. Replay an already-open advanced guide and verify welcome.
2. Complete every guide step at the native minimum **800 × 600** window and normal size. Tab through Skip/Back/Next/Finish and real permission/source/device/start controls; Escape from guide content; use arrow keys only within guide; scroll/resize; verify the card leaves each highlighted control usable and focus returns after dismissal. Check with VoiceOver if available.
3. Explicit idle camera selection: verify live frames; click ×; verify bubble and preview stop. Reopen preview; close/hide the idle recorder; verify camera indicator goes off and no delayed warm-up recreates a bubble. Immediately reopen and select preview during cleanup; the newer preview must remain live.
4. Start a camera take, including countdown/armed state; click × while it is active, continue for several seconds, Stop, and verify the camera original remains playable through the end with increasing duration. Verify hidden bubble metadata does not erase camera footage. Repeat after Pause/Resume.
5. Select idle preview, then start a **camera-less CLI take**. Verify the old bubble closes and no new bubble appears. Start a new camera CLI take after Stop and verify its bubble can appear normally.
6. Stop immediately around native start and delayed take lookup; verify no bubble reappears after Stop. Start a later take and verify the old callback cannot alter its bubble or metadata.
7. Quit during a take and while armed; confirm native finalization and surviving original tracks. In a controlled stub, keep Stop failing or return finishing/malformed status: Rushes must remain running and retain the connection/child, then succeed only after fresh idle.

Installing/building and these behavior checks belong to N5 after the repaired C1 code verdict passes. A passing code verdict alone must not be described as a successful installed recording test.
