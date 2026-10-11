# Progress: openscreen (reader goal 3)

## Plan
1. Read reader brief and checks (done).
2. Survey clone layout, README, technical-documentation, package.json (done).
3. Deep reads: project file format, Rust compositor crates, CLI, captions + AI assistant, capture per platform (done).
4. Sweep remaining feature areas (19) (done).
5. Write docs/research/openscreen.md and .json.
6. Run check_research.py and check_clean.py; fix until OK / 0.
7. Commit on goal/research-openscreen; write results JSON.

## Done
- Steps 1-4. Evidence gathered from docs plus code spot checks (schema, CLI main, napi addon,
  compositor service, SCK helper sizing/writer, PipeWire helper headers, STT model manager,
  MCP server guards, document service atomic write).

## Unverified (described from the project's own docs, code only partly opened)
- whisper-stt C++ helper internals (VAD cut, DTW) and chunk size.
- WGC helper internals beyond grep (stop watchdog budgets, 19 kHz keepalive) - from recording.md.
- Linux webcam sidecar path - from recording.md and README.
- Agent tool count (26) - from ai-agent.md, not counted in code.

## First unfinished step
- Step 5.
