# Recordly: clean-room research note

Reader goal 5. Everything outside `services/recordly-share` is AGPL, so this note describes behaviour and design in my own words and names only public platform APIs, file paths and the MIT share service. Facts marked "helper pass" were gathered by a read-only search helper I briefed, then spot-checked by me against the files listed under Inspected paths; everything else I read directly.

## Snapshot

- Repo: `webadderallorg/Recordly`, cloned at `~/Work/reference-repos/loom/webadderallorg__Recordly`.
- Pinned SHA: `535d1cfafa87` (clone HEAD 535d1cfafa87cc318db6f2b57b70b6c1c1079862). The clone is shallow (one commit), so history-based claims are not possible.
- Licence: AGPL-3.0 (MIT: services/recordly-share). Class: copyleft. Only `services/recordly-share` is permissive. That folder is itself adapted from the MIT project Voom (Aritro Paul), so copied code must carry both the Voom and the Recordly MIT notices.
- Stars: about 33,075 (sources.json), the most-starred repo in the set.
- Latest commit date in the clone: 2026-10-07. App version in the package manifest: 1.4.0.
- Stack: Electron 43 main process plus a React 19, Vite and TypeScript renderer; PixiJS 8 with pixi-filters for the preview and export scene; WebCodecs, a WebM/MP4 demuxer and a JS MP4 muxer for export; small native helpers in Swift (ScreenCaptureKit capture, cursor monitor, window list, system cursor export), C++ for Windows (Windows Graphics Capture, DXGI, Media Foundation H.264, WASAPI, a cursor monitor, a D3D11 export compositor), a CUDA export compositor, prebuilt whisper.cpp binaries, and static FFmpeg/FFprobe. The share service is a Cloudflare Worker (plain JS) on D1 and R2 with an Astro and React viewer. A Supabase folder holds Deno edge functions and SQL for feedback and export-error reports.
- Platforms: macOS 14+ on arm64 and x64, Windows 10 build 19041+, Linux as an AppImage. Shipped through GitHub Releases with an auto-updater, a Homebrew cask, winget and an externally maintained AUR package.

## What it does

Recordly is a desktop screen recorder whose real product is the editor that opens the moment you stop. You pick a display or a window from a small floating control bar, optionally turn on the microphone, system audio and a camera, sit through a short countdown, and record. When you stop, the app opens the take in a timeline editor that already contains automatic zoom regions built from your clicks, a re-drawn and smoothed cursor, a wallpaper or gradient backdrop with padding, rounded corners and a drop shadow, and a camera bubble placed in a corner.

In the editor you cut and reorder clips, change speed, add or adjust zooms, add text, image, arrow and blur annotations, add extra audio, crop, pick an output aspect ratio, and generate captions with a local Whisper model. You export an H.264 MP4 or a GIF; there is a deep set of export back ends, including hardware encoders and a Windows GPU compositor. Work is saved as a JSON project file next to the raw media, so every effect stays editable later.

It also ships a self-hostable share service: a Cloudflare Worker that stores a rendered MP4 in R2 and serves a viewer page with timestamped comments, reactions, captions, password protection and expiry. At this SHA the desktop app only talks to the vendor's origin or a localhost development server, and it uploads only after a dedicated share render; it never uploads while recording. There is no teleprompter, no LLM feature and no CLI.

## Feature inventory

