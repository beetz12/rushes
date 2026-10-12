# Independent browser capture verdict

**FAIL for capture-slice contract completeness at `736d0f0ad841371429ef0c340c369b3b599c1e45`.**
Two reproduced startup/storage failure cases need a targeted repair before this
slice is accepted. The declared build and eleven foreground capture tests pass.
**Full M1 remains pending independently**, regardless of these two repairs; this
review does not establish Windows, physical permissions, maximum-take or
background/minimized reliability.

Review date: 2026-10-12T16:06:07Z. Review type: implementation against the immutable
browser-cloud contract and reviewed paid cloud plan. Reviewer: one independent
capture-checker lane; this reviewer wrote none of the capture implementation and
did not spawn further reviewers. Range: `74ee968..736d0f0` for the capture changes,
including the startup-checkpoint repair. No implementation, shared contract,
provider setting, Beads record, real device, shared browser profile or GUI was
changed or accessed. Only this verdict artifact is written to tracked source.

## Required repairs

### C1 — A source ending during draft creation leaves a stale live lease

**P2, confidence 100 (reproduced).**
`browser/src/capture/index.ts:115–119`, `270–274`, `293–303`;
`browser/src/capture/storage.ts:145`.

During `start()`, `created` remains false until the entire `store.create()` promise
resolves. OPFS can already have committed the primary manifest and acquired its
live lease while an optional backup checkpoint is still pending. If the screen
source ends in that window, `fail()` reports `failed` and releases the streams.
When creation then resolves, the `released` branch throws, but its catch calls
`fail()` again; the existing terminal-state guard returns without finalizing the
now-created draft. The disk manifest stays `ready` with epoch zero and its
`rushes-active-<id>` lock stays held by a page that is no longer recording.
Another tab therefore sees the draft as live and cannot remove it. The record
becomes recoverable only after owner-page termination or an additional explicit
`session.stop()` call that the failed-state callback does not request.

Independent reproduction used the existing synthetic screen fixture and actual
OPFS/Web Locks in a fresh isolated Chrome context:

1. Wrap `store.create`: await the real create, signal primary commit, then await a
   manually resolved gate before returning.
2. Start the session. After the primary commit signal, stop the synthetic screen
   track and dispatch `ended` (the same source-loss convention as the existing
   test at `browser/test/capture.test.mjs:89–90`).
3. Resolve the gate, await the rejected start and inspect callbacks, disk state
   and `navigator.locks.query()` before cleanup.

Observed result:

```json
{"error":"The recording source closed during startup.","states":["failed"],"lease":true,"state":"ready","epoch":0,"allSourcesEnded":true}
```

Fix the late-create cleanup independently of the already-reported terminal UI
state. Once an owned primary draft is known to exist, checkpoint it terminally
and release its lease even if the source failure happened before create returned.
Keep the duplicate-id protection from the previous repair. Add a regression with
the primary-commit/gated-create/source-ended ordering above; assert terminal disk
state, no live lease, ended sources and second-tab removal/recovery without an
extra Stop. Include source loss before primary commit in the same repair coverage.

### C2 — Failed initial checkpoint poisons the entire local draft list

**P2, confidence 100 (reproduced).**
`browser/src/capture/storage.ts:144–145`, `77–79`, `164–168`.

Creation makes a draft directory before writing its first manifest. A quota,
permission or write/close failure at that first checkpoint leaves the directory
without a readable manifest. `list()` then unconditionally reconciles every
directory and rejects on the first such entry. One failed new recording therefore
prevents enumeration of otherwise healthy saved recordings, including bytes that
the failure did not touch. A crash between directory creation and the initial
manifest close reaches the same reader precondition. There is no per-entry
isolation or startup-folder cleanup in this path.

Independent reproduction first completed a real synthetic short take. In a fresh
isolated page, the directory handle's `getFileHandle` was temporarily made to
throw `QuotaExceededError` only for the new draft's initial `manifest.json`
creation. It was restored before reading results. The new create rejected;
direct loading of the earlier recording remained successful, but `list()` failed:

```json
{"creationError":"Synthetic initial checkpoint quota exhaustion","positiveState":"complete","positiveBytes":6036,"listError":"NotFoundError: A requested file or directory could not be found at the time an operation was processed.","orphanFiles":[]}
```

Make enumeration isolate damaged/incomplete entries while retaining their bytes
and reporting a recoverable diagnostic. Creation may also remove a proven-empty,
owned directory after its first checkpoint fails; that alone does not cover
process termination between the two operations or a damaged existing manifest.
Do not silently delete unknown directories or recording chunks. A regression must
prove that a healthy finalized draft still appears alongside an initial-write
orphan, and that malformed manifest/retained-byte entries do not hide its data.

## Verification performed

All commands ran in this reviewer's own checkout using Node **22.22.0**, macOS
**27.0 (26A428)** and isolated headless installed Chrome **155.0.8059.39**. No
permission-granted physical media, authenticated profile, cloud upload or billing
action was involved. The gate's own process exits were inspected.

| Command | Observed result |
|---|---|
| `PATH=/Users/dave/.nvm/versions/node/v22.22.0/bin:$PATH npm ci --prefix browser` | Exit 0; 32 packages installed, audit reported zero vulnerabilities. |
| `PATH=/Users/dave/.nvm/versions/node/v22.22.0/bin:$PATH npm --prefix browser run build` | Exit 0; TypeScript and Vite succeeded. |
| `PATH=/Users/dave/.nvm/versions/node/v22.22.0/bin:$PATH npm --prefix browser run test:capture` | Exit 0; 11 tests passed, zero failures, 46.351 seconds. |
| Inline `node --input-type=module` independent failure probes using Vite + Playwright Chrome in `browser/` | Exit 0; reproduced C1 and C2 as shown above. Probe resources were explicitly closed. This exit means the probes ran, not that their observed behavior passed. |

