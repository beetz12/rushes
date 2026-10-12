---
node: N2r
skill: debug
graph: rushes-first-use-cloud
run: 2026-10-12
inputs: [shell/src/main/engine.ts, shell/src/main/index.ts, shell/src/renderer/main.tsx, shell/tests/engine-recovery.test.ts, Sources/RushCore/Control/ControlServer.swift, private installed-qa and bubble-close proof]
status: draft
---

## Hypotheses and evidence

1. Native engine crash: rejected for this occurrence. Installed PID 9655 remained the same, fresh CLI status was idle with no warnings, and no new crash report appeared. All four tracks of the real bubble-hide take passed decoding verification.
2. Lost Electron/native connection: confirmed by renderer disconnected errors while the same engine's socket answered a fresh CLI client. A fresh peer connection does not establish that the old renderer client recovered.
3. Preview backpressure during prolonged native menu automation: plausible contributing condition, not proven as this occurrence's cause. ControlServer's preview mailbox closes a peer after a write failure and uses a 250 ms send timeout. Do not describe that inference as a measured causal trace.
4. Stale active state prevents recovery: confirmed in source and a failing-before real Unix-socket regression. EngineSupervisor returned early from recovery whenever its active cache was true; that cache depended on events from the lost connection, including Stop. The new test failed before the fix (zero recovery events within 2.5 seconds).

## Repair and verification contract

Reconnect to the existing socket during a cached active take; never launch or stop an engine on that path. Read and validate fresh status before reporting recovery. Reconcile missed Stop and reset the attempt budget only after successful status verification; cap failed attempts at three. Preserve the existing fresh-Stop Quit guard. Main reconciles overlays and capture identity, respects the user's hidden-bubble choice, and clears stale preview frames on disconnect. Renderer accepts the fresh status, clears stale countdown/connection errors and leaves unrelated errors visible.

Required controls: capture-time connection loss preserves one engine; missed Stop becomes idle from native status; subsequent independent outages recover; failed active connection attempts are bounded and cannot launch/stop a take; existing fail-safe Quit tests still pass. The independent C1r verdict and installed update proof must follow before marking this repair complete.

Independent attempt 0 found and reproduced two additional transport races: an invalid status left the socket connected and suppressed retries, and a same-packet newer capture event was overwritten by the older status reply. It also found per-take hidden-bubble state carried into a different recovered take. Repair 1 closes a failed verification connection for bounded retry, adds a state revision with bounded fresh-status rereads, resets suppression on a different take while preserving it for the same take, and invalidates automatic recovery when Quit owns the lifecycle. Failed-attempt evidence remains in transport-verdict.md.