- capture-screen (4/5): on macOS a single-file Swift helper drives ScreenCaptureKit at a 60 fps floor, NV12 with BT.709 colour, a capture queue depth of six, the system cursor turned off and the app's own process excluded. Window capture records the whole display and crops each frame to the window's current rectangle, re-checking position every half second and stopping cleanly if the window disappears. Windows uses a Windows Graphics Capture helper with the same command protocol; Linux and old Windows fall back to Electron capture or an FFmpeg grabber.
- capture-camera (3/5): the camera is recorded in the renderer with MediaRecorder at 1280x720, 30 fps and 8 Mbps, preferring MP4/H.264 and falling back to WebM. It lands in its own file beside the screen file, with a millisecond start offset stored in a small JSON manifest.
- capture-audio (4/5): through ScreenCaptureKit the helper writes system audio and microphone to separate AAC files (48 kHz stereo; 160 and 128 kbps) and also mixes one audio track into the MP4 (192 kbps) so the screen file plays alone. When native microphone capture is unavailable, the renderer records the mic with voice processing mostly off and FFmpeg cleans it offline.
- recording-controls (4/5): a transparent always-on-top bar with source, mic, camera and countdown popovers, pause and resume, a tray icon that changes while recording, a resizable floating camera preview, and default protection that keeps the bar and preview out of the recording.
- camera-overlay (4/5): the bubble is composited at edit time, not burned in during capture. It is a superellipse ("squircle") with adjustable roundness, nine anchor presets or a custom spot, mirroring, a two-layer shadow, and an optional mode that shrinks the bubble as the screen zooms in.
- annotation (3/5): text, image, arrow and blur regions on the timeline, positioned in percentages and rendered inside the zoomed camera layer.
- compositing-render (5/5): one PixiJS scene model drives both preview and export: a spring-smoothed camera, directional and radial motion blur, a re-drawn cursor with smoothing, tilt, click squash and click rings, and styled backgrounds. This is the polish users come for.
- editing (4/5): a clip-sequence timeline (each clip keeps its source in-point and a speed factor), trims as uncovered ranges, zoom regions, audio regions, crop, snapping within 8 screen pixels, undo, and auto-zoom suggestions on fresh recordings.
- transcription-captions (4/5): local whisper.cpp with the small model downloaded on demand, mic and system audio transcribed separately and merged, phrase re-segmentation using silence detection, SRT and VTT sidecars, and burned-in captions with word highlighting.
- ai-features (0/5): no LLM, summary, chapter or filler-word feature in the app. Auto-zoom is rule-based. The share schema has summary, chapter and speaker columns, but the desktop never fills them.
- export-formats (4/5): MP4 (H.264 High down to Baseline, AAC) at 24, 30 or 60 fps, and GIF at 15 to 30 fps. Several encode routes with hardware preference and automatic fallback. No WebM, HEVC or ProRes output.
- project-format (4/5): a versioned JSON project (the `.recordly` extension, registered as a document type on macOS) that points at the source media and stores all editor state, plus sidecars for cursor telemetry, the camera link and companion audio. Saves are atomic and keep a previous generation.
- sharing-hosting (3/5): the MIT worker is solid (256-bit link codes, single or 25 MiB multipart upload, range streaming, passwords, expiry, owner library, hosted-mode quotas). The desktop side is narrow: the endpoint is a build-time constant limited to the vendor origin or localhost, and only the rendered MP4, a title, notes and a poster frame are sent.
- viewer-web (4/5): a custom player with speed, picture-in-picture, keyboard shortcuts, start-at-time links, comments and reactions shown as timeline markers, a transcript tab, chapters, an end card, an embed page and crawler-friendly preview cards.
- teleprompter-scripts (0/5): absent.
- platform-packaging (4/5): electron-builder DMG and ZIP per architecture with hardened runtime and entitlements, NSIS on Windows, an AppImage on Linux, a Homebrew cask, a winget workflow, update channels, and Swift helpers compiled with swiftc for a macOS 14 target and committed as prebuilt binaries.
- performance-reliability (4/5): careful writer finalisation, a decode test of every new recording, capture diagnostics, adaptive export backpressure and many fallbacks. Weak spot: the screen file is a classic MP4 finalised only at stop, and the camera and fallback mic are held in renderer memory until stop.
- extensibility-automation (2/5): a documented extension API exists, but the in-app extension manager is now a placeholder that says extensions are disabled. The only automation is an environment-variable headless export test mode that opens a file, exports an MP4 and writes a JSON report.
- privacy-security (4/5): local-first storage, a loopback-only media server with a path allowlist, strict trust checks on share responses, an opt-in and previewed export-error report that carries no identity, and permission prompts that deep-link to the right System Settings pane.

## Architecture

**Process model.** Electron's main process owns state, windows and every child process. The renderer hosts three UIs: the floating control bar, the editor and a countdown overlay. Capture on macOS is a separate command-line helper per recording. The main process starts it with a JSON config as the only argument (fps, display or window id, output paths, audio switches, mic device, process ids to exclude). The helper accepts plain-text commands on stdin (pause, resume, stop) and reports readiness, pause, resume and the final file path as lines on stdout, with machine-readable error tokens on stderr for permission denial, missing native mic support and a vanished window. End of stdin counts as stop, so if Electron dies the helper still finalises the file. The Windows helper speaks the same protocol, so the main process treats both platforms alike. A second Swift helper reports the system cursor shape every 50 ms (only on change) and mouse button events from a listen-only event tap.

