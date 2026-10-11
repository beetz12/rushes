# Planner brief: Loom-clone clean-room research (2026-10-10)

Beads: openbrain-clv5. Owner: David He. Planned and run by the session that
also reads the copyleft notes, so that session must not write the app.

## Scope

1. Study nine open-source screen recorders (pinned in
   `tools/checks/sources.json`) and write one clean-room research note per repo
   (`docs/research/<slug>.md` + `.json`). Six parallel reader goals.
2. After the readers merge, a separate solo loop writes `docs/PLAN.md`: a
   comprehensive build plan for David's own Loom clone that integrates the best
   ideas, with the source and licence of each idea.

## Constraints

- Clean room: copyleft code (Cap outside its MIT crates, Recordly outside
  `services/recordly-share`, Screenity) never crosses into this repo. Notes
  carry behaviour and design in the readers' own words; no fenced code.
- Clones are read-only reference data under `~/Work/reference-repos/loom`.
  Nothing there is built or executed.
- Future build sessions read `docs/` and the permissive clones only.
- No external actions: no pushes to a remote, no posts, no installs.

## Risks

- A reader paraphrases too closely. Mitigation: `check_clean.py` (12-word
  overlap with copyleft source, minus anything also in permissive source),
  calibrated on 2026-10-10: copied Recordly text 17 hits, copied Cap AGPL text
  35 hits, Cap MIT text 0, original prose 0.
- Shallow notes. Mitigation: required sections, per-area JSON for all 19
  areas, minimum inspected paths that must exist in the clone, minimum idea
  counts; later the plan must account for every idea id.
- Context blowout on Cap (4,725 files). Mitigation: one reader per large repo,
  targeted reading, PROGRESS.md checkpoints.

## Verification

- Per goal (maker self-check): `check_research.py <slug>` OK and
  `check_clean.py` 0.
- Integration gate (independent, non-LLM): `check_research.py --present` and
  `check_clean.py docs/research` on the merged branch.
- Plan stage: `check_plan.py` (structure, all 19 areas in the matrix, every
  idea id accounted for, copy-with-notice only from permissive sources),
  `check_clean.py docs` = 0, and a rubric scored by a non-Claude model family.
