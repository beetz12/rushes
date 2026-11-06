# Independent process contracts

These checks drive the actual released Swift engine and CLI in owned roots,
with `--capture-stub`. They do not use real capture devices or the user library.
The Swift media probe decodes every sample through AVAssetReader independently
of RushCore's package verifier. The normal take is a positive control; corrupt
media is a negative control for the independent decoder and app verifier.

Run from the repository after `swift build -c release`:

```
python3 verification/process_contracts.py --evidence-dir /absolute/new/evidence/directory
```

Use a new evidence directory for each pass. Each actual process exit, command,
socket request/reply, fixture and engine error is preserved. `report.json`
records the tested commit, individual verified/failed contracts and untested
surfaces. Exit 1 means a behavior contract failed. Build/compiler failures are
saved separately in `probe-build.json` and `harness-error.txt`.

The independent decoder uses CoreMedia output timing for compressed video when
matching a decoded buffer's exact invalid duration. Output timing applies the
container's edit list; source PTS does not. The first integrated MP4 export
demonstrated a source start of 40/600 seconds mapped to output zero, with decoded
PTS zero. Source-PTS matching incorrectly rejected that valid first frame. A
diagnostic copy retained in `host/export-timing-diagnostic.swift` records this
calibration. Matching still requires a finite positive duration from the exact
encoded packet; every decoded sample, monotonic PTS and completion check remains.

The baseline run at commit `c0eaa5b` observed the oversized-duration engine
crash, a zero exit for corrupt-media verification, successful verification of a
failed take with no present media, successful reading of `../outside.mov`,
ignored wrong-type duration, and input time that retained paused wall time.
These are regression contracts, not maker implementation suggestions. Capture,
UI, exports, external hosting and macOS permissions require separate real
checks; synthetic success does not establish their readiness.

## Real-time native endurance

After `swift build -c release`, run:

```
python3 verification/endurance.py --duration 1800 --evidence-root /absolute/new/private/evidence
```

The runner never selects physical sources: its owned engine always has
`--capture-stub`, with generated NV12/zero PCM on the host clock and the real
four native writers. Five pauses freeze media time. Per-minute status, native
`ri_phys_footprint` (not RSS), aggregate load and actual wall time are retained.
An allocation positive control checks the same memory instrument. Thirty-minute
acceptance requires actual samples near minute5/minute30, growth <=50MiB and
screen writer drops <=1%, including the final pending tail. Every file is fully
decoded by the independent Swift probe; ffmpeg independently seeks/decodes the
tail and must produce positive output progress. Three repeated takes and a
separate SIGKILL/restart verify recovery and raw-file hashes.

Use a short run (e.g. `--duration 12`) to qualify instrumentation before the
expensive pass. Its report explicitly has `thirtyMinuteEndurance:false`, even
when it exits0. Media duration/gap tolerance remains50ms for these generated
native fixtures. After SIGKILL, independently flushed raw tracks can end at
different boundaries. Recovery records measured per-track tails and the common
available timeline (a known lost camera can retain its shorter tail when another
input continued). The independent oracle checks each declared tail and compares
the common clock directly with actual decoded overlap, within50ms. Missing,
corrupt, wrong-type or shifted media still fail; normal finished takes retain the
original50ms common-duration check. Raw hashes and tail differences stay in the
report. Generated silence/static pixels cannot prove physical device
health or audiovisual synchronization. Real-device, UI and provider checks
remain separate. Preserve failing roots, especially their samples, native logs,
source/binary hashes, decode/tail reports and socket transcripts.

The umbrella gate runs `python3 -m unittest discover -s verification -p 'test_*.py'`
for positive/negative controls on the oracle; it does not run or claim endurance.

## Compact desktop workflow

After `swift build` and `npm --prefix shell run build`, use the pinned shell Node
runtime to run `node verification/compact-recorder.mjs`. The verifier launches
its own Electron profile, settings, native socket and recording library. Both
the initial engine and the fallback executable are explicitly `--capture-stub`;
ready must confirm generated capture. It never uses the user library, real
capture inputs, cloud configuration or clipboard. It mutes the owned window's
countdown audio. This is generated desktop interaction evidence, not physical
capture or installed-signature acceptance.

The visible test window requires an unlocked GUI and idle input. Only after an
explicit human override for this run may the driver set
`RUSHES_COMPACT_INPUT_OVERRIDE=1`; its receipt records that choice and the actual
idle timer. An active-input refusal is a held UI check, not a recording defect.
`RUSHES_COMPACT_EVIDENCE` may select a fresh, nonexisting output directory.
Logs, source/runtime hashes, generated media, export/decode receipts, private
profile paths and app-only screenshots are retained there. Failure exits1 and
keeps evidence; success requires actual playback, source selection, compact
layout at both sizes, guide persistence, draft-save refusal/recovery, editor
expansion, renderer reload, exact exported originals, independent decode,
hidden-source cleanup and a persisted Quit title. Actual desktop area picking,
OS dragging and physical devices remain the separate installed acceptance.


Owned engine crash evidence in CI: the CLI harness retains the first request,
bounded partial stdout, exact executable path, launch bracket and observed exit.
`engine_crash_report.py` matches only an unexpected signal11 boot to the built
Mach-O UUID, PID and launch interval. It projects at most64 stack frames; raw
reports, registers, environment, application messages and memory summaries are
excluded. macOS can redact paths and can date the report after process exit.
Missing or ambiguous reports remain unavailable. A passing collector or local
fixture is not a fix for the intermittent native crash. The ordinary Gate keeps
its actual exit through pipefail; its always-step uploads only the projected JSON.