**How frames and audio reach the encoder (macOS).** ScreenCaptureKit delivers sample buffers on one serial queue. Only frames whose status is complete are used. The first frame the asset writer accepts defines time zero for every track; audio arriving before that is dropped, and audio arriving late is placed later so the audio files gain leading silence (a Continuity Camera mic can lag one to two seconds). Pause is implemented in the helper: while paused, samples are dropped, and on resume the paused span is subtracted from later timestamps, anchored on the next video frame so audio cannot push video time backwards. Display capture appends buffers to AVFoundation's asset writer with encoder settings taken from the output-settings assistant's 4K preset and BT.709 colour tags. Window capture instead renders each frame through Core Image into a pooled BGRA buffer cropped to the window. System audio goes to its own M4A and to the MP4's audio track; the microphone goes to its own M4A and only joins the MP4 track when system audio is off, to avoid doubling. At stop, the helper waits up to one second for the encoder queue before adding a tail frame, skips the tail frame rather than risk an uncatchable exception, caps any audio tail at two seconds past the last frame, and reports a failure if any writer did not complete. The main process then moves the audio files to names derived from the video name and runs FFmpeg to decode the first frame and read the duration before handing the file to the editor.

**Camera and microphone fallback.** The renderer prepares the camera recorder before capture starts and starts it right after the native helper resumes from the countdown. The camera start time minus the main start time, in wall-clock milliseconds, becomes the offset stored in the session manifest. The browser mic fallback records WebM, and the main process converts it to 48 kHz mono PCM WAV through an FFmpeg chain (declip, declick, band limits, light FFT denoise, then either speech normalisation or a limiter), with a timing JSON beside it.

**Countdown warm start.** The helper is started before the countdown and immediately paused, and the countdown runs while the pipeline is already warm. Resume therefore begins recording with no start-up gap, and readiness is only signalled after the writer accepted a real frame.

**Editor and render.** The editor loads the screen file, the camera file, the cursor telemetry and any audio sidecars through a loopback HTTP server on a random port that only serves real paths the main process has approved, with byte-range support. One scene model computes, for every output time, the active clip and source time, the zoom target, the spring-smoothed camera, the cursor pose and effects, the bubble rectangle and the annotations. Preview applies it with PixiJS plus CSS for the backdrop and a DOM element for the camera; export draws the same values onto a canvas (helper pass, spot-checked).

**Export.** On macOS and Windows the default route decodes with WebCodecs, renders each frame with PixiJS, encodes H.264 with a hardware-preferred WebCodecs encoder in Annex B form, and streams the chunks to FFmpeg, which only copies them into an MP4. If that fails the export restarts once with a pure WebCodecs route that muxes in JavaScript. Separate routes send raw frames to FFmpeg with a probed hardware encoder (VideoToolbox on macOS, NVENC, QSV, AMF or Media Foundation on Windows, libx264 last), and a static-layout route on Windows uses a CUDA or D3D11 compositor when the project has no annotations, captions, camera or click effects. Queue depths adapt to core count and pixel rate. Bitrate scales with resolution from 8 Mbps at 720p to 45 Mbps at 4K for source quality, rises with the square root of frame rate above 30, and is cut by half or a fifth for the fast and balanced modes (helper pass, spot-checked).

**Storage.** Recordings go to a recordings folder in the user's app-data area (relocatable in settings), with projects in a Projects subfolder and PNG previews beside each project. Per-take sidecars: system and mic audio, a cursor telemetry JSON (version 2, normalised positions at about 30 Hz, capped at one hour), the camera file and a session manifest with the offset. Project saves write a synced temporary file, preserve the old file as a backup generation, rename into place and sync the folder, queued per path.

**Share service (MIT).** A Cloudflare Worker with a D1 database, an R2 bucket and static assets. The client reserves a recording, uploads with one PUT (up to 50 MB in hosted mode) or R2 multipart in 25 MiB parts, then posts metadata to publish. The returned link is `/s/<code>`, where the code is 64 lowercase hex characters from 32 random bytes. Video is streamed from R2 with single-range support; passwords are hashed with PBKDF2-SHA256 (210,000 iterations) and unlock sets an HMAC cookie; a daily cron deletes expired items. Self-host mode is a single-owner library validated against Supabase auth; hosted mode adds per-account quotas (five recordings, 1 GB each, 14-day expiry), idempotent multipart sessions, per-recording locks and fail-closed rate limiting. Crawlers get an Open Graph player page instead of the app.

