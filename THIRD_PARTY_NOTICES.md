# Third-party notices

One entry per copied or ported file and per direct dependency, added in the
same commit as the copy. Full licence texts live in `licenses/`.

Columns: our path | source repository | pinned SHA | source path (line range) |
licence | copyright holder as written in the source LICENSE | one-line summary
of our changes.

| Our path | Source repo | Pinned SHA | Source path | Licence | Copyright | Changes |
|---|---|---|---|---|---|---|

No third-party code has been copied yet. `Sources/LoomCore/Clock/SessionClock.swift`
and the executable stubs are original code (docs/PLAN.md, Feature matrix:
project-format and Clock rows, reuse mode own-design).

Every copied or ported file must start with a header of the form
"Derived from owner/repo@sha:path (licence). See THIRD_PARTY_NOTICES.md."
`scripts/check.sh` fails when a file with such a header has no row here, or a
row names a file that does not exist.
