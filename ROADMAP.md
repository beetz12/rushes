# Roadmap

Distilled from the approved build plan (`docs/PLAN.md`), which remains the
authoritative document. Status as of 2026-10-12.

**Where we are:** Phases 1-3 are implemented and benchmarked on real hardware
(5-minute 1080p30 share render: 28.6 s against a 75 s budget; 10-minute
editor-tracks export: 1.93 s against a 2 s budget — see `docs/progress/`).
Phases 4-6 are under active development. Phase 7 is deliberately closed.

| Phase | Scope | Status |
|---|---|---|
| 1. Capture engine, package format, CLI | Swift engine: four separate track files (screen, camera, mic, system audio) on one shared clock, crash-safe fragmented writers, launch recovery, `rushes` CLI over a local socket | Done |
| 2. Recording UX | Electron + TypeScript + React shell: control bar, camera bubble, countdown, hotkeys, area picker, onboarding | Done |
| 3. Review, share render, share link, viewer | Review window, export presets (share MP4, full MOV, YouTube, audio, editor tracks), S3-compatible bucket sharing, static viewer page | Done (core), hardening continues |
| 4. Transcript, captions, editing, AI metadata | On-device transcription, captions (SRT/WebVTT), clip editing, transcript word cuts, auto zoom, titles/chapters, thumbnails | In progress |
| 5. Worker share mode with feedback | Self-host Cloudflare Worker: passwords, expiry, comments, reactions | In progress |
| 6. Extras and polish | Teleprompter, cursor-free mode, MCP server, live drawing, signed auto-updating releases | Planned |
| 7. Hosted service (SaaS) | Accounts, multi-tenant sharing, web library. This lives in a separate private repository and is opened only deliberately; the local, self-hostable product stays free and unlimited | Closed until opened |

## Contribution directions we want help with

- Tests and QA breadth: more fixture-based regression tests, more CI smoke.
- Documentation: onboarding docs, self-host Worker deployment guides.
- Platform research: a Windows capture helper under the same engine contract.
- Viewer polish: themes, embeds, accessibility.
