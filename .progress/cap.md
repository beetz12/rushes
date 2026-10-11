# Progress: cap (reader goal 4)

## Plan
1. Read reader brief, checks, sources.json (done).
2. Survey clone layout: apps/desktop-gpui (ships), apps/desktop (Tauri, dev harness), apps/web, crates, packages, self-hosting compose files.
3. Answer the extra questions: recording modes, upload while recording, web viewer, self-hosting, separate tracks and project layout, crash recovery / A/V sync / encoders, MIT crates reuse value.
4. Write docs/research/cap.md and cap.json in own words, no code, no Cap-internal names outside MIT paths.
5. Run check_research.py cap and check_clean.py; fix until OK and 0.
6. Commit on goal/research-cap; write results JSON.

## Done
- Step 1.
- Clone at a32e4806b300, last commit 2026-10-10. AGENTS.md says GPUI app ships since 0.6.1; Tauri app is a dev harness.
- Recording defaults (crates/recording/src/defaults.rs): studio 60 fps (30 with camera), instant 30 fps, instant max width 1280 free / 1920 pro, crash-recovery fragmented on, <16 GB RAM -> compatibility quality.
- Studio layout (studio_recording.rs ~3120-3520): content/segments/segment-N/{display, camera, audio-input, system_audio, cursor.json, keyboard file}, content/cursors; fragmented = folder of init.mp4 + 2 s m4s + manifest.json; non-fragmented = mp4 / ogg. macOS disables fragmenting when camera active.
- Encoders (enc-ffmpeg h264.rs): bpp 0.3 quality / 1.0 ultra / 0.15 instant; macOS VideoToolbox then libx264; Windows vendor-ordered nvenc/amf/qsv/mf then libx264.
- Segmented muxer (enc-ffmpeg segmented_stream.rs): FFmpeg DASH muxer, init.mp4 + segment_NNN.m4s, atomic manifest (tmp + fsync + rename + dir fsync).
- Instant upload (desktop-gpui upload.rs): per-segment presigned PUT, 20 URL prefetch, 3 attempts, manifest every 1 s, complete signal; web playlist route builds live HLS from manifest; finalize workflow + early transcription.

## Unverified
- Instant mode camera handling on macOS (looks like the bubble is captured as part of the screen; confirm).

## First unfinished step
- Step 2 continued: web viewer, self-hosting, recovery, project crate, editor/render/export, MIT crates.
