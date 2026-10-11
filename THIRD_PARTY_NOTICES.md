# Third-party notices

One entry per copied or ported file and per direct dependency, added in the
same commit as the copy. Full licence texts live in `licenses/`.

Columns: our path | source repository | pinned SHA | source path (line range) |
licence | copyright holder as written in the source LICENSE | one-line summary
of our changes.

| Our path | Source repo | Pinned SHA | Source path | Licence | Copyright | Changes |
|---|---|---|---|---|---|---|
| Sources/RushCore/Writers/AudioSampleTiming.swift | aritropaul/voom | 410fb860b666 | Packages/VoomCore/Sources/VoomCore/Services/Capture/AudioSampleTiming.swift:1-53 | MIT (licenses/MIT-voom.txt) | Copyright (c) 2026 Aritro Paul | Added the "Derived from" provenance header; no other changes. |
| Sources/RushCore/Capture/CaptureSizing.swift | getopenscreen/openscreen | 2896c1f7b9ad | electron/native/screencapturekit/Sources/OpenScreenCaptureCore/CaptureSizing.swift:1-96 | MIT (licenses/MIT-openscreen.txt) | Copyright (c) 2025 Siddharth Vaddem; Copyright (c) 2025-2026 OpenScreen contributors | Added the "Derived from" provenance header; kept `captureOutputSize` and `evenFloor` verbatim and made them public; dropped the file's `defaultVideoBitrate` and `videoKeyFrameInterval` helpers (our Writers/TrackWriterConfiguration.swift owns the bitrate and keyframe rules per docs/PLAN.md, Track settings). |

`Sources/RushCore/Clock/SessionClock.swift`, the executable stubs, and every
other file under `Sources/RushCore/Writers/` are original code (docs/PLAN.md,
Feature matrix: project-format and Clock rows, reuse mode own-design).

Every copied or ported file must start with a header of the form
"Derived from owner/repo@sha:path (licence). See THIRD_PARTY_NOTICES.md."
`scripts/check.sh` fails when a file with such a header has no row here, or a
row names a file that does not exist.

<!-- pinned-npm-notices:start -->
## Pinned direct npm dependencies

These build and runtime dependencies are included in acknowledgements.

| Package and installed version | Licence | Full licence text |
|---|---|---|
| npm: shell/@types/node@22.18.10 | MIT | licenses/npm-types-node-22.18.10.txt |
| npm: shell/@types/react@19.2.2 | MIT | licenses/npm-types-react-19.2.2.txt |
| npm: shell/@types/react-dom@19.2.2 | MIT | licenses/npm-types-react-dom-19.2.2.txt |
| npm: shell/@vitejs/plugin-react@6.1.2 | MIT | licenses/npm-vitejs-plugin-react-6.1.2.txt |
| npm: shell/electron@44.7.0 | MIT | licenses/npm-electron-44.7.0.txt |
| npm: shell/electron-builder@26.15.3 | MIT | licenses/npm-electron-builder-26.15.3.txt |
| npm: shell/esbuild@0.28.2 | MIT | licenses/npm-esbuild-0.28.2.txt |
| npm: shell/react@19.3.0 | MIT | licenses/npm-react-19.3.0.txt |
| npm: shell/react-dom@19.3.0 | MIT | licenses/npm-react-dom-19.3.0.txt |
| npm: shell/typescript@7.0.2 | Apache-2.0 | licenses/npm-typescript-7.0.2.txt |
| npm: shell/vite@8.3.4 | MIT | licenses/npm-vite-8.3.4.txt |
| npm: shell/vitest@5.0.3 | MIT | licenses/npm-vitest-5.0.3.txt |
| npm: shell/zod@4.6.6 | MIT | licenses/npm-zod-4.6.6.txt |
<!-- pinned-npm-notices:end -->

## Sharing toolchain dependencies

All files in cloud/, viewer/ and worker/ are original implementations. No reference-clone source was opened or copied. These direct development dependencies are pinned in each applicable package-lock.json; the browser viewer and Worker have no runtime third-party dependencies.

| Dependency | Version | Used by | License text |
|---|---|---|---|
| TypeScript | 5.9.3 | cloud, viewer, worker build | Apache-2.0 (licenses/Apache-2.0-TypeScript-5.9.3.txt) |
| @types/node | 22.15.30 | cloud, worker type checking | MIT (licenses/MIT-types-node-22.15.30.txt) |
| esbuild | 0.27.0 | worker self-contained bundle | MIT (licenses/MIT-esbuild-0.27.0.txt) |
| Playwright | 1.61.1 | viewer local-browser behavior tests only | Apache-2.0 (licenses/Apache-2.0-playwright-1.61.1.txt) |
