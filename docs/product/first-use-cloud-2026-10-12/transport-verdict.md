---
node: C1r
skill: prompt
graph: rushes-first-use-cloud
run: 2026-10-12
inputs: [docs/product/first-use-cloud-2026-10-12/graph.md, docs/product/first-use-cloud-2026-10-12/transport-debug.md, shell/src/main/engine.ts, shell/src/main/index.ts, shell/src/renderer/main.tsx, shell/src/main/camera-overlay.ts, shell/tests/engine-recovery.test.ts, shell/tests/engine.test.ts, shell/tests/camera-overlay.test.ts, shell/package.json, shell/src/shared/connection-error.ts, shell/tests/connection-error.test.ts, shell/src/preload/index.ts, Sources/RushCore/Control/ControlServer.swift, Sources/RushCore/Control/EngineController.swift]
status: passed
target: N2r transport recovery
attempt: 1
base: 8ce98e26e3ddc58f492ffbdc2e69a48f8aebedcf
---

## Attempt 0 — failed, retained evidence

The original verdict header recorded `status: failed`, `attempt: 0`. Its findings, measurements and checked input hashes below remain unchanged. The current verdict is the appended repair-1 assessment.

Independent source and socket-fixture check failed. The ordinary focused suite passes, but two recovery failures reproduce against the checked source. Installation remains gated on repair and a fresh check; this verdict does not certify the installed application.

## Findings

1. **P1 — A newer native event is overwritten by the recovered snapshot.** `shell/src/main/engine.ts:205–212` awaits status and then unconditionally assigns its snapshot. `EngineClient.ingest` resolves responses and continues emitting events from the same packet before the recovery promise resumes. A real Unix-socket peer sent `{state:"idle"}` followed immediately by `recording-started` for `new-take` in one NDJSON packet. Observed event order was `recording-started`, then `engine-reconnected` with idle; final `active` was false. Main's recovered-idle branch closes bar/bubble/teleprompter and renderer accepts idle, despite the newer take. Track a state/take revision around the status request and obtain a newer status when events intervene; do not apply a superseded snapshot. Add the same-packet regression and its inverse (recording snapshot followed by Stop).

2. **P2 — Verification failures do not retry while the transport stays connected.** `shell/src/main/engine.ts:185,198,205–209` calls `scheduleRestart` after failed status verification, but its connected guard returns. A real peer returned `unknown` for recovered status and kept the connection open. After 4.3 seconds the supervisor had made one status request, emitted one recovery failure and no recovery success, retained stale active=true, and stayed connected. Rejected or timed-out status has the same control path. Distinguish verified recovery from transport connection and retry verification/connection safely within the three-attempt limit; retain active/no-spawn protection throughout. Test invalid status, rejected status and timeout, then a valid follow-up, without requiring another disconnection.

3. **P2 — A previous take's hidden-bubble choice can suppress a different take recovered from offline.** `shell/src/main/index.ts:1136–1141` replaces `currentId` without reconciling `bubbleSuppressed`; `showRecordingBubble` returns immediately when suppression is true. If A was hidden, then A stops and B starts while disconnected, recovery of B preserves A's suppression because both missed event paths that normally clear it. Compare previous and recovered recording IDs; preserve suppression for the same take and clear it for a proven new take. Also invalidate pending overlay work when identity changes. Add a control for same-ID reconnect staying hidden and different-ID reconnect opening the camera bubble when that take has a camera. This finding is source-path analysis; the checker did not drive GUI or devices.

## Executed checks

Runtime: `/Users/dave/.nvm/versions/node/v22.22.0/bin/node`, verified `v22.22.0`. Commands ran from `shell/` with that runtime first in PATH.

- `npm test -- tests/engine-recovery.test.ts tests/engine.test.ts tests/camera-overlay.test.ts`: exit 0; 3 files, 25 tests passed, 5.29 seconds.
- `npm run typecheck`: exit 0; TypeScript reported no diagnostics.
- Independent in-memory esbuild import of the checked `engine.ts`, exercised through fresh temporary Unix sockets; no source/test file edited, no actual engine launched. Both negative controls above reproduced; injected launch count was zero. Harness exit 0 confirms the assertions that the defects exist, not product success.

The supplied tests establish same-engine active reconnect, missed Stop reconciliation and successful budget reset across four independent outages, bounded connection failures, split/out-of-order transport, stale old socket/child protections, queued-restart cancellation on Quit, failed-Stop preservation and deferred overlay invalidation. They do not cover failed status verification or snapshot/event interleaving during reconnection.