**Supabase folder.** Not used for media. It stores account-linked feedback reports with a per-account daily quota enforced by an edge function, and anonymous export-error reports limited to an allowlisted 4 KiB payload, a global rate cap and 30-day retention. It also holds the sign-up and magic-link email templates.

## Best ideas

1. **Capture helper as a tiny line-protocol child process** (capture-screen, clean-room). JSON config in, text commands on stdin, status lines out, error tokens on stderr, and end-of-input means finalise. Why: it isolates the fragile capture code, gives an agent-friendly control surface for free, survives a parent crash, and lets macOS and Windows helpers share one contract.
2. **One time zero for every track** (capture-audio, clean-room). The first accepted video frame anchors all files; earlier audio is dropped and late audio is padded with leading silence, while system audio and mic go to separate files plus a mixed track inside the video. Why: separate, editable sources that line up without manual nudging, which is exactly what David's editor consumes.
3. **Camera file plus offset manifest** (project-format, idea-only). The camera is its own file and a small versioned JSON beside the screen file names both files and the offset in milliseconds, with a filename convention as a fallback. Why: it maps one-to-one onto David's screen file plus camera file plus offset input. Improve on it by deriving the offset from media timestamps rather than wall-clock milliseconds.
4. **Warm-start countdown** (recording-controls, clean-room). Start the capture pipeline, pause it, run the countdown, then resume; report readiness only after the writer accepts a real frame. Why: Loom-style instant start with no lost first second.
5. **Cursor as data, re-rendered** (compositing-render, clean-room). Hide the OS cursor in capture, record normalised positions at about 30 Hz plus click events and cursor shape, then draw a vector cursor with a spring follower, speed-based tilt, a short squash on click, optional click rings and motion blur; snap instead of springing across time jumps. Why: this is most of what makes recordings look professionally produced.
6. **Click-cluster auto-zoom with a safe-zone camera** (editing, clean-room). Group clicks less than 2.5 s apart into one zoom with half a second of lead-in and tail, default depth 1.8x, and pick the focus by click kind. While zoomed, only pan when the cursor leaves an inner box inset 25 percent per side, and turn two nearby zooms into one pan instead of out-and-in. Why: auto-zoom is the headline feature, and these rules avoid the seasick look of naive cursor-following.
7. **Bubble composited at edit time, reacting to zoom** (camera-overlay, idea-only). Keep the camera separate, render it as a squircle with a two-layer shadow, let the user move, resize, mirror or hide it after recording, and optionally scale it down while the screen is zoomed in. Why: Loom-style bubble without baking it into the pixels.
8. **Keep your own controls out of the recording** (recording-controls, clean-room). Exclude the app's own process from the ScreenCaptureKit filter and set window content protection while recording, while the floating camera preview stays visible to the user. Why: no control bar or self-preview leaking into takes.
9. **Defensive finalisation and post-stop decode test** (performance-reliability, clean-room). Bounded wait for the encoder queue, skip the optional tail frame instead of crashing, check writer state before ending, fail loudly on a half-written file, then decode one frame with FFmpeg before opening the editor. Why: long high-resolution takes are where recorders lose files.
10. **Render with the GPU, let FFmpeg only remux** (export-formats, clean-room). Encode H.264 with the hardware WebCodecs encoder and stream elementary-stream chunks to FFmpeg for an MP4 copy, with a one-shot fallback route and core-aware queue sizes. Why: fast export without shipping a custom muxer, and one scene model for preview and export.
11. **Self-hosted share worker on R2 and D1** (sharing-hosting, copy-with-notice). Reserve, upload (single or resumable 25 MiB multipart), publish; 256-bit hex codes, range streaming, PBKDF2 passwords with an HMAC cookie, expiry cron, Open Graph card for crawlers. Why: a near drop-in for "share links on storage David controls" under MIT.
12. **Viewer with timestamped feedback** (viewer-web, copy-with-notice). Comments pinned to playback time and drawn as clustered markers, emoji reactions, a click-to-seek transcript tab, `?t=` links, speed control and an end card. Why: the Loom viewer experience in a small Astro and React bundle.
13. **Local Whisper captions that avoid hallucinated text** (transcription-captions, clean-room). Prefer the mic file, transcribe mic and system audio separately and let the mic win on overlap, re-split phrases at long word gaps or detected silence, merge very short captions, and drop words that fall entirely inside silence. Write SRT and VTT sidecars. Why: offline, private captions of better quality than raw Whisper segments.
14. **Atomic project save with one backup generation** (project-format, clean-room). Synced temp file, keep the previous file as a backup, rename, sync the folder, one queue per path. Why: projects survive crashes mid-save.
15. **Dry mic capture, cleaned offline** (capture-audio, clean-room). Record the fallback mic without automatic gain control and restore level offline with declip, declick, band limits, light denoise and a limiter. Why: avoids the crackle real-time gain control causes on some headsets.
16. **Headless export switch as an agent seam** (extensibility-automation, idea-only). An environment-driven mode opens a recording or project, exports, writes a JSON result and quits. Why: the seed of the CLI David wants; make it a real command with a stable JSON contract.
17. **Privacy-minimal, previewed error reports** (privacy-security, idea-only). Only allowlisted codes and numbers, shown to the user before an explicit send, no identity, short retention. Why: diagnostics without eroding a local-first promise.

