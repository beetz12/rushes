# Independent transport review

Reviewed on 2026-10-12 by one fresh read-only reviewer against the root amendment
in `8563fea` and the complete `e98c3d7` source/test/doc diff. Candidate:
`e98c3d784500fb25721fe170526bf168bda60175`. The existing isolated review checkout
was snapshotted at that exact candidate on `codex/rushes-desktop-transport-review`;
complete `Sources`, `Tests` and `shell` Git tree IDs match. The corrected `4237969`
camera fixture is present. Business files remained unchanged during review.

**Initial e98 verdict: With fixes; renderer acceptance FAIL.** The native/client transport repair passes the bounded
review and fresh gates. One supported renderer integration gap leaves the
amendment's error-clearing requirement unmet. No native transport repair or
recording-lifecycle change is requested by this review.

## Supported finding

**[P2] Ordinary actions clear connection status before verified recovery**
(confidence 90). `shell/src/renderer/main.tsx:110` unconditionally calls
`setError('')` at the start of every `App.run` action. The setter also replaces
`errorCode.current`; the generic catch at `:115` can overwrite the connection
error with the current action's result/error. Consequently, classifying
`invalid-json` as recoverable and clearing it in the verified reconnect handler
at `:151` does not make that handler the only clearing path.

Concrete reproduction with the actual candidate renderer in isolated headless
Chrome: show an invalid-json alert, hold a synthetic fresh status request, and
deliver an ordinary warning. The alert stays visible. Choose **Show camera
preview** and return a synthetic valid preview acknowledgment. The alert
disappears while **zero fresh status responses have completed** and **zero
engine-reconnected events have occurred**. The held-status positive control then
completed status and emitted verified recovery, moving both counters to one.
The same probe showed a pending request rejection replacing the invalid-json
alert with an engine-disconnected alert before verified recovery. There were no
renderer errors.

That replacement code follows the actual transport path:
`EngineClient.invalidLine` emits `invalid-json` separately, but rejects pending
requests through `rejectAll` with `engine-disconnected`
(`shell/src/main/engine.ts:116`, `:147`). Main IPC and preload preserve the rejection
code, then `App.run` stores it. This code remains correctly classified as a
connection failure; the defect is the single generic error state's clearing and
replacement behavior. The path predates `e98c3d7`; this is an integration gap
against the new contract, not an introduced parser regression.

Required narrow repair: keep connection status latched until the existing
verified `engine-reconnected` event, independently of ordinary action errors.
Action start/success must not clear that latch; unrelated permission, recording
or export failures must still be shown and remain after connection recovery.
Do not solve it by discarding every catch or clearing every error on reconnect.
Root was sent the finding and proposed ownership of renderer `main.tsx` plus a
small shared state helper/regression test if useful. This reviewer made no
business edit.

## Transport and recovery assessment

- **Atomic native close passes.** `ControlServer.swift:114` holds `writeLock`
  throughout a line write, retries EINTR and calls `closeWhileLocked` on terminal
  failure before unlocking. The helper at `:224` sets `closed` and shuts down the
  stream under that same lock. Every later reliable/preview/error writer first
  sees `closed`, so it cannot append to a truncated prefix. The descriptor stays
  held until active readers leave; repeated Close cannot close a reused unrelated
  descriptor. Generated socketpair tests passed for a timed-out nonempty prefix,
  missing newline, EOF, refused next line, blocked reader and descriptor reuse.
- **Malformed client streams terminate correctly.** `EngineClient.ingest` stops
  on malformed JSON or a non-object envelope. `invalidLine` clears buffered
  trailing input, latches the connection as failed, rejects pending requests and
  destroys only its socket. Later queued input is ignored until a new connection
  resets the latch. Real generated Node sockets proved a trailing apparent idle
  event and successful status reply neither mutate cached state nor settle the
  pending request successfully. Null result payloads remain supported.
- **Active capture and fresh-status recovery are preserved at the tested seam.**
  The unchanged Supervisor's active recovery reconnects to the existing native
  socket, validates fresh status and checks state/lifecycle revisions before
  emitting `engine-reconnected` (`shell/src/main/engine.ts:235`). A held-status
  socket test kept the active take and error intact after connect plus an ordinary
  warning, then recovered only after verified recording status. Launch/kill spies
  were untouched and the only sent command was status. Native peer cleanup calls
  `clientDisconnected`; its controller path disables GUI publication but retains
  an active take's camera writer until normal Stop. No native process stop,
  recording clock, writer, media or token logic changed in this diff.
- **Diagnostics retain no message contents.** The malformed-input diagnostic
  carries only `invalid-json`, a fixed message and UTF-8 `lineBytes`. The socket
  test asserts that its generated prefix does not appear in diagnostics. Preview
  payload/token declarations and source publication logic remain unchanged.

The manually simulated error variable in the new recovery test proves the
Supervisor/classifier path; it does not exercise `App.run`. The additional
renderer probe was needed to expose the supported UI finding above.

## Fresh evidence

Private proof directory:
`~/.goal-loop/loom-clone/host/2026-10-12-desktop-controls/review/transport` (0700).

| Check | Observed result |
| --- | --- |
| Targeted clean scan | Changed native/shell source/tests, corrected control fixture, contract and slice: first line **0**, actual exit **0**, no skipped-source warning. `clean.log`. |
| Shell build/typecheck | Node **22.22.0**, `npm run build`, actual exit **0**; TypeScript and Vite completed. `shell-build.log`. |
| Complete shell suite | Node **22.22.0**, `npm test`, actual exit **0**: **124 tests in 17 files passed**, 8.53 seconds. `shell-test.log`. |
| Generated native transport filter | Swift **6.4**, transport/descriptor filter, actual exit **0**: successful compile, **4 tests in 2 suites passed**, 0.524 seconds. `native-transport.log`. Only generated socket bytes and descriptor fixtures executed; no AVAssetWriter/device/encoder test ran. |
| Changed-diff whitespace | `git diff --check e98c3d7^..e98c3d7`, actual exit **0**. `whitespace.log`. |
| Load-bearing renderer probe | Chrome **155.0.8059.39**, current built candidate renderer, isolated fresh headless context, synthetic `window.rushes`; probe exit **0**, no renderer errors. `error-gate-result.json`, `error-gate-probe.mjs`, `error-gate-probe.log`. It reproduces a requirement failure; its exit is not an application acceptance pass. |

The native command was
`swift test --filter 'TransportFailureTests|SocketDescriptorLifetimeTests'`.

The renderer probe created no native engine or real preview and used no camera,
media, authenticated profile, shared GUI or provider. Full native release,
packaging, install and physical acceptance remain root-owned. The review does
not infer the cause of the installed invalid-json incident or any native PID
change. Root's successful recordings and master exports were not opened,
modified or graded by this reviewer. No public push/PR or shared Beads write was
performed. This transport verdict is the reviewer's only tracked edit.
