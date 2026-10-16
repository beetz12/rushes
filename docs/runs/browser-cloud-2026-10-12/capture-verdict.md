# Independent browser capture verdict

## Reassessment after the single consolidated repair

**PASS for targeted capture-slice code completeness after repair `54153e7badb4602fcfd78efcafed426c51a75b7c`, with full M1 still CONCERNS/PENDING.**
The original C1/C2 findings and failure evidence below remain historical records.
Their exact independent probes now pass; recovered-duration handling also passes.
The cadence correction passes its logic fixtures, but short encoded composition
still measures below the nominal 30 fps target, so the fresh maximum/background
matrix must resolve actual performance before any supported-matrix or paid-launch
claim. No physical or full M1 condition has been waived by this slice pass.

Reassessment date: 2026-10-12T16:30:02Z. Review checkout:
`b0869b2` (artifact history plus authorized read-only cherry-picks of shared seam
`053402f1ebf4777e023ba2c117470281b132cf79` and maker repair `54153e7`). The reviewed
capture source is identical to that maker revision; root integration was supplied
as `70ec921`. No implementation or contract was edited by this reviewer.

| Finding | Independent reassessment |
|---|---|
| C1, source ended while primary create was committed but pending | `index.ts:304–310` awaits owned terminal finalization even after `failed` was reported. Repeating the original gated create/source-ended probe yielded `states:["failed","stopping","interrupted"]`, disk `interrupted`, epoch 0, lease false and all granted source/preview tracks ended. A separate tab removed the draft without an extra Stop. The expanded suite also tests source loss before primary commit and retained closed bytes. |
| C2, initial-write orphan hid healthy drafts | `storage.ts:115–157` supplies an in-memory diagnostic without replacing corrupt metadata; `241–255` isolates enumeration failures. Repeating the initial quota injection yielded the healthy completed draft in list(), plus an interrupted orphan diagnostic. A second malformed-JSON entry preserved its literal metadata, its readable recognized chunk and its unknown file. The suite separately covers malformed shape and unrecognized folder names. |
| Recovered duration stale compared with acknowledged bytes | `storage.ts:194–207` retains interrupted state, derives at least the durable checkpoint length and labels it estimated. Actual isolated reload probe: pre-reload duration 25.9 ms, last acknowledged checkpoint 4057.2 ms, four chunks; after reload duration 4057.2 ms, interrupted state and an explicit estimate/unclosed-tail note. All four previously acknowledged chunks were read back with matching size/digest. This is a reload probe, not root's process-kill matrix. |
| Strict-interval cadence dropped near-target frames | `cadence.ts:4–14` uses relative nominal buckets and `composition.worker.ts:30–32` consumes that decision. Jitter timestamps 33,330/33,334 µs retain 300/300; 60 fps is decimated to one real timestamp per nominal bucket; a long gap creates no catch-up frames. Actual encoded performance is separately retained below. |

Fresh commands in this unchanged reviewer checkout, Node 22.22.0, macOS 27.0
(26A428), headless isolated Chrome 155.0.8059.39:

- `npm --prefix browser run build`: exit 0 (TypeScript/Vite).
- `npm --prefix browser run test:capture`: exit 0, **16/16 pass**, 44.178 seconds.
  Composed decoded edge drift +14.062/+14.062/+2.813 ms; original absolute sample
  drift at most 36.563 ms. Original thresholds remain unchanged.
- Inline Vite/Playwright/Node independent repair probes: exit 0; exact original
  C1/C2 scenarios asserted the repaired outcomes, plus actual reload/read-back
  and a short encoded worker output probed through ffprobe's stdin. All isolated
  contexts, browser and server were closed. No output media file was persisted.
- A second inline ffprobe probe compared original and composed packet timestamps
  in one take: exit 0. No frame rate assertion or acceptance threshold was added
  by this comparison; its purpose was to measure the residual accurately.

### Actual cadence remains an M1 performance concern

The first repaired short screen-camera take was complete, 1280×720, 172 encoded
video packets across 6.1 seconds: **28.033 fps**, maximum timestamp gap 69 ms.
The second take compared all three encoded video timelines:

| Track | Frames | Encoded span | Measured fps `(frames−1)/span` | Maximum gap |
|---|---:|---:|---:|---:|
| Screen original | 184 | 6.139 s | 29.809 | 70 ms |
| Camera original | 183 | 6.139 s | 29.647 | 70 ms |
| Composed | 171 | 6.131 s | **27.728** | 72 ms |

Thus the previous root-reported 19–20 fps issue improved, but this run still loses
about 6.5% of encoded frames relative to the camera original. The measurements do
not identify whether remaining loss comes from cadence bucket boundary effects,
processor/worker backpressure, canvas encoding or host scheduling. They also do
not prove a 30 fps release guarantee. Root's new 600-second and background matrix
must measure the actual integrated result and assess the existing target without
changing protected gates. No unexplained gap over 250 ms appeared in these short
probes; that statement is limited to these packet timestamp samples.

No further blocking code defect was reproduced in the targeted consolidated
repair review. All earlier retained M1 conditions below still apply, including
maximum memory/finalization, Windows/prior Chrome, physical picker/permissions,
offline/background/minimized/freeze/discard and external-folder process-kill
durability. Production UI/asset integration is also outside this slice checkout.

Reassessed SHA-256 values (contract and paid-plan hashes below remain unchanged):

| Input | SHA-256 |
|---|---|
| `browser/src/contracts.ts` | `5817e23538dad1a2a18c878781ac7bc34db64b124f0cbc79ba1894b0dd727269` |
| `browser/src/capture/index.ts` | `4daf88424af54db2767278d25e6a327047c0f1aeccef7cc5a9709aa5bccd83cc` |
| `browser/src/capture/storage.ts` | `a7787c68bfd03b90da22b963946e532c67ac022565103e4fe6fdba78ef2e6a64` |
| `browser/src/capture/composition.worker.ts` | `1d89f4407fb654d3e0722ee6b6be92e09e82005a1042c6574fc29b5fc1f077fa` |
| `browser/src/capture/cadence.ts` | `f3e2a966215c3623b7794fa863b0f9e310ecbc97a09a4d521275b98c7bd48914` |
| `browser/test/capture-fixture.mjs` | `3db7b58e927b40311b6693534717c17a968b33bfdbb47d9433fac87982e3818a` |
| `browser/test/capture.test.mjs` | `5c2940f9a3b130af21c16ff9ac32e5d9eca7640c2e9b483b4b398d797bf57d78` |
| `browser/test/capture-cadence.test.mjs` | `0efe8025526f513a1d77d734b190bd373673ba840053791ed3d5bdf8a03cee6a` |

## Historical initial verdict and retained failure evidence

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