## Installed acceptance still required

After repairs pass the independent source check, build/install the exact checked revision and record its running artifact identity. During a real camera take, interrupt only the Electron peer connection without terminating the native engine or writers. Require the same native PID, restored status/Stop controls, no extra engine, cleared stale frames and preserved original media. Check same-take hidden bubble stays hidden; a new camera take encountered after an offline Stop does not inherit the previous take's suppression. Check offline Stop becomes idle and closes stale overlays. Trigger Quit with recovery queued and in flight; a failed Stop must keep the native engine/app alive and a completed Quit must not regenerate overlays or reconnect. Verify final original tracks decode. A fresh CLI response alone does not establish recovery of the Electron peer.

The debug note distinguishes native crash from lost peer connection and labels preview/menu backpressure as an inference. This checker did not open private installed evidence, so those observations remain attributed to N2r, not independently remeasured here.

## Checked SHA-256 inputs

| File | SHA-256 |
|---|---|
| graph.md | b63d35393f796ef97e08693ced095d64e848698ca9973fb72a2fdd8db2ad78bb |
| transport-debug.md | 11d5c36307d13288b66cc8fbf93971c7e8bbe475298af804708b306027312c16 |
| shell/src/main/engine.ts | 0601647d34b08b4158f34fb675f827770693e1827342094afdd77cede6a1942d |
| shell/src/main/index.ts | 02230d88557aad534be4ffbb62e5f46b95ddf27150ac0471e82eddf75f81efb7 |
| shell/src/main/camera-overlay.ts | e12794c2d1b40e0188c083aada5e74210080bde838aa4b816f9d6ae83e3114e5 |
| shell/src/renderer/main.tsx | ecb56553c262ea382d429a23a93bc359cdafaa03728bf7c1aacc6076f3b45588 |
| shell/tests/engine-recovery.test.ts | 560ea8d20c0f4d14b31ad8b63f237a0a1449c432b7109f8f28a918898476588d |
| shell/tests/engine.test.ts | 4c59fcbf72e7963db0dca594e601872565b5025e7b87b81fe32b522eb18f64ad |
| shell/tests/camera-overlay.test.ts | 5b36e86b3af75efd9aad688d2e2005bc3ef578d451af56199493280ccd745f1d |
| shell/package.json | 7bb3bb3a00c4c5c3851a810178e4465cc12a6a79ca3db73df0c25347fe418536 |

Only `transport-verdict.md` was written by C1r. This failed attempt must be retained when a repair attempt is assessed. The maker has at most two repair retries under the graph stop rule.

## Repair 1 — passed

The final source and controlled socket verification pass. No unresolved finding remains within the declared transport-recovery scope. This permits N5 to build and test the installed application; it does not certify installed behavior or override the graph's required build/native/installed gates.

### Findings resolved

- Recovery captures a native state revision before each status request, rereads when a capture event intervenes, and limits rereads to three. Both idle reply → newer recording-started and recording reply → newer recording-stopped now recover the final state instead of overwriting the event.
- Failed verification closes the unverified connection before scheduling another attempt, preserving cached active state and the three-attempt limit. Invalid/rejected/timed-out status can now be retried without another externally caused disconnection; the active path never invokes the process launcher or Stop.
- `recoveredBubbleHidden` preserves a hidden bubble for the same known active take, clears it for a different take or an idle/preparing result, and main invalidates pending overlay work when recovered identity changes. Existing generation/take/active/Quit guards remain on asynchronous bubble creation.
- Quit increments a lifecycle revision, clears a queued timer and suppresses an in-flight recovery's result. The failed-Stop path retains the connected client and native child for a retry. A new recovery is queued after failed Quit only when the client is disconnected.

During this reassessment the checker also found that a transient recovery failure could leave a red error after successful reconnection because the renderer matched message text. Before the final verdict, the maker changed recovery cleanup to machine-code provenance and preserved error codes in the tray control helper. The latest code passes the checks below. Unknown, recording, permission and ordinary request-timeout errors remain visible; a later unrelated message resets the prior connection tag and cannot be accidentally cleared.

### Independently executed evidence

Pinned runtime remained Node `v22.22.0`.

