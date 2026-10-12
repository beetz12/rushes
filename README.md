# Rushes

[![ci](https://github.com/beetz12/rushes/actions/workflows/ci.yml/badge.svg)](https://github.com/beetz12/rushes/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

David's local Loom-style recorder for macOS 26.4 and later. Screen, camera,
microphone and system audio are saved as separate original tracks.

Open Rushes from Applications. Its menu-bar icon opens the recorder, your
recording library and Settings. Select a display, window or area, enable the
camera and audio sources you want, then Record. Pause and Stop are available
from the floating controls. The camera and microphone start disabled.

After Stop, review the video, trim or split clips, adjust the camera layout and
audio, or edit through the transcript. Export MP4, full MOV, YouTube video,
audio, or the original tracks for an editor. Editing preserves the originals.
Transcription and title/chapters run locally when Apple's model assets are
available; failed background jobs can be retried from Settings.

Configure sharing in Settings to create a stable web link with captions and
transcript. Credentials are encrypted locally. The optional local MCP server
starts disabled and permits reads until you explicitly enable mutations.

Recordings live in `~/Movies/Rushes`; application settings live in
`~/Library/Application Support/Rushes`. The CLI is bundled at
`Rushes.app/Contents/Resources/bin/rushes`; run `rushes guide --json` for commands.

For development, run `/bin/bash scripts/check.sh`. The gate provisions the
pinned Node runtime for each JavaScript surface, builds and tests Swift and the
desktop/cloud/viewer/Worker code, then checks source and license notices.

## Open source

Rushes is open source under [Apache-2.0](LICENSE). The local recorder — every
recording, editing and export feature, plus the self-hostable share Worker —
is free and stays free. A hosted sharing service may come later as a separate,
optional paid convenience; nothing local depends on it.

Build from source:

```bash
git clone https://github.com/beetz12/rushes.git
cd rushes
swift build -c release
.build/release/rushcore-engine --socket-path /tmp/rushes.sock &
.build/release/rushes --socket /tmp/rushes.sock guide --json
```

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) — read its clean-room
rules before your first pull request. "Rushes" is a trademark of David He;
forks must rename (see [TRADEMARKS.md](TRADEMARKS.md)).

- `docs/research/`: clean-room notes on nine open-source recorders.
- `docs/PLAN.md`: the approved build plan; public distribution and SaaS remain optional.
- `docs/process/reader-brief.md`: the rules the research notes follow.
- `tools/checks/`: the scripts that verify the notes and the plan.

## Clean-room rule for anyone building here

Build sessions read `docs/` and may open the permissive reference clones
(see `tools/checks/sources.json`, class `permissive`, plus the listed
permissive sub-paths). They never open the copyleft clones (Cap outside its
MIT crates, Recordly outside `services/recordly-share`, Screenity), and never
open the `copyleft_paths` files inside permissive repos (7 files in better-shot).