The supplied suite exercises real MediaRecorder instances, transferred streams,
the actual composition worker, OPFS and decoded synthetic audio/video. In this
independent run, composed edge drift was +19.688/+14.062/−2.813 ms; the screen and
camera original edge samples had absolute drift at most 30.938 ms after their
stored start offsets. The calibration source's pattern deliberately pauses during
Pause while its live streams continue. This does not resolve the separately
retained arbitrary-content resume-edge ambiguity in the maker's slice evidence.

The review read all three capture source files, both capture fixture/test files,
shared contracts, capture design/evidence, immutable contract and paid plan/verdict.
Source cleanup closes tracks, disconnects audio nodes, clears timers and terminates
the worker; frame replacement and awaited worker writes avoid an unbounded
application-level frame list. Per-draft operation locks serialize primary chunk,
descriptor and checkpoint writes. The tests verify contiguous/idempotent appends,
digest mismatch retention, unjournaled chunk discovery, reload interruption,
second-tab live inspection/deletion refusal and backup-close failure. Those paths
passed; C1 and C2 are the concrete additional failure paths found here.

## Retained M1 conditions, separate from slice repair

These are already required by the paid plan/contract and belong to root's
independent acceptance, not extra features requested by this reviewer:

- Actual 600-second recording with at least five pauses, decoded timeline and
  beginning/middle/end sync, no unexplained gap over 250 ms, actual original and
  composed dimensions/frame rates, measured byte/chunk rates and bounded memory
  during capture and final Blob/decode handling. Requested bitrate is a hint;
  32 MiB pending queue, 64 MiB chunk and 2 GiB local guards do not prove total
  browser/native-process memory or all source settings.
- The named current and prior desktop Chrome versions on both Windows and Mac;
  physical browser screen-picker cancel/denial and OS permissions, real screen
  and camera/microphone combinations, device loss and missing display audio.
- Five minutes offline; another tab/app and minimized-window capture; realistic
  background throttling, freeze/discard and memory pressure. The supplied
  Playwright launch uses default headless flags, so its foreground results are
  not background/minimization proof. A frame-driven worker avoids rAF dependence,
  but does not alone prove execution through page suspension.
- Abrupt browser-process termination and read-back of acknowledged checkpoints;
  measured encoder-tail loss and reconstruction limitations. The existing reload
  test is not a process-kill test. Real external chosen-folder close/read-back
  after process kill is still required; the supplied folder fixture is another
  OPFS directory, not a physical external directory.
- Integrated production assets must consume this capture implementation and
  re-run capability/worker composition checks. This reviewed checkout's `main.tsx`
  is still the separate UI scaffold. Current capability detection correctly
  rejects absent Window processor/generator APIs; support cannot be inferred
  from the similarly named newer standards API or a TypeScript build.

Primary sources reopened for this review support the narrow assumptions:
[recording specification](https://w3c.github.io/mediacapture-record/) guarantees
combined-blob playability for a completed recording, not every chunk or killed
tail; [Chrome file access](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
requires close before disk commit; [page lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)
describes frozen/discarded execution limits. The current
[processing draft](https://w3c.github.io/mediacapture-transform/) describes
DedicatedWorker `VideoTrackGenerator`/processor APIs distinct from the Window
`MediaStreamTrackGenerator` path actually detected and exercised here. These
documents are not substitutes for the retained supported-version matrix.

## Revision and checksums

The working tree was clean before writing this artifact. Reviewed source remained
unchanged throughout the commands and probes. SHA-256 values:

| Input | SHA-256 |
|---|---|
| `browser/src/capture/index.ts` | `012e04f57c4debf2269f1a4de9c91739823c895535d5ddc5ff095deb764d68bf` |
| `browser/src/capture/storage.ts` | `1c9f1db16413b6dea136b7ef2bae24fd7f1c949e7526819ccd443d3afb37310e` |
| `browser/src/capture/composition.worker.ts` | `be0d2b9e34ad63a90c0a29b09352c21127b1eb457a6d5a5dfc4cbbd2921568f3` |
| `browser/test/capture-fixture.mjs` | `e33037e70dd5af58b4c6f3de06ef33d1c86edb18a7f1ea9e3a5b0947b01b909a` |
| `browser/test/capture.test.mjs` | `f18f686c83da12984b5f1e2c5051d7059672ae5be1b1892c450cb0b4909c1e82` |
| `docs/runs/browser-cloud-2026-10-12/contract.md` | `cb3ca16f8b16ea8b018dc5de02fb69089c7972987cd88bc880e805a517ad66b7` |
| `docs/product/first-use-cloud-2026-10-12/cloud-plan.md` | `d789f4289b68a93e64224ce19691a0f667ac51283d25e827593b52317caa3bae` |
| `docs/product/first-use-cloud-2026-10-12/plan-verdict.md` | `f2b1c767d7966057cd3ff6c5a3a018a21e47974fa09ff34f1a46dbf35d4c21bf` |

Recommendation: **with fixes; slice acceptance is currently FAIL**. Root should
coordinate the one targeted repair pass and independent reassessment. Preserve
the full M1 conditions and original failure evidence; no check should be widened
to turn either this verdict or the physical/browser matrix green.