## Weaknesses and gaps

- Not crash-safe during capture. The screen file is a normal MP4 whose index is written at stop; if the helper itself is killed or the machine loses power the take is lost. Camera and fallback-mic chunks sit in renderer memory until stop. There is no fragmented MP4 or segment output.
- The camera offset is a wall-clock millisecond difference between two recorder starts, not a media-timestamp alignment, and the camera is limited to 720p30 through MediaRecorder rather than AVFoundation.
- Sharing is narrow: the endpoint is a build-time constant locked to the vendor origin or localhost, so a user cannot point the app at their own worker without rebuilding. Upload starts only after a dedicated share render, failed uploads restart from zero, and captions, transcript and chapters are never sent although the server supports them. In the worker, the self-host upload path has no size or type checks, JSON responses carry no CORS header, and every data fetch counts as a view.
- Documentation drift: the README and the extension guide advertise an extension marketplace that the app now shows as disabled, and two share docs disagree about which endpoint builds use.
- No CLI or JSON API; the only automation is a headless export test mode.
- The loopback media server answers with a wildcard CORS header, so any web page that learns the port and an approved path could read that file.
- The export route matrix (several WebCodecs, FFmpeg, CUDA and D3D11 paths) is large and partly Windows- or NVIDIA-only, which is a maintenance and testing burden. A helper pass also found stored easing settings that playback never reads.
- Linux cannot hide the real cursor, so the styled cursor can appear twice.
- No teleprompter and no AI features beyond local transcription.
- Files that address agents or readers (treated as data, not acted on): `.github/instructions/general.instructions.md` holds a prompt for an AI pull-request reviewer, and the header of `src/components/video-editor/videoPlayback/motionSmoothing.ts` asks for attribution under AGPL. Both reinforce that the motion code is clean-room only.
- Popularity, my inference: people value polished output with zero manual work (auto-zoom, cursor polish, styled frames), a free and open alternative to paid creator recorders, macOS-native capture quality, GIF export, eleven UI languages and easy installs through Homebrew and winget. I could not verify adoption data from the shallow clone.

## Inspected paths

