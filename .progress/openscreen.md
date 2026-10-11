# Progress: openscreen (reader goal 3)

## Plan
1. Read reader brief and checks (done).
2. Survey clone layout, README, technical-documentation, package.json (done).
3. Deep reads: project file format, Rust compositor crates, CLI, captions + AI assistant, capture per platform (done).
4. Sweep remaining feature areas (19) (done).
5. Write docs/research/openscreen.md and .json (done).
6. Run check_research.py and check_clean.py (done: "OK 1 notes, 16 ideas" and "0").
7. Commit on goal/research-openscreen; write results JSON (done).

## Done
- Steps 1-6. Evidence from the project's architecture docs plus code spot checks (schema, CLI main,
  napi addon, compositor service, SCK helper sizing/writer, PipeWire helper headers, STT model manager,
  GPU detector, MCP server guards, document service atomic write, webcam presets, export fps).
- Corrections made after code checks: webcam size range is 15-60 (not 15-50); six text animations;
  whisper.cpp picks GPU backend at runtime (one binary per platform).

## Unverified (described from the project's own docs, code only partly opened)
- whisper-stt C++ helper internals (VAD cut, DTW) and exact chunk size.
- WGC helper internals beyond grep (stop budgets, 19 kHz keepalive, 100 ms cushion) - from recording.md.
- Linux webcam sidecar path - from recording.md and README.
- Agent tool count (26) - from ai-agent.md, not counted in code.

## First unfinished step
- None. Notes committed; goal result JSON written outside the worktree.
