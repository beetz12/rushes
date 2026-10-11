# Third-party notices

One entry per copied or ported file and per direct dependency, added in the
same commit as the copy. Full licence texts live in `licenses/`.

Columns: our path | source repository | pinned SHA | source path (line range) |
licence | copyright holder as written in the source LICENSE | one-line summary
of our changes.

| Our path | Source repo | Pinned SHA | Source path | Licence | Copyright | Changes |
|---|---|---|---|---|---|---|
| Sources/RushCore/Writers/AudioSampleTiming.swift | aritropaul/voom | 410fb860b666 | Packages/VoomCore/Sources/VoomCore/Services/Capture/AudioSampleTiming.swift:1-53 | MIT (licenses/MIT-voom.txt) | Copyright (c) 2026 Aritro Paul | Added the "Derived from" provenance header; no other changes. |

`Sources/RushCore/Clock/SessionClock.swift`, the executable stubs, and every
other file under `Sources/RushCore/Writers/` are original code (docs/PLAN.md,
Feature matrix: project-format and Clock rows, reuse mode own-design).

Every copied or ported file must start with a header of the form
"Derived from owner/repo@sha:path (licence). See THIRD_PARTY_NOTICES.md."
`scripts/check.sh` fails when a file with such a header has no row here, or a
row names a file that does not exist.