- `README.md:25-340` - feature claims, platform notes and minimum OS versions; source of the popularity reading.
- `electron/native/ScreenCaptureKitRecorder.swift:1-1105` - whole macOS capture helper: config, stream settings, writers, time base, pause, window crop tracking, finalisation, command loop, permission preflight.
- `electron/ipc/recording/mac.ts:1-348` - start, pause and stop waits on helper output, audio sidecar renaming, unexpected-exit handling, post-stop validation and telemetry persistence.
- `electron/ipc/register/recording.ts:670-940` - spawning the macOS helper, permission warm-up, own-window refusal, output naming, permission dialogs.
- `electron/ipc/register/recording.ts:1640-1813` - browser mic sidecar conversion and renderer video storage.
- `src/hooks/useScreenRecorder.ts:12-60` - recorder bitrates, timeslice, camera resolution, frame rate and bitrate.
- `src/hooks/useScreenRecorder.ts:1006-1126` - camera recorder preparation, start and save.
- `src/hooks/useScreenRecorder.ts:1760-1835` - warm start around the countdown and the camera offset.
- `src/hooks/recordingMimeType.ts` - container and codec preferences for screen and camera recorders.
- `electron/ipc/project/session.ts` - the camera session manifest and the filename fallback.
- `electron/ipc/project/atomicSave.ts` - atomic project writes with a backup generation.
- `electron/ipc/project/manager.ts:466-585` - project validation, media resolution and read-path approval.
- `electron/ipc/constants.ts` - file names, sidecar suffixes, Whisper model location, telemetry rate and cap.
- `electron/mediaServer.ts` - loopback media server, path allowlist, range handling, CORS headers.
- `electron/native/NativeCursorMonitor.swift:1-80` - cursor shape identification by image signature and accessibility hints.
- `electron/native/NativeCursorMonitor.swift:405-504` - listen-only click tap, 50 ms shape polling, stdin stop.
- `src/lib/hudCaptureProtection.ts` - which processes are excluded and when content protection applies.
- `electron/windows.ts:60-220` - headless export test plumbing and control-bar capture protection.
- `src/components/launch/floatingWebcamPreview.ts` - floating camera preview size limits and resizing.
- `electron/ipc/recording/diagnostics.ts:592-632` - decode test of each new recording.
- `electron/ipc/recording/audioFilters.ts` - offline mic clean-up chain and its rationale.
- `electron/ipc/register/permissions.ts` - permission status checks and System Settings deep links.
- `electron/ipc/cloudShareContract.ts` - trusted share origins and validation of server responses.
- `electron/ipc/register/cloudShare.ts:1-210` - multipart threshold, part size and retry policy.
- `src/components/video-editor/cloud/endpoint.ts` - build-time share endpoint selection.
- `src/components/video-editor/exportStartSettings.ts:60-80` - forced settings for share renders.
- `src/components/video-editor/export/useSmokeExportAutomation.ts` - headless export flow and report.
- `electron/main.ts:1040-1080` - headless export test start-up path.
- `src/components/video-editor/ExtensionManager.tsx` - extensions shown as disabled.
- `src/lib/exporter/exportBitrate.ts:1-40` - export bitrate tiers and mode multipliers.
- `src/lib/exporter/backendPolicy.ts:59-100` - export route selection order.
- `electron/ipc/captions/segment.ts:25-46` - caption re-segmentation defaults.
- `src/components/video-editor/webcamOverlay.ts:1-30` - bubble minimum size, reference width and roundness mapping.
- `src/components/video-editor/videoPlayback/webcamSync.ts:1-30` - mapping editor time to camera time with the offset.
- `src/components/video-editor/videoPlayback/zoomRegionUtils.ts:1-20` - chained-zoom gap and transition constants.
- `src/components/video-editor/cursorMotionPresets.ts:30-62` - motion presets for zoom and cursor springs.
- `src/components/video-editor/timeline/zoomSuggestionUtils.ts:1-10` - dwell thresholds and the aspect-ratio gate for auto-zoom.
- `docs/timeline-sequence.md` - clip-sequence timing model and snapping.
- `docs/cloud-sharing.md` - share flow and endpoint statement.
- `docs/authentication.md` - Supabase PKCE sign-in and callback scheme.
- `services/supabase/README.md` - feedback quotas and anonymous export-error reports.
- `THIRD_PARTY_NOTICES.md` - Voom origin and MIT text for the share worker.
- `services/recordly-share/worker/wrangler.jsonc` - Worker bindings and the daily cron.
- `services/recordly-share/worker/src/uploads.js:1-30` - share code generation and upload reservation.
- `services/recordly-share/worker/src/crypto.js:25-36` - salt and PBKDF2 password hashing.
- `services/recordly-share/worker/src/media.js:41-70` - R2 range streaming with password check.
- `services/recordly-share/worker/src/router.js:320-334` - crawler detection for preview cards.
- `services/recordly-share/worker/HOSTED.md` - hosted-mode configuration and quotas.
- `electron-builder.json5` - targets, hardened runtime, usage strings, document type, publish settings.
- `recordly.rb` - Homebrew cask.
- `scripts/build-native-helpers.mjs` - per-architecture swiftc builds for a macOS 14 target.
- `electron/native/wgc-capture/src/mf_encoder.cpp:16-90` - Windows encoder bitrate tiers.
- `electron/native/wgc-capture/src/main.cpp:250-530` - Windows helper command loop and status lines.
- `src/components/video-editor/videoPlayback/motionSmoothing.ts:1-4` - attribution notice in the header.
