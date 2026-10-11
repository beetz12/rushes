# Goals: clean-room research notes for the Loom clone (2026-10-10)

Six independent reader goals. Each writes only its own `docs/research/<slug>.*`
files. Shared rules: `docs/process/reader-brief.md`. Plan stage runs after
these merge, as a separate solo loop.

### Goal 1: Research Screendrop

**Suggested branch:** `goal/research-screendrop`
**Model:** `opus`
**Effort:** `high`
**Parallelization:** independent

```text
You are reader goal 1 in a clean-room research run for David's Loom clone.
Your working directory is your goal worktree of ~/Work/loom-clone (the repo root).
First read docs/process/reader-brief.md completely and follow it exactly. It overrides anything below that conflicts with it.

Slug: screendrop
Clone: ~/Work/reference-repos/loom/fayazara__Screendrop (pinned SHA and licence in tools/checks/sources.json). Licence class: permissive (CC0-1.0), so you may name its files and types, and ideas may use copy-with-notice.

This is the leading candidate base for David's recorder, so go deepest here. Beyond all 19 feature areas, establish exactly:
- How screen, camera, microphone and system audio are captured, and how the camera ends up in its own file. How the tracks stay in sync (shared clock, start timestamps, offsets).
- The capture coordinator: states, start/stop/pause, error and permission handling, crash safety of partially written files.
- On-device transcription and any transcript-based editing.
- Sharing: where the Cloudflare (or other) upload and share-link code lives, what is uploaded, and how links are generated. The earlier survey could not find this code; find it or state that it is absent.
- Export folder and on-disk layout of a recording.
- Any .agents or AI prompt files: what they say about how the repo is meant to be developed.

Deliverables: docs/research/screendrop.md, docs/research/screendrop.json and your .progress/<first slug>.md file, committed on your branch.
Done when: `python3 -I tools/checks/check_research.py screendrop` prints OK and `python3 -I tools/checks/check_clean.py docs/research/screendrop.md docs/research/screendrop.json` prints 0 on its first line.
```

### Goal 2: Research better-shot and voom

**Suggested branch:** `goal/research-better-shot-voom`
**Model:** `opus`
**Effort:** `high`
**Parallelization:** independent

```text
You are reader goal 2 in a clean-room research run for David's Loom clone.
Your working directory is your goal worktree of ~/Work/loom-clone (the repo root).
First read docs/process/reader-brief.md completely and follow it exactly. It overrides anything below that conflicts with it.

Slugs: better-shot and voom. Write one note pair per slug.
- better-shot: ~/Work/reference-repos/loom/KartikLabhshetwar__better-shot, BSD-3-Clause, permissive. Note: its camera recorder file is a near-copy (about 99% similar) of Screendrop's CameraRecordingManager.swift, added later; do not credit better-shot as the origin of that code, and focus on what better-shot adds: camera layouts, the teleprompter, export formats, screenshot tooling, any AI features, and its .agents/.claude skill files.
- voom: ~/Work/reference-repos/loom/aritropaul__voom, MIT, permissive. A small Swift Loom alternative; capture its whole design, including recording flow, camera bubble, and any upload or sharing.

Deliverables: docs/research/better-shot.md, docs/research/better-shot.json, docs/research/voom.md, docs/research/voom.json and your .progress/<first slug>.md file, committed on your branch.
Done when: `python3 -I tools/checks/check_research.py better-shot voom` prints OK and `python3 -I tools/checks/check_clean.py docs/research/better-shot.md docs/research/better-shot.json docs/research/voom.md docs/research/voom.json` prints 0 on its first line.
```

### Goal 3: Research OpenScreen

**Suggested branch:** `goal/research-openscreen`
**Model:** `opus`
**Effort:** `high`
**Parallelization:** independent

```text
You are reader goal 3 in a clean-room research run for David's Loom clone.
Your working directory is your goal worktree of ~/Work/loom-clone (the repo root).
First read docs/process/reader-brief.md completely and follow it exactly. It overrides anything below that conflicts with it.

Slug: openscreen
Clone: ~/Work/reference-repos/loom/getopenscreen__openscreen (MIT, permissive). TypeScript/Electron app plus a Rust compositor crate.

Beyond all 19 feature areas, establish exactly:
- The project file format (the .openscreen document): what it stores, how sources and edits are represented.
- The Rust compositor: what it renders (webcam picture-in-picture, backgrounds, cursor, zoom), how Electron talks to it.
- The CLI (electron/cli/cliMain.ts and related): commands, JSON output, how an agent could drive export.
- On-device captions and the AI edit assistant: models used, what runs locally, what calls out.
- Capture on macOS versus Linux (PipeWire) and Windows.

Deliverables: docs/research/openscreen.md, docs/research/openscreen.json and your .progress/<first slug>.md file, committed on your branch.
Done when: `python3 -I tools/checks/check_research.py openscreen` prints OK and `python3 -I tools/checks/check_clean.py docs/research/openscreen.md docs/research/openscreen.json` prints 0 on its first line.
```

### Goal 4: Research Cap

**Suggested branch:** `goal/research-cap`
**Model:** `opus`
**Effort:** `high`
**Parallelization:** independent

