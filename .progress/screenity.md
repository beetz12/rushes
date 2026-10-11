# Progress: goal 6 (screenity, kap, bloom)

Branch: goal/research-screenity-kap-bloom

## Plan

1. Read reader brief, sources.json and both checkers. Done.
2. Read Screenity (GPL-3.0, clean-room): annotation, cursor effects, camera
   bubble, local storage, editor, UX polish. Done.
3. Read Kap (MIT): plugin system, converters, recording UI, staleness. Done.
4. Read Bloom (MIT): transcript, search, local vs cloud, agent surface. Done.
5. Write docs/research/screenity.md and .json, run both checks, commit.
6. Write docs/research/kap.md and .json, run both checks, commit.
7. Write docs/research/bloom.md and .json, run both checks, commit.
8. Run the combined checks from the goal file, write the result JSON.

## Done

- Steps 1 to 4.
- Step 5: screenity note pair written; check_research OK (16 ideas), check_clean 0.

## Unverified

- Kap clone is shallow (one commit), so staleness is inferred from pinned
  dependency versions, not from history.
- Bloom capture runs inside a closed VideoDB native binary that is not in the
  repo; whether it keeps any local copy of the media cannot be verified here.

## First unfinished step

- Step 6 (kap).
