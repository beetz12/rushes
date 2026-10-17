<div align="center">

# Rushes

**A Loom-style screen recorder that gives you the files.**

Screen, camera, microphone and system audio — four separate track files on one
shared clock, local-first on your Mac, drivable by your AI agents.

[![ci](https://github.com/beetz12/rushes/actions/workflows/ci.yml/badge.svg)](https://github.com/beetz12/rushes/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
![Platform: macOS](https://img.shields.io/badge/platform-macOS%2026.4%2B-333333.svg)
![Status: early alpha](https://img.shields.io/badge/status-early%20alpha-d69e2e.svg)

[Features](#features) · [Why Rushes](#why-rushes) · [Agents](#built-for-agents) ·
[Get started](#get-started) · [Sharing](#sharing-and-self-hosting) ·
[Status](#status-and-roadmap) · [Clean-room](#clean-room-provenance) ·
[Contributing](#contributing)

<!-- TODO: hero demo GIF recorded with Rushes itself. Keep it under 10 MB and
     caption it with the four-track layout. -->

</div>

Record a walkthrough for a client, capture a bug, or demonstrate code. Keep the
separate tracks when you want to edit the result for a tutorial or video.

## Features

| | | |
|---|---|---|
| 🗂️ **Your files, separate** | 🤖 **Agent-drivable** | 🔒 **Local-first** |
| Every recording is a folder with up to four untouched track files — screen, camera, mic, system audio — all starting at the same instant. Drop them on any editor timeline at zero. | A 77-command CLI with JSON output, a local control socket, and an MCP server. Start, stop, export and share from scripts and AI agents. | Recordings, transcripts and settings stay on your Mac. No account, no cloud requirement, no telemetry. Sharing goes to storage you own. |
| ⚖️ **Clean-room provenance** | ⚡ **Fast where it counts** | 🛠️ **Real editing** |
| Built from nine open-source recorders under documented clean-room rules, enforced by a check in CI. Every copied file carries its license notice. | A five-minute 1080p30 share render takes 28.6 seconds. A ten-minute editor-tracks export takes 1.93 seconds. A kill -9 mid-recording loses at most one second. | Trim and split clips, cut words from the transcript, auto-zoom from your clicks, six camera layouts, captions burned in or exported. |

## Why Rushes

Most recorders hand you one mixed file — or worse, a link to a copy that lives
in someone else's cloud. If your recording is footage you keep working with,
that's the wrong shape.

- **Four separate masters, one clock.** Screen, camera, microphone and system
  audio are written as separate files that all start at the same instant, so
  your editor (or your agent) gets clean sources instead of a bake. Per-track
  offsets live in the manifest.
- **It's a folder, not a black box.** One recording = one package:
  `screen.mov`, `camera.mov`, `mic.mov`, `system.mov`, a manifest, the input
  event log, then transcripts and captions as they are produced. Everything
  checkable with `rushes verify`.
- **Crash-safe by construction.** Fragmented writers mean a force-quit loses
  at most one second on every track, and relaunching recovers interrupted
  takes — footage is never deleted.
- **Pauses that stay honest.** A 60-second take with two 10-second pauses
  verifies at 40.03 seconds of media on every track, within 50 ms.
- **On-device transcription and metadata.** Titles, summaries, chapters and
  captions run locally; nothing is uploaded by default.
- **Export for where the video is going.** Share MP4, full-quality MOV, a
  YouTube preset, audio-only, or the original tracks plus an `offsets.json`
  for your editor.

## Built for agents

Every action is a command. The engine serves a local control socket; the
`rushes` CLI is its thin client — and the bundled agent skill tells your AI to
read the self-describing guide before anything else.

```bash
rushes guide --json              # 77 commands, self-describing contract
rushes targets                   # displays, windows, cameras, microphones (stable ids)
rushes record start --display main --camera default --mic default --duration 60 --wait
rushes verify 01M4P6VE62QFYN8D6  # every track decodable, durations within 50 ms
```

JSON on stdout, JSON errors on stderr, NDJSON progress events, stable exit
codes. An optional local MCP server exposes the same surface to tools like
Claude and Cursor.

## Get started

Rushes is in early alpha. From the app: the menu-bar icon opens the recorder,
your library and Settings — pick a display, window or area, enable camera and
audio, record. Building from source (macOS 26.4+, Swift 6.4, Node per each
surface's `.nvmrc`):

```bash
git clone https://github.com/beetz12/rushes.git
cd rushes
swift build -c release
.build/release/rushcore-engine --socket-path /tmp/rushes.sock &
.build/release/rushes --socket /tmp/rushes.sock guide --json
```

Open `shell/` for the desktop app (Electron + TypeScript + React): menu-bar
recorder, control bar, camera bubble, first-use guide, review window, exports
and settings. A signed, notarized download is on the roadmap.

## Sharing and self-hosting

Share links upload to storage you configure — Cloudflare R2 or any
S3-compatible bucket — and play on a small static viewer page with captions
and a clickable transcript. Prefer full control? The single-user share Worker
in `worker/` is part of this repository and deploys to your own Cloudflare
account. A hosted sharing tier may come later as a separate, optional
convenience; nothing local depends on it.

## Status and roadmap

Early alpha — see [ROADMAP.md](ROADMAP.md) for honest phase-by-phase status.
Phases 1–3 (engine, desktop app, review and sharing) are implemented and
benchmarked; transcription, editing and the extras continue in flight.

## Clean-room provenance

Every line of Rushes is either original or copied from permissively licensed
code with its notice attached — and a check in CI fails the build if that is
ever not true. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules and
`docs/research/` for the nine research notes behind the design.

## Clean-room rule for anyone building here

Build sessions read `docs/` and may open the permissive reference clones
(see `tools/checks/sources.json`, class `permissive`, plus the listed
permissive sub-paths). They never open the copyleft clones (Cap outside its
MIT crates, Recordly outside `services/recordly-share`, Screenity), and never
open the `copyleft_paths` files inside permissive repos (7 files in better-shot).

## Contributing

Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md) — read its clean-room
rules before your first pull request; the one gate is
`bash scripts/check.sh`. Six starter issues are labeled
`good first issue`. "Rushes" is a trademark of David He; forks must rename
(see [TRADEMARKS.md](TRADEMARKS.md)).

- `docs/research/`: clean-room notes on nine open-source recorders.
- `docs/PLAN.md`: the approved build plan.
- `docs/process/reader-brief.md`: the rules the research notes follow.
- `tools/checks/`: the scripts that verify the notes and the plan.
- [ROADMAP.md](ROADMAP.md): what's done, what's next.


## Shared browser recorder (experimental)

The experimental [browser client](browser/README.md) provides local screen/camera/
microphone recording and separate-track export, targeting pinned Chrome on
Windows and Mac. Shared CI is configured for generated-media checks on both
systems; cross-platform qualification remains in progress. The hosted account,
processing and billing backend stays private. This source publication does not
announce a production cloud launch; runtime and provider qualification continue.