- `npm test -- tests/engine-recovery.test.ts tests/engine.test.ts tests/camera-overlay.test.ts tests/connection-error.test.ts`: exit 0; 4 files, 29 tests passed; 8.32 seconds. Engine, lifecycle and renderer helper hashes in this run match the final checked hashes. The last main-only tray error-code change is covered by the extracted-source control below and a fresh typecheck.
- `npm run typecheck` against the final main/renderer source: exit 0, no diagnostics.
- Six additional independent real Unix-socket controls against engine SHA-256 `b421b7c8…`: same-packet new-take event (two status reads; final recording); inverse same-packet Stop (two reads; final idle); rejected first status then valid (two reads; one recovery error); timed-out first status then valid (two reads; one recovery error); permanently invalid status (exactly three attempts, no recovery success, client closed, active cache retained); and Quit while recovery's first status was pending (fresh Quit status, client closed, no late recovery event or error). Every control passed; injected process-launch count was zero. The timeout control shortened only the fixture request deadline to 100 ms; production source still uses 10 seconds.
- A control extracted and compiled the actual renderer setter and recovered-event branch in memory. Four connection codes cleared; low-disk, permission-denied, finalization-pending, ordinary request timeout and unknown codes remained; a later unrelated message reset an older connection tag. Ten provenance cases passed. This is a source-level control, not a rendered React/installed UI test.
- A control extracted and compiled the final `requestControl` function in memory. A fixture disconnected Stop broadcast retained `code: engine-disconnected`; exit 0. Existing main IPC error envelopes and preload's error reconstruction also retain machine codes.

Read native contracts support the chosen controls: ControlServer serializes complete lines but does not promise that response and event lines arrive in separate socket packets. EngineController's status may await session/permission work, and capture events identify take/state transitions. A lost preview-owner connection disables idle prewarm while an active take retains its writer until normal Stop. No native file was changed or a native process/device operated by this checker.

### Final checked SHA-256 inputs

| File | SHA-256 |
|---|---|
| graph.md | cea9b8d247def2121985b7032295312c591b7c78ec7bc3c9f9e5e77e35a87537 |
| transport-debug.md | b75b20a67c97ac9f22e31bab29a372bdad1213e76e0041bde934b4f6a1bbeba8 |
| shell/src/main/engine.ts | b421b7c8ed8702acd6a57d2ec21aabce1d99227a16191c0453281775212c0469 |
| shell/src/main/index.ts | 6339a9623d0c052d9acee9674298ee6ed2b1a193949307f4735be4fae861e1bd |
| shell/src/main/camera-overlay.ts | 025a9c5e44110db7e3fe0007db19aa92076ed907085ccc30d9360157f67d000b |
| shell/src/renderer/main.tsx | f818466ce95779d13b2fcbe770f2f0107d7dc93706384d453ee149171543b7eb |
| shell/src/shared/connection-error.ts | bf8ea97dda84f884b1c38f23df3791ae57cf630fdf7a7d8456b42996b84d2178 |
| shell/src/preload/index.ts | c8427ada79ec17f1a71e72b3896329b1110e891d3662c6037c94225cb0e81689 |
| shell/tests/engine-recovery.test.ts | d7b4a41744812108f740df4ebceaaef45fdcd69519f89b17c6c860f52f1d0520 |
| shell/tests/engine.test.ts | 4c59fcbf72e7963db0dca594e601872565b5025e7b87b81fe32b522eb18f64ad |
| shell/tests/camera-overlay.test.ts | 4a271d851004999702fd584527c3f6c950b32c93a11a095418d6486de4195b2f |
| shell/tests/connection-error.test.ts | e83bedb59c1eab7d70291ed3184287ccf5342776f6c93ac175aba64a0d7bf398 |
| shell/package.json | 7bb3bb3a00c4c5c3851a810178e4465cc12a6a79ca3db73df0c25347fe418536 |
| Sources/RushCore/Control/ControlServer.swift | bc9d182e2f4d4f5a5e2fcd566f34c80ffb0b1758b73a32dc384b312b7138d694 |
| Sources/RushCore/Control/EngineController.swift | 5938e1d96267de22a615698faaa64e9de1fcad9054c3bfcde01a5e7374ef8f45 |

The installed acceptance described in attempt 0 remains required. In particular, a same-PID fresh CLI response alone cannot prove the repaired Electron peer recovered, and this source verdict cannot resolve failures in a broader declared native gate. Checker C1r wrote only this verdict file and did not operate Beads, GUI, recording devices, cloud services or installation.