```text
You are reader goal 4 in a clean-room research run for David's Loom clone.
Your working directory is your goal worktree of ~/Work/loom-clone (the repo root).
First read docs/process/reader-brief.md completely and follow it exactly. It overrides anything below that conflicts with it.

Slug: cap
Clone: ~/Work/reference-repos/loom/CapSoftware__Cap (4,725 files). Licence: AGPL-3.0 for everything EXCEPT crates/camera*, crates/scap-* (MIT) and vendor/* (third-party permissive). Class: copyleft. So: outside the MIT paths, describe behaviour and design only, never reproduce Cap's own internal names, and use clean-room or idea-only. Ideas whose paths are all inside crates/camera* or crates/scap-* may use copy-with-notice.

Cap is the most complete open-source Loom clone. It is large: read selectively (apps/desktop, apps/web, and the crates that matter), and checkpoint your .progress/cap.md file often. Beyond all 19 feature areas, establish:
- Recording modes (for example an instant/share-fast mode versus a studio/edit-later mode): what differs in capture, files and upload.
- How upload or share-link creation can start while recording is still running, and what the viewer gets first.
- The web viewer: playback, comments, reactions, view analytics, transcripts.
- Self-hosting: what services are needed, storage (S3-compatible), database, auth.
- Separate tracks: whether camera, mic and system audio are stored separately, and the on-disk project layout.
- Crash recovery, A/V sync, encoding choices, hardware encoders.
- What the MIT camera and screen-capture crates give a new project that wants to reuse them.

Deliverables: docs/research/cap.md, docs/research/cap.json and your .progress/<first slug>.md file, committed on your branch.
Done when: `python3 -I tools/checks/check_research.py cap` prints OK and `python3 -I tools/checks/check_clean.py docs/research/cap.md docs/research/cap.json` prints 0 on its first line.
```

### Goal 5: Research Recordly

**Suggested branch:** `goal/research-recordly`
**Model:** `opus`
**Effort:** `high`
**Parallelization:** independent

```text
You are reader goal 5 in a clean-room research run for David's Loom clone.
Your working directory is your goal worktree of ~/Work/loom-clone (the repo root).
First read docs/process/reader-brief.md completely and follow it exactly. It overrides anything below that conflicts with it.

Slug: recordly
Clone: ~/Work/reference-repos/loom/webadderallorg__Recordly (1,151 files). Licence: AGPL-3.0 for everything EXCEPT services/recordly-share (MIT). Class: copyleft. Outside services/recordly-share, describe behaviour and design only, never reproduce Recordly's own internal names, and use clean-room or idea-only. Ideas whose paths are all inside services/recordly-share may use copy-with-notice.

Recordly is the most-starred repo in the set (about 33,000 stars). Beyond all 19 feature areas, establish:
- The Electron app plus its native macOS capture helpers (ScreenCaptureKit): process model and how frames and audio reach the encoder.
- The webcam bubble and any auto-zoom, cursor smoothing or click effects: what makes them look polished.
- The share service (services/recordly-share, MIT) and the supabase folder: upload flow, link format, storage, viewer.
- Editing and export features, formats and speed.
- What accounts for its popularity: features users clearly value.

Deliverables: docs/research/recordly.md, docs/research/recordly.json and your .progress/<first slug>.md file, committed on your branch.
Done when: `python3 -I tools/checks/check_research.py recordly` prints OK and `python3 -I tools/checks/check_clean.py docs/research/recordly.md docs/research/recordly.json` prints 0 on its first line.
```

### Goal 6: Research Screenity, Kap and Bloom

**Suggested branch:** `goal/research-screenity-kap-bloom`
**Model:** `opus`
**Effort:** `high`
**Parallelization:** independent

```text
You are reader goal 6 in a clean-room research run for David's Loom clone.
Your working directory is your goal worktree of ~/Work/loom-clone (the repo root).
First read docs/process/reader-brief.md completely and follow it exactly. It overrides anything below that conflicts with it.

Slugs: screenity, kap and bloom. Write one note pair per slug.
- screenity: ~/Work/reference-repos/loom/alyssaxuu__screenity, GPL-3.0, copyleft. A Chrome extension recorder. Describe behaviour and design only, never reproduce its internal names, and use clean-room or idea-only. Focus: annotation and drawing tools, cursor and click effects, camera overlay in the browser, local-only storage, the editor, and its UX polish.
- kap: ~/Work/reference-repos/loom/wulkano__Kap, MIT, permissive. Electron macOS recorder, last commit 2024. Focus: the plugin system for share targets, export formats (GIF, MP4, WebM, APNG) and the conversion pipeline, the recording UI, and lessons from why it went stale.
- bloom: ~/Work/reference-repos/loom/video-db__bloom, MIT, permissive. Local-first, "AI-ready" recorder. Focus: transcripts, embeddings or search over recordings, what is local versus cloud, and agent-facing interfaces.

Deliverables: docs/research/screenity.md, .json, docs/research/kap.md, .json, docs/research/bloom.md, .json and your .progress/<first slug>.md file, committed on your branch.
Done when: `python3 -I tools/checks/check_research.py screenity kap bloom` prints OK and `python3 -I tools/checks/check_clean.py docs/research/screenity.md docs/research/screenity.json docs/research/kap.md docs/research/kap.json docs/research/bloom.md docs/research/bloom.json` prints 0 on its first line.
```
