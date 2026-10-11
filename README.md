# loom-clone (working name)

David's own Loom-style screen and camera recorder. No app code yet.

- `docs/research/`: clean-room notes on nine open-source recorders.
- `docs/PLAN.md`: the build plan (written after the research merges).
- `docs/process/reader-brief.md`: the rules the research notes follow.
- `tools/checks/`: the scripts that verify the notes and the plan.

## Clean-room rule for anyone building here

Build sessions read `docs/` and may open the permissive reference clones
(see `tools/checks/sources.json`, class `permissive`, plus the listed
permissive sub-paths). They never open the copyleft clones (Cap outside its
MIT crates, Recordly outside `services/recordly-share`, Screenity), and never
open the `copyleft_paths` files inside permissive repos (7 files in better-shot).
