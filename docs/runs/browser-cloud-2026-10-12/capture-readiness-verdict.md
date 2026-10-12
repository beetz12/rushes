# Independent C3 composition-readiness verdict

**PASS for the C3 startup repair at `37c7838f213c3bce9e40e0a627e82ea0396d8245`.**
This is a narrow startup result. It does not establish ten-minute capture,
background/minimized recording, physical Windows/Mac permissions, or paid launch.

The checker did not author this repair. Review ran in the isolated
`codex/rushes-browser-c3-review` checkout under Node22.22.0, using synthetic streams
and fresh browser profiles only. No real device, shared GUI, provider account,
Beads state or public repository was changed. The subsequent filesystem-path
repair was copied as `7987d00` (root equivalent `95aa8f7`); it changes test paths,
not the C3 capture implementation.

## Source and ownership checks

- `composition.worker.ts:45–47` sends readiness only after drawing the required
  inputs and successfully writing the first generated frame. Screen plus camera
  waits for both inputs; camera-only and screen-only have their own driving input.
- `index.ts:120` rejects initialization immediately on source failure, rather than
  waiting for the ten-second missing-output deadline. The existing release path
  stops original/cloned/generated tracks, closes audio, and terminates the worker.
- `index.ts:248–270` clears the initialization timeout on settled readiness/error,
  rejects a late ready event after release, and checks ownership again before
  returning a session. A successful generated write is not an assertion that an
  encoder already wrote its first sample.
- The shared epoch and measured recorder offsets remain in place. Protected
  duration, offset spread, decoded audiovisual drift, source-loss and recovery
  assertions were not relaxed by the repair.

## Fresh behavioral evidence

Private proof root: `~/.goal-loop/loom-clone/host/2026-10-12-browser/candidate-review/`.

| Command / probe | Result |
|---|---|
| Browser TypeScript/Vite build | Exit0; actual assets built. |
| `npm --prefix browser run test:capture`, explicit Chrome155.0.8059.39 | Exit0,18/18; delayed700ms camera, pre-output source loss, separate originals/composition, pause offsets, decoded calibration and recovery checks pass. |
| Same command, official Chrome154.0.8037.92, run sequentially | Exit0,18/18; original cold-start and delayed-camera timing assertions pass. |
| Independent `late-ready-probe.mjs`, explicit Chrome155 | Ready was received once, then deliberately delivered to the coordinator after source loss and worker termination. Creation rejected in150.3ms; no session escaped, every source ended, no draft appeared. Exactly one termination and one late ready delivery were observed. |

Logs are `browser-build.log`, `capture-155.log`, `capture-154.log`; the independent
race instrument/result are `late-ready-probe.mjs` and `late-ready.json`. An initial
exploratory race run used bundled Chrome149 and is retained separately as
`late-ready-exploratory-149.json`; named-version acceptance uses the explicit155 run.

## Retained limits

The full candidate reviewer found a separate maximum-take metadata seam: automatic
Stop preserves a wall-clock duration slightly beyond the limit, while the service
accepts no manifest beyond600000ms. That finding is recorded separately in the
whole-candidate verdict and does not invalidate this startup barrier result.
Retained M1 runs interrupted before their target duration; observer-free testing
also stalled. No additional long run was launched by this reviewer, and no
sustained-source cause was inferred from the passing startup tests.
