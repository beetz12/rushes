# Native render benchmark — 2026-10-11 EDT

Both requested PLAN Phase 3 timings passed on generated media: the first uncached five-minute 1080p30 screen-and-camera share export took **28.631871084 seconds**, against a 75-second limit; the first ten-minute editor-tracks export took **1.933201708 seconds**, against a two-second limit. These are observed single-run timings on David's Mac. This benchmark did not use physical capture, devices, UI, providers or user footage.

## Runtime and timing boundary

The root release engine and matching release CLI were used from `/Users/dave/Work/loom-clone/.build/release/`. Their SHA-256 values were checked before the measurements and again after completion, with no changes:

- `rushcore-engine`: `5173a02872e81358e027da6f3d4bbd78cfe08b42d9fe4d28d80d17b310f8d9f9`
- `rushes`: `17cb2354de1c1bfa5cef2f5877fe311d0105a18a0cc4c40657395e79d9bd0935`

Runtime: macOS 27.0 build 26A428, arm64 Mac17,6, 18 logical CPUs, 137,438,953,472 bytes of RAM; Apple Swift 6.4. The resumed harness captured root checkout HEAD `5a956b2cfea7a9af87cb73abf8acdc152d687218`. That is the checkout snapshot, not an embedded build identifier; the binary hashes identify what actually ran. The UTC run record starts `2026-10-12T00:43:03.711643+00:00` and completes `2026-10-12T00:52:49.311645+00:00`.

The engines used only the owned benchmark recordings root, SQLite index and UNIX socket, with `--capture-stub`; no record command was issued. Ready events and an isolated list read confirmed the two generated recording IDs before export. Engine PIDs 51290 and 69239 both exited 0 after owned SIGTERM shutdown. The original engine and CLI were never rebuilt for this benchmark.

Each timing uses Python's monotonic nanosecond clock around the real release CLI subprocess, from process start through the completed export response and destination installation. Fixture creation, hash computation and full decoding are outside the timing. Masters were hashed and decoded before the timed requests, so filesystem caches were warm. The five-minute render cache was empty; its response explicitly reported `cached: false`. The editor destination was a new folder.

## Workload

Native AVFoundation writers generated complete timelines, using four alternating deterministic noise textures to create a demanding high-entropy changing picture. Screen tracks are 1920×1080 at 30 fps; camera tracks are 1280×720 at 30 fps. Both are H.264. Microphone and system tracks are AAC at 48 kHz, with generated 440 Hz and 660 Hz tones, respectively; microphone is mono and system audio is stereo. All source offsets and synthetic latency values are zero. The default visible camera bubble and audio gains were retained for the share render.

The five-minute fixture has 9,000 frames in each video track and 14,400,000 PCM frames in each audio track, totaling 2,092,049,981 bytes. The ten-minute fixture has 18,000 frames per video and 28,800,000 PCM frames per audio, totaling 4,178,990,052 bytes. These source sizes and noise textures qualify the performance observation; they are not a claim about representative physical screen or camera footage.

| Fixture | Master | Bytes |
|---|---|---:|
| 300s | screen.mov | 1,444,564,404 |
| 300s | camera.mov | 637,995,173 |
| 300s | mic.mov | 3,791,552 |
| 300s | system.mov | 5,698,852 |
| 600s | screen.mov | 2,885,535,753 |
| 600s | camera.mov | 1,274,383,163 |
| 600s | mic.mov | 7,602,392 |
| 600s | system.mov | 11,468,744 |

Fixture generator subprocesses exited 0: 39.720257625 seconds for five minutes and 78.939631 seconds for ten minutes. Full source decoder subprocesses also exited 0 and proved the complete stated frame counts and timelines before export.

## Output and preservation

| Export | CLI elapsed | Plan limit | Result |
|---|---:|---:|---|
| Five-minute share | 28.631871084 s | 75 s | Pass |
| Ten-minute editor-tracks | 1.933201708 s | 2 s | Pass |

The share is a 300-second 1920×1080 H.264 MP4 (`avc1`), with 9,000 decoded video frames and AAC 48 kHz stereo audio containing exactly 14,400,000 decoded PCM frames. Video starts at zero, its last frame is at 299.96666666666664 seconds, and both streams end at 300 seconds. Nominal frame-rate metadata reads 30.000001907348633 (one Float32 ULP above 30); the measured count divided by duration is exactly 30, and the final frame matches the 1/30-second cadence. The continuous timeline checks remained strict. Both the unchanged root calibrated probe and the benchmark's extended codec/frame-count probe exited 0.

The output is 1,469,563,395 bytes. Independent top-level box parsing found `ftyp` first (28 bytes), then `moov` (204,764 bytes), then `mdat`, confirming the plan's fast-start layout. The completed share artifact retained SHA-256 `9fc7de7f5498e49476a56dd27f722d74e1843d49eb0df5ade0fde7b7cec7a3bf` throughout all probe calibrations; it was neither changed nor re-rendered.

The editor export contains all four original track files and `offsets.json` with roles screen, camera, mic and system, each offset zero; `editApplied` is false. Every copied file is byte-identical to its source by full SHA-256 comparison. Full independent decoding of the editor destination exited 0 in 32.17636025 seconds and confirmed 600 seconds of media, 18,000 frames per video, 28,800,000 PCM frames per audio, H.264 video at the original dimensions and frame cadence, AAC at 48 kHz, mono microphone and stereo system audio. All eight original fixture master hashes remained unchanged after the exports and probes. Individual before/after/copied hashes are retained in the result JSON.

## Calibration and evidence

Failed harness attempts were retained. The first assertion incorrectly expected the MP4 sample-entry label `mp4a` from CoreMedia's audio format subtype; the actual MPEG-4 AAC subtype is `aac `. A later diagnostic probe incorrectly keyed encoded video duration by raw packet PTS: the H.264 export carries a 40/600-second source edit offset while output and decoded PTS begin at zero. The exact root `verification/ProbeMedia.swift` from commit 666587c uses CMSampleBufferGetOutputPresentationTimeStamp and CMSampleBufferGetOutputDuration to match the decoded timeline; it passed unchanged on this same artifact. The extended probe adds codec and decoded frame totals without removing the root decoder/timing predicates. Its metadata check allows exactly one Float32 ULP around the nominal 30 fps field while retaining exact frame counts, count/duration rate and last-frame cadence. No renderer code or media artifact was changed for any calibration.

Owned evidence is under `/Users/dave/.goal-loop/loom-clone/host/native-render-benchmark`: `result.json`, `generate.swift`, `run.py`, `continue.py`, the copied calibrated and extended probes, all subprocess stdout/stderr logs, both generated packages, the share MP4 and editor destination. `result-at-codec-assertion.json`, `result-at-raw-PTS.json`, `result-at-float-fps-assertion.json` and the failed probe logs preserve the failures. Final harness exit was 0, both measured exports exited 0, and all final duration/decode/frame-count/fast-start/preservation assertions passed.

Only this QA report is an intended repository change. Native sources stayed read-only; no full umbrella gate, device/UI/provider action or dependency change was performed. Root owns final signing, installation, sharing integration and any broader claim about physical captures.
