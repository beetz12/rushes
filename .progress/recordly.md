# Progress: recordly (reader goal 5)

## Plan
1. Read reader brief, sources.json, checks (done).
2. Map the clone; read README and docs for feature claims (done).
3. Read macOS capture path: native ScreenCaptureKit helper, cursor monitor, main-process recording glue, renderer recorder hook (done).
4. Editor polish: zoom, cursor smoothing, click effects, webcam bubble, timeline, project format (done; helper pass spot-checked).
5. Export pipeline, captions/whisper, annotation (done; helper pass spot-checked).
6. Share service (MIT) and supabase folder (done; helper pass spot-checked).
7. Write docs/research/recordly.md and .json; run both checks; commit (done).

## Done
- docs/research/recordly.md (about 4,650 words, 53 inspected paths) and docs/research/recordly.json (19 areas, 17 ideas, 10 weaknesses).
- check_research.py recordly: OK 1 notes, 17 ideas. check_clean.py: 0 hits.

## Unverified
- Fine-grained editor and export constants (spring parameters, queue depths, CUDA/D3D11 internals) came from read-only helper passes; key constants were spot-checked, the CUDA compositor internals were inferred by the helper from includes and are labelled as such.
- Popularity reasons are my inference; the shallow clone has no history or issue data.

## First unfinished step
- None. Result JSON written outside the repo after commit.
