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

- Recovery (recovery.rs 285-330, 849-900): startup scan of projects whose meta says in-progress or needs-remux; lock; keep complete m4s (>=100 B, valid tail); concat + merge + decode-validate; atomic publication journal. track_heal.rs: load-time rewrite of stretched camera/display timestamps.
- Start gate (output_pipeline/start_gate.rs): pipelines warm up during countdown; frames before arm dropped; 20 s failsafe. Timestamp crate: Instant + SystemTime + mach/QPC; audio master clock 48 kHz.
- Instant mode on macOS keeps camera bubble in screen capture (desktop-gpui recording.rs ~2214); studio excludes it and records camera separately. Share link created before recording (upload.rs 220-256). Upload resume + SHA-256 verification (crates/recording/src/upload_resume.rs, upload_verification.rs).
- Viewer: playlist route makes live HLS from manifest; RecordingInProgress overlay; live AssemblyAI transcript captions; swaps to MP4 after finalize.
- Self-host compose: cap-web, media-server (ffmpeg, Hono), MySQL 8, MinIO + mc setup; default secrets in compose.
- Export: MP4 presets bpp 0.3/0.15/0.08/0.04 (CRF 24/28/32/36), GIF, MOV ProRes. Render: wgpu layers + WGSL shaders. Auto-zoom from clicks (Tauri recording.rs 6366-6446).
- Local captions: whisper-rs + parakeet-rs (desktop-gpui transcription.rs). Camera bubble: round/square/full, 150-600 px, default 230 (camera_window.rs).
- MIT crates surveyed: camera (enumeration, VID/PID model id, Native vs Compatibility mode, frame-duration pin), camera-avfoundation, camera-effects (Vision / ONNX selfie seg + blur, has two .onnx assets), scap-screencapturekit (thin cidre wrapper), scap-targets (displays/windows/notch), scap-cpal, scap-ffmpeg, scap-direct3d.

## Unverified
- (none outstanding)

## First unfinished step
- Step 2 tail: comments/reactions/analytics schema, BYO S3, CLI/MCP/agent API, permissions, packaging, privacy. Then step 4 (write notes).
