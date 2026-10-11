# Screendrop (fayazara/Screendrop)

Reader: goal 1 of the clean-room research run. Everything below comes from reading files in the clone; nothing in the clone was built or run. Statements marked "inferred" are my reading of the code, not observed behaviour.

## Snapshot

- Repo: `fayazara/Screendrop`, clone folder `fayazara__Screendrop`.
- Pinned SHA: 062a9787d05f (full `062a9787d05f52e130fe7489a238e4782883e39e`).
- Licence: CC0-1.0 (class permissive). Files and types may be named; code may be copied with the notice kept.
- Stars: 2160 (from sources.json).
- Latest commit in the clone: 2026-10-01 ("Release v0.34.0 appcast"). The clone is shallow (one commit), so history and authorship cannot be studied. 17 Swift files carry a "Created by Codex" header, 7 a human header.
- Stack: Swift 6 with strict concurrency and main-actor default isolation, SwiftUI plus AppKit, ScreenCaptureKit, AVFoundation, the Speech framework's SpeechAnalyzer, Vision, Metal and Metal Performance Shaders, Carbon hotkeys, App Intents. One Metal shader. A Go release tool under `cmd/`. Swift Package dependencies: Sparkle 2.9.1 (updates) and DockProgress 5.1.0. About 54,500 lines of Swift in one flat `Screendrop/` folder plus an `Engine/` subfolder for annotation geometry. No test target; a few standalone `swiftc` check scripts under `scripts/`.
- Platforms: macOS 26.4 or newer only. Menu bar app (accessory activation policy, Dock icon only while windows are open), App Sandbox off, hardened runtime on.

## What it does

Screendrop is a native macOS screenshot tool and Loom-style screen recorder in one menu bar app. On the recording side it captures a display, a window or a dragged area with ScreenCaptureKit, plus an optional camera, microphone and system audio. The camera is written to its own movie, the OS cursor is deliberately left out of the pixels, and pointer moves, clicks, cursor artwork and keyboard shortcuts are logged to a JSON sidecar. Each recording becomes a folder "package" in Application Support that holds the raw masters and small JSON documents.

A Studio window then edits that package non-destructively: split, trim, delete and speed up clips; automatic and manual zooms driven by recorded clicks; a reconstructed, smoothed cursor; click highlights and keystroke captions; a camera bubble with size, position and roundness; backgrounds, padding and social aspect ratios with pointer-following reframing; on-device transcription with burned-in karaoke captions; and transcript-based cutting, including filler-word and silence removal. Export renders everything into one HEVC or H.264 movie (MOV or MP4) with a Metal-accelerated motion-blur compositor, and caches the render against the project state.

Sharing is self-hosted. The app talks to a Cloudflare Worker the user deploys into their own account (R2 for files, D1 for metadata). It uploads the rendered cut with one authenticated PUT, copies the returned share link, and then posts best-effort sidecars (title, poster, scrub storyboard sprite, transcript remapped to the edited timeline). The Worker and the share-page viewer are not in this repo; they live in a separate repo (`fayazara/screendrop-worker`) that this clone only links to. Screenshots get a large annotation editor, OCR text capture and smart redaction, which matter less for David's recorder.

## Feature inventory

- **capture-screen (4):** ScreenCaptureKit stream per source type: display filter that excludes Screendrop's own app, a desktop-independent window filter, or a display filter with a `sourceRect` for areas. 60 fps minimum frame interval, BGRA, queue depth 3, Retina pixel size from the filter's point-to-pixel scale. OS cursor and click rings are turned off in the stream. Blank, suspended and stopped frames are dropped. See `ScreenRecordingManager.swift:684-978`.
- **capture-camera (4):** separate `AVCaptureSession` (720p preset, mirrored, BGRA) feeding its own `AVAssetWriter` that writes `camera.mov` (HEVC, about 30 fps hint, bitrate at least 6 Mbps). The session is warmed up as soon as the camera is toggled on in the picker so exposure settles before recording. Supports built-in, external and Continuity Camera devices. `CameraRecordingManager.swift`.
- **capture-audio (3):** microphone and system audio both come from the same `SCStream` (its microphone capture option plus `capturesAudio`, excluding the app's own audio). They are written as two separate AAC tracks inside `screen.mov`: system audio stereo at 192 kbps, microphone mono at 96 kbps, both 48 kHz. No level meter and no per-track balance in Studio (one global gain of 0 to 2x). Pause handling looks fragile (see Weaknesses).
- **recording-controls (3):** one floating bar that morphs from source picker to transport. Countdown of 1, 3 or 5 seconds that Escape cancels. Pause, resume, restart the same source, stop, and delete. Elapsed timer. States: idle, starting, recording, paused, finishing. There is no global stop hotkey; stop lives on the bar, in a Shortcuts intent, or in quit handling.
- **camera-overlay (3):** during recording, a 160-point round floating preview at the bottom right of the target display, draggable, mirrored, excluded from capture. In Studio the bubble is a separate layer with visibility, normalized centre, size (fraction of the short side, default 0.26) and roundness. One layout for the whole video; there are no per-segment camera layouts or camera-only scenes.
- **annotation (3):** strong screenshot annotator (shapes, arrows, freehand, text, numbered markers, blur, pixelate, highlight, crop, backgrounds, mockup effects) with normalized coordinates and editable sidecars. There is no drawing on recordings, live or in post.
- **compositing-render (4):** an offline compositor that decodes the composed screen asset and the camera movie, renders on a fixed output clock (30 or 60 fps), caches the static backdrop once, runs a Metal compute pass for motion-blurred zoom frames, reuses settled screen pixels, scales the camera bubble with an MPS Lanczos pass, and draws cursor, clicks, keystrokes and captions with Core Graphics. Preview and export share the same layout math. `RecordingStudioExporter.swift`, `docs/export-performance.md`.
- **editing (4):** clip timeline of source ranges with per-clip speed from 1x to 8x, split, trim, delete, reset, undo and redo; zoom cues (auto from clicks, manual add, resize, retime, pin a focal point); video-card crop; aspect presets with Fill (reframe) or Fit; style presets; audio replacement. `RecordingClipTimeline.swift`, `RecordingStudioModel.swift`.
- **transcription-captions (4):** SpeechAnalyzer with SpeechTranscriber, on-device, with word-level audio time ranges. The microphone track is extracted (the mono track when both exist) and cues are chunked by length (42 characters), pause (0.9 s) and duration (4 s). Captions are editable per cue, with position, size and a karaoke word highlight. No SRT or VTT file export.
- **ai-features (3):** all on-device and heuristic: transcription, filler-word and silence trimming, click-driven auto zoom, pointer-following reframe, Vision OCR text capture and regex-based smart redaction for screenshots. No LLM features (no titles, summaries or chapters).
- **export-formats (3):** MOV or MP4 container (MP4 gets faststart), H.264 or HEVC, original/1080p/720p/480p, three quality tiers, 30 or 60 fps, motion blur on or off, remove audio, and audio-only M4A or WAV. Aspect presets original, 16:9, 9:16, 1:1, 4:5. No GIF or WebM.
- **project-format (4):** a `.screendroprec` folder with `screen.mov`, optional `camera.mov`, `input.json`, `capture.json`, `edit.json`, `edit.draft.json`, `project.json`, `render.json`, `poster.jpg`, a cached flattened deliverable and an optional imported soundtrack. Versioned Codable types decode older fields tolerantly. `RecordingSession.swift`.
- **sharing-hosting (3):** client code is present (`CloudUploader.swift`, `CloudSidecarUploader.swift`, `CloudCredentialStore.swift`, `SettingsCloudPane.swift`); the Worker is not. Upload happens only after render, as one PUT of the whole file, with no resumable or upload-while-recording path. Users can delete the cloud copy.
- **viewer-web (0 in this clone):** the Loom-style share page (player, scrub previews, searchable transcript, timed comments, view counts, link unfurls) is described in the README but its code lives in the separate Worker repo. This clone only produces the poster, storyboard sprite plus grid metadata, and transcript JSON that the viewer consumes.
- **teleprompter-scripts (4):** script composer in the picker; notch-shaped overlay on notched Macs, a pill elsewhere; live progress from SpeechAnalyzer volatile results fed by a tee of the recording's own microphone buffers; forward-only greedy fuzzy matching with an 8-word lookahead. Excluded from capture.
- **platform-packaging (4):** macOS 26.4 only. Sparkle updates through an appcast in the repo, notarized DMG, Homebrew cask, and a non-interactive Go release tool designed to be run by an agent.
- **performance-reliability (4):** fragmented QuickTime writing every 2 seconds, sessions in Application Support, launch-time recovery, stream errors finalize instead of discard, writer health checks, synchronous backpressure on the capture callback, an App Nap and idle-sleep activity token while recording, render caching, bounded image caches. Gaps in pause sync and recovered metadata are covered under Weaknesses.
- **extensibility-automation (2):** App Intents for screenshots, text capture, and start, stop and toggle of a full-screen recording (also reachable from the `shortcuts` command line). Intents take no parameters (no source, camera or mic choice) and stop returns nothing. The JSON package files are easy for tools to read. No CLI or JSON control surface for the recorder itself.
- **privacy-security (4):** upload token generated locally from 32 random bytes and stored in Keychain; Worker URL in UserDefaults. App windows are excluded from captures by default through both the content filter and the window sharing type. Keystroke logging keeps only special keys and modifier chords, never plain typing. Transcription is on-device. No central server.

## Architecture

### Process model and components

A single app process. `ScreendropApp.swift` declares a menu bar extra, a Library window and two window groups (annotation editor, recording Studio), and an app delegate that registers Carbon hotkeys, starts Sparkle, and runs interrupted-recording recovery at launch. Most services are `static let shared` singletons on the main actor. Real-time media work runs on `nonisolated` classes with their own dispatch queues: `ScreenRecordingCapture` (SCStream output, video and audio queues), `ScreenRecordingWriter` (one serial writer queue), `CameraCaptureEngine` and `CameraMovieWriter`, `PointerActivityRecorder` (event tap plus a lock-protected sample buffer) and `RecordingKeystrokeRecorder`.

### Capture graph and the shared clock

- **Screen and audio:** one `SCStream` delivers screen frames, system audio and microphone audio. `ScreenRecordingWriter` owns one `AVAssetWriter` for `screen.mov` with a video input (HEVC, average bitrate the larger of 20 Mbps or width times height times 4, 60 fps hint, keyframe interval 60) and up to two audio inputs. The first written video frame's presentation time becomes the session start. The writer starts its session at zero and retimes every sample by subtracting the session start and accumulated pause time. Audio that arrives before the first video frame is dropped, because it has no place on the timeline yet (`ScreenRecordingManager.swift:1121-1191`).
- **Camera:** a separate capture session and writer. Frames are retimed the same way against the camera's own first frame, so `camera.mov` starts at zero. The camera movie has no audio track; narration lives in the screen file.
- **Sync:** ScreenCaptureKit and AVCaptureSession both stamp buffers on the host clock. At finish, `cameraLeadIn` is the camera's first-frame host time minus the screen writer's first-frame host time, saved in `capture.json` (`ScreenRecordingManager.swift:378-384`). Because the camera starts writing before the screen stream starts, this value is normally negative. Studio playback seeks the camera player to screen-source time minus the offset and corrects drift above 0.12 s while playing, scaling the camera rate for sped-up clips (`RecordingStudioModel.swift:858-904`). Export reads the camera movie sequentially with one frame of look-ahead and, for each output tick, hands back the most recent camera frame whose offset-adjusted time is not later than the screen source time (`RecordingStudioExporter.swift:591-651`). This is the same "screen file, camera file, offset" contract David's editor already accepts.
- **Input timeline:** pointer and keystroke recorders start before the stream and keep raw host-uptime samples. For window recordings they also log each frame's ScreenCaptureKit geometry (screen rect, content rect, scale), which keeps the pointer aligned while the window moves or resizes. At finish everything is mapped onto the movie timeline using the screen session start, with pause intervals removed per sample, normalized to 0..1 top-left coordinates, sanitized, and written to `input.json` (`RecordingPointerCapture.swift:180-325`). Events from before the first frame are discarded. Whenever a video frame arrives and the last pointer sample is a second or more old, a heartbeat sample is added, which guarantees a pointer position at time zero and through idle stretches.

### The capture coordinator (state machine)

`CaptureCoordinator.swift` is only the entry point: it runs the countdown and then calls `ScreenRecordingManager.startRecording`. The real recording state machine is in `ScreenRecordingManager`:

- **States:** idle, starting, recording, paused, finishing. A finish action (preview, discard, restart, terminate) decides what happens after the writer closes.
- **Start sequence** (`:148-279`): check screen permission (preflight, then the one-time system prompt, then an alert that links to System Settings and says a relaunch is needed). Show the control bar and the area highlight. Resolve optional inputs: a missing device or denied permission turns that input off, clears the saved choice, and shows one combined warning instead of failing. Start the teleprompter session. Create the session folder, which the manager owns from then on so failure paths can delete it. Fetch fresh shareable content, build the filter and configuration, set up the writer, wire callbacks, start the camera writer (a failure only warns), start pointer and keystroke logging, then start the stream last, so no setup UI or permission prompt is baked into the footage. After every await it re-checks that it is still starting the same session, so a cancel during setup is honoured.
- **Pause and resume:** each component pauses itself. The screen writer drops frames and audio while paused, the camera writer drops frames, input recorders record host-uptime pause intervals, and the teleprompter freezes.
- **Stop:** stop the stream, stop the camera (returns first-frame time and size), finish the writer, then write `input.json` and `capture.json`. Metadata failures become warnings, not lost footage.
- **Errors:** an `SCStream` stop error during recording (display change, sleep, window closed, permission revoked) finalizes and keeps the footage with an "ended early" alert. During start it discards. Writer failure (disk full, encoder death, non-monotonic timestamps) is detected on the write path through the writer's status and handled the same way. A failed start cancels the writer, deletes the session folder and shows the error instead of failing silently.
- **Quit:** `applicationShouldTerminate` warns, then finishes the writer and imports the session before replying to the termination request (`ScreendropApp.swift:187-218`).
- **Long recordings:** a process activity token keeps App Nap, automatic termination and idle system sleep away while recording (`:620-635`).

### Crash safety of partially written files

Both writers set a 2-second movie fragment interval, so a crash leaves a QuickTime file that plays up to the last fragment. Sessions live in `~/Library/Application Support/Screendrop/Recordings`, not the temp folder, so the OS will not purge them. `capture.json` is written only at a normal finish, so its absence marks an interrupted session. At launch, `RecordingRecoveryCoordinator` opens each such `screen.mov` with AVFoundation; if it has a video track and more than 0.1 s of duration, it writes a minimal manifest, imports the session into History and tells the user. Unopenable footage is never deleted. Inferred limits: the recovered manifest has no camera offset and no `pointerSynthesized` flag, and `input.json` never existed because pointer data is held in memory until finish. A recovered recording therefore has no cursor at all and a camera bubble misaligned by the setup gap. Also, unlike the screen path, a camera writer that fails to complete deletes `camera.mov` (`CameraRecordingManager.swift:547-553`).

### On-disk layout and export folder

- Session package: `~/Library/Application Support/Screendrop/Recordings/Screendrop_<yyyy-MM-dd-HH-mm-ss>_<6 hex>.screendroprec/`
  - `screen.mov`: HEVC video, plus an optional stereo system-audio AAC track and an optional mono microphone AAC track.
  - `camera.mov`: optional HEVC camera video, no audio.
  - `input.json`: format version, pointer travel samples (time, x, y, move or drag, artwork ID), presses (down or up, button), keystroke chords (time, modifier symbols, key label), cursor artwork as base64 PNG with anchor and reference size, and a sanitized flag.
  - `capture.json`: version, created date, duration, pixel width, height and scale, display ID, audio flags, `cameraLeadIn`, camera size, `pointerSynthesized`, press-effect flags.
  - `edit.json` (explicit save), `edit.draft.json` (250 ms debounced autosave), `project.json` (display name, saved and last-opened dates), `render.json` (the document that produced the cached render), `poster.jpg`, `<package name>.mov` or `.mp4` (the flattened deliverable cache), and `audio-replacement.<ext>`.
- Library index: `~/Library/Application Support/Screendrop/history.json`, plus a `History/` folder for screenshots and bare videos. Recordings are referenced by package path rather than copied.
- Temporary renders: `$TMPDIR/Screendrop/StudioExports/<uuid>.<ext>`. Transcription scratch: `$TMPDIR/screendrop-narration-<uuid>.m4a`.
- Export folder: `~/Pictures/Screendrop` by default, configurable. Saves use unique names; a matching container is an APFS clone copy, and a MOV to MP4 change is a passthrough remux (`VideoFileActions.swift:97-140`).

### Studio and render pipeline

`RecordingStudioModel` loads the manifest and pointer sidecar, sanitizes the pointer stream, opens the project from the draft if one survived (else `edit.json`, else defaults with auto-generated zoom cues and the default style preset), and builds the clip timeline. Playback uses an `AVMutableComposition` that inserts the kept source ranges and scales each clip's range to its speed, so all tracks speed up together (`RecordingCompositionBuilder.swift`). The camera plays in a second player kept in step by seeks.

The viewport (zoom) and pointer timelines are integrated at a fixed 120 Hz over edited time with damped springs, so cuts never jerk a zoom and clip speed does not change camera motion speed. Preview and export interpolate the same precomputed frames. Export (`RecordingSessionRenderer.makeConfiguration` and `RecordingStudioExporter`) is shared by Studio Export, Share, Library copy and auto-upload. Each run stamps the document it rendered so a later Export or Share can prove the cache is fresh and skip re-encoding; a container-only change keeps the cache and remuxes on save.

### Transcription and transcript editing

`RecordingTranscriptionService.transcribe` picks the narration track, exports it to M4A, resolves a supported locale (exact, same language, then English, else a clear error), downloads the on-device model if needed, and collects final results with audio time ranges. Punctuation runs are glued onto the previous word. Words and cues are stored on the source timeline in `edit.json`. `TranscriptEditPlanner` turns a word selection into a source cut range that eats up to 0.12 s, or half the gap, into the silence on each side, so it never clips a neighbouring word. It also finds fillers (a conservative list of hesitation sounds) and silences longer than 1.1 s, keeping 0.35 s on each side. The model removes those ranges from the clip timeline, rebuilds caption text, and registers both in one undo group, parking the playhead on the first splice. Words are never deleted from the transcript; a word counts as surviving if its midpoint is still on the edited timeline.

### Sharing pipeline (where the Cloudflare code lives)

- In this repo: `CloudUploader.swift` (render if needed, then `PUT {worker}/api/upload` with a bearer token; filename, media type, width, height, duration, URL-encoded title and a comments-allowed flag go in `X-` headers; the raw file is the body; 300 s timeout; expects 201 with id, url, filename and size). `CloudSidecarUploader.swift` (multipart `POST /api/assets/{id}` with title, a poster at 0.5 s, a storyboard sprite of up to 100 tiles 160 px wide with grid metadata, and transcript cues and words remapped through the clip timeline). `DELETE /api/upload/{id}` removes a cloud copy. `SettingsCloudPane.swift` generates the token, links to the Cloudflare deploy button, verifies with `POST /api/setup` (idempotent schema setup) then `GET /api/ping`, and compares the Worker's reported version with a `version.json` manifest on GitHub to show an update notice.
- Not in this repo: the Worker, R2 and D1 schema, share-link generation and the viewer page. Share URLs are produced by the Worker and returned in the upload response. The earlier survey was right that the server code is absent from this clone.
- What is uploaded: the rendered final cut (the deliverable), never the raw masters. For a never-edited, camera-less, cursor-visible capture the screen master itself is already the deliverable, though new captures always hide the cursor and so always render.

### .agents and AI prompt files

`AGENTS.md` describes the app for coding agents: a flat source folder, main-actor default isolation and strict concurrency, `@Observable` rather than published properties, singletons for services, normalized 0..1 annotation coordinates, sandbox off, atomic commits with one logical change each, and a successful `xcodebuild` as the only automated gate (no test target). `.agents/skills/` holds four agent skills: build, build-and-run (kill every running variant before launching, resolve paths through `-showBuildSettings`), release (drives the Go CLI non-interactively, idempotent on re-run, notarization profile), and a notch-UI skill pulled from the author's skills repo (`skills-lock.json`). `output/imagegen/` holds image-generation prompts for marketing art. Together they show a repo developed largely with coding agents. Drift: `AGENTS.md` says there are no Swift packages and that fullscreen screenshots use ScreenCaptureKit, but the project resolves Sparkle and DockProgress and `ScreenshotManager.swift` uses the `screencapture` tool for fullscreen too. The README still says FFmpeg powers video conversion; the FFmpeg path has been removed (`VideoTrimSelection.swift` notes the ffmpeg-era service is gone). None of these files contained instructions aimed at me as a reader.

## Best ideas

1. **Separate camera master plus shared-clock offset in the manifest.** What: write `camera.mov` with its own writer, record the first camera frame's host time and the first screen frame's host time, and store the difference as `cameraLeadIn` with the camera size in `capture.json`. Why: this is exactly the screen file, camera file and offset that David's editor consumes, and it keeps the bubble restylable. Reuse: copy-with-notice. Paths: `Screendrop/CameraRecordingManager.swift`, `Screendrop/ScreenRecordingManager.swift:370-412`, `Screendrop/RecordingSession.swift:286-325`.
2. **Crash-safe recording package with launch recovery.** What: 2-second fragmented QuickTime for every writer, packages in Application Support, a missing manifest as the interrupted marker, and launch-time recovery that never deletes footage it cannot open. Why: a long Loom-style take must survive a crash or forced quit. Reuse: copy-with-notice, adding the camera offset and pointer-data checkpoints that recovery currently lacks. Paths: `Screendrop/RecordingRecoveryCoordinator.swift`, `Screendrop/RecordingSession.swift`, `Screendrop/ScreenRecordingManager.swift:1016-1092`.
3. **Failures finalize, never discard.** What: stream errors and writer failures finish the file and present "ended early, footage saved"; optional inputs downgrade with one warning; quit waits for the writer through a deferred termination reply; an activity token blocks App Nap and idle sleep. Why: these are the cases where recorders usually lose work. Reuse: copy-with-notice. Paths: `Screendrop/ScreenRecordingManager.swift:472-635`, `Screendrop/ScreendropApp.swift:187-218`.
4. **Cursor-free master plus an input timeline.** What: turn off the OS cursor in the stream, log pointer moves, presses, cursor artwork and per-frame window geometry on the host clock, and map them to the movie timeline at stop. Why: it enables a smooth synthetic cursor, cursor size changes, click effects, auto zoom and reframing, all editable later. Reuse: copy-with-notice. Paths: `Screendrop/RecordingPointerCapture.swift`, `Screendrop/RecordingPointerArtworkCapture.swift`, `Screendrop/RecordingPointerTimeline.swift`.
5. **Self-hosted share in one PUT, then sidecars.** What: a locally generated token in Keychain, a Worker URL, a raw-body PUT with metadata in headers so the Worker can stream to R2, a link returned at once, and best-effort posters, storyboard sprite and transcript afterwards. Why: storage David controls, no S3 keys on the Mac, and a usable link before the extras arrive. Reuse: copy-with-notice for the client; the Worker must be written fresh (not in clone). Paths: `Screendrop/CloudUploader.swift`, `Screendrop/CloudSidecarUploader.swift`, `Screendrop/CloudCredentialStore.swift`, `Screendrop/SettingsCloudPane.swift`.
6. **Transcript cuts that land in silence.** What: on-device SpeechAnalyzer word timings; cut ranges padded into the surrounding pause; filler and silence presets; caption rebuild and timeline cut in one undo step. Why: fast Loom-style cleanup without a timeline. Reuse: copy-with-notice. Paths: `Screendrop/RecordingTranscription.swift`, `Screendrop/RecordingTranscriptEditing.swift`, `Screendrop/RecordingStudioModel.swift:1453-1563`.
7. **Draft autosave, explicit save and a render stamp.** What: a debounced draft separate from the saved project; uploads and flattening read the draft; the cached render is reused only when its stamped document matches. Why: no lost edits after a crash, and repeat share or export costs nothing. Reuse: copy-with-notice. Paths: `Screendrop/RecordingSession.swift:183-283`, `Screendrop/RecordingStudioModel.swift:1141-1239`, `Screendrop/RecordingSessionRenderer.swift`.
8. **Warm camera before Record.** What: start the camera session and floating preview as soon as the camera is selected, then reuse that session when writing starts. Why: removes the dark exposure ramp at the start of camera footage and gives Loom's "see yourself first" feel. Reuse: copy-with-notice. Paths: `Screendrop/CameraRecordingManager.swift:71-146`, `Screendrop/RecordingBarPresenter.swift`.
9. **Click-driven auto zoom as editable cues.** What: each mouse-down makes a cue from 0.3 s before to 2.5 s after, joined when gaps are under 2.5 s, kept away from the tail. A spring-integrated 120 Hz viewport timeline follows the pointer over edited time. Why: polished demos with no manual keyframing. Reuse: copy-with-notice. Paths: `Screendrop/RecordingViewportTimeline.swift`, `Screendrop/RecordingMotionSpring.swift`.
10. **Backpressure at the capture callback.** What: hop synchronously into the writer queue from the ScreenCaptureKit callback with a queue depth of 3, so the stream drops frames instead of piling up IOSurfaces when the encoder lags. Why: protects long 4K recordings from memory kills. Reuse: copy-with-notice. Paths: `Screendrop/ScreenRecordingManager.swift:909-938`, `Screendrop/ScreenRecordingManager.swift:1121-1159`.
11. **Own UI never in the footage.** What: the stream filter excludes the app, and every app panel gets a sharing type of none unless the user opts in; the stream starts only after all prompts and setup UI are done. Why: the camera preview, control bar and teleprompter stay off the recording. Reuse: copy-with-notice. Paths: `Screendrop/PreviewWindowCaptureExclusion.swift`, `Screendrop/ScreenRecordingManager.swift:891-907`.
12. **Teleprompter driven by the recording's own mic.** What: tee microphone buffers from the stream into a live SpeechAnalyzer and advance a forward-only fuzzy match through the script, shown in a notch overlay. Why: no second audio capture session, perfect alignment with the recorded narration, and it never blocks recording. Reuse: copy-with-notice. Paths: `Screendrop/TeleprompterSpeechEngine.swift`, `Screendrop/TeleprompterScript.swift`.
13. **Fixed output clock for sparse screen frames.** What: render every output tick from the newest source frame at or before it, reset at clip boundaries, with Metal blur and settled-frame reuse. Why: zooms keep animating over static screens, and export stays fast. Reuse: copy-with-notice. Paths: `Screendrop/RecordingStudioExporter.swift:394-520`, `Screendrop/RecordingExportTiming.swift`, `docs/export-performance.md`.
14. **Agent-friendly control and release surfaces.** What: App Intents for start, stop and toggle (callable from the `shortcuts` CLI) and a fully non-interactive, idempotent release tool. Why: a starting point for David's agent control, which should add source, device and output parameters and return the session path on stop. Reuse: idea-only. Paths: `Screendrop/ScreendropAppIntents.swift`, `cmd/screendrop-release/main.go`.
15. **Audio round trip for cleanup tools.** What: export the edited soundtrack, clean it elsewhere, import it as a replacement that lies flat on the edited timeline. Why: cheap studio-quality narration without in-app DSP. Reuse: copy-with-notice. Paths: `Screendrop/RecordingAudioExport.swift`, `Screendrop/RecordingCompositionBuilder.swift:45-101`.

## Weaknesses and gaps

- **Pause sync risk (inferred, untested).** Each component measures pause time differently. The screen writer uses the first changed screen frame during the pause and the first changed frame after it, and ScreenCaptureKit only delivers changed frames. The camera writer uses its own continuous frames. Pointer and keystroke recorders use host uptime. If the screen does not change while paused, the screen writer records no pause start and subtracts nothing. The footage then holds a frozen gap while the camera, cursor and key timelines remove it, which shifts them out of sync after a pause. Audio after resume is retimed only once the next video frame arrives, so a static screen after resume may produce non-monotonic audio timestamps. A recorder should use one shared pause clock.
- **Recovery loses metadata.** Recovered sessions get a bare manifest: no camera offset, no synthesized-pointer flag, and no `input.json`, because pointer data stays in memory until stop. The result is no cursor and a misaligned bubble. A camera writer that fails to complete deletes its fragmented file.
- **No global stop hotkey.** The record hotkey only toggles the picker bar, and reading the toggle logic suggests that pressing it mid-recording swaps the bar back to picker mode (inferred). Stop is on the bar or the Stop intent only.
- **Upload is post-render and whole-file.** It maps the whole file into memory and sends one PUT with a 300 s timeout: no multipart, no resume, no upload while recording, no progress on sidecars. The Worker and viewer are not in this repo, so the share page cannot be studied here.
- **Automation is thin.** Intents cannot choose window, area, camera or mic, and stop does not return the package path. No CLI or JSON control surface for the recorder.
- **Limited audio control.** No input level meter, no per-track mix between mic and system audio, no noise suppression. The camera has no audio, so a mic-less session cannot be rescued from the camera.
- **Single static camera layout,** no camera-only or side-by-side scenes. Inferred: the position the user drags the live preview bubble to is not saved, so Studio opens with the default or style-preset bubble placement instead.
- **Docs drift and no tests.** `AGENTS.md` and the README contradict the code (Swift packages, fullscreen capture method, FFmpeg). The only automated gate is a successful build plus a few standalone scripts.
- **Platform reach.** Requires macOS 26.4 and newer APIs (SpeechAnalyzer, stream microphone capture), which is fine for David's Mac but rules out older systems.
- **Export gaps:** no GIF, WebM, SRT or VTT export; captions are burned in or sent to the Worker only.

## Inspected paths

- `AGENTS.md` - agent-facing conventions, build gate, architecture summary (with drift)
- `README.md` - feature claims, cloud setup flow, privacy statements, upload steps
- `.agents/skills/build-screendrop/SKILL.md` - build-only agent skill
- `.agents/skills/build-and-run-screendrop/SKILL.md` - build, kill all variants, relaunch skill
- `.agents/skills/release-screendrop/SKILL.md` - non-interactive release flow for agents
- `.agents/skills/macos-notch-ui/SKILL.md` - notch overlay recipe used by the teleprompter
- `skills-lock.json` - notch skill sourced from the author's skills repo
- `output/imagegen` - image-generation prompt files for marketing art
- `docs/export-performance.md` - Metal blur policy, fixed clock, cache, measured timings
- `docs/editor-performance.md` - cache budgets, close and cancellation behaviour
- `Screendrop/ScreenRecordingManager.swift:1-280` - states, options, start sequence and ordering
- `Screendrop/ScreenRecordingManager.swift:281-470` - pause, stop, finalize, manifest and lead-in
- `Screendrop/ScreenRecordingManager.swift:472-682` - error handling, permissions, activity token
- `Screendrop/ScreenRecordingManager.swift:684-978` - filters, stream configuration, frame status
- `Screendrop/ScreenRecordingManager.swift:980-1351` - writer settings, fragments, retiming, health
- `Screendrop/CameraRecordingManager.swift` - camera warm-up, preview panel, separate writer
- `Screendrop/RecordingSession.swift` - package layout, manifest, input sidecar types, render stamp
- `Screendrop/RecordingRecoveryCoordinator.swift` - interrupted-session recovery
- `Screendrop/CaptureCoordinator.swift` - capture entry points and countdown hand-off
- `Screendrop/RecordingInputAuthorization.swift` - camera and mic permission resolution
- `Screendrop/RecordingProject.swift` - project metadata fields
- `Screendrop/RecordingProjectStore.swift` - package scanning, posters, draft flush on quit
- `Screendrop/ScreendropApp.swift` - scenes, launch recovery, quit handling
- `Screendrop/CloudUploader.swift` - upload, delete, headers, response contract
- `Screendrop/CloudSidecarUploader.swift` - poster, storyboard, transcript remap, multipart post
- `Screendrop/CloudCredentialStore.swift` - Keychain token storage, legacy S3 cleanup
- `Screendrop/CloudUploadOptions.swift` - title and comments toggle before upload
- `Screendrop/SettingsCloudPane.swift` - token generation, deploy link, verify, version check
- `Screendrop/RecordingTranscription.swift` - SpeechAnalyzer pipeline, cues, karaoke timing
- `Screendrop/RecordingTranscriptEditing.swift` - cut, filler and silence planning
- `Screendrop/RecordingStudioModel.swift:269-425` - project load, draft precedence, auto zoom default
- `Screendrop/RecordingStudioModel.swift:855-904` - camera playback sync and drift correction
- `Screendrop/RecordingStudioModel.swift:1141-1269` - draft autosave, save, discard
- `Screendrop/RecordingStudioModel.swift:1389-1563` - transcription and transcript cuts
- `Screendrop/RecordingStudioModel.swift:1908-2293` - export, audio round trip, share flow
- `Screendrop/RecordingStudioStyle.swift:1-360` - edit document schema, camera bubble settings
- `Screendrop/RecordingClipTimeline.swift:1-160` - clip segments, speed limits
- `Screendrop/RecordingCompositionBuilder.swift` - gap-closing composition with speed scaling
- `Screendrop/RecordingSessionRenderer.swift` - deliverable resolution and export configuration
- `Screendrop/RecordingStudioExporter.swift:1-740` - reader, writer, fixed clock, camera feed
- `Screendrop/RecordingExportTiming.swift` - output clock and shutter sampling
- `Screendrop/StudioMetalScreenRenderer.swift:1-40` - one command buffer per shutter, one frame in flight
- `Screendrop/RecordingMotionSpring.swift` - single semi-implicit spring shared by zoom and cursor
- `Screendrop/TeleprompterOverlayPresenter.swift:1-40` - notch and pill overlay, excluded from capture
- `Screendrop/RecordingPointerCapture.swift:1-330` - event tap, fallbacks, geometry, timeline mapping
- `Screendrop/RecordingPointerTimeline.swift:1-40` - synthetic cursor reconstruction constants
- `Screendrop/RecordingPointerStream.swift:1-45` - sanitizer options
- `Screendrop/RecordingPointerArtworkCapture.swift` - cursor artwork capture from AppKit
- `Screendrop/RecordingViewportTimeline.swift:1-260` - zoom cues, auto-zoom synthesis, spring timeline
- `Screendrop/RecordingKeystrokeCapture.swift:1-120` - chord-only keystroke logging
- `Screendrop/RecordingExportReframe.swift:1-30` - aspect presets and reframe camera
- `Screendrop/RecordingDeliverable.swift` - why raw masters never ship directly
- `Screendrop/RecordingAudioExport.swift:1-75` - audio-only formats and round trip
- `Screendrop/RecordingAudioGain.swift` - single global gain with processing tap
- `Screendrop/StudioCameraBubbleScaler.swift` - GPU Lanczos bubble scaling
- `Screendrop/ScreendropAppIntents.swift` - Shortcuts and Siri intents
- `Screendrop/HotkeyManager.swift` - Carbon global hotkeys
- `Screendrop/CaptureHotkeys.swift:216-230` - record hotkey only toggles the picker
- `Screendrop/RecordingBarPresenter.swift:1-110` - picker and controls morph, warm camera
- `Screendrop/RecordingPickerBar.swift:1-80` - pre-record inputs and timer options
- `Screendrop/RecordingControlPresenter.swift` - pause, restart, stop, delete controls
- `Screendrop/RecordingSourceCatalog.swift` - display and window source listing
- `Screendrop/PreviewWindowCaptureExclusion.swift` - window sharing type exclusion
- `Screendrop/TeleprompterSpeechEngine.swift:1-120` - live speech tracking from the mic tee
- `Screendrop/TeleprompterScript.swift:1-60` - forward-only fuzzy script matcher
- `Screendrop/ScreendropPreferences.swift:1-200` - defaults, export folder, device preferences
- `Screendrop/VideoFileActions.swift:80-160` - save to export folder, clone or remux
- `Screendrop/VideoCompressionModels.swift` - export settings, containers, frame rates
- `Screendrop/VideoTrimSelection.swift` - note that the ffmpeg-era trim service is gone
- `Screendrop/ScreenshotHistoryStore.swift:1-130` - Library index location and item schema
- `Screendrop/AfterCaptureActions.swift` - per-type after-capture matrix including auto upload
- `Screendrop/SmartRedactionRecognizer.swift` - OCR plus regex secret detection for screenshots
- `Screendrop/ScreenshotManager.swift:1-60` - screenshots use the screencapture tool
- `Screendrop/Info.plist` - usage strings, Sparkle feed, preset type
- `Screendrop/Screendrop.entitlements` - camera and audio-input entitlements only
- `Screendrop.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved` - Sparkle and DockProgress pins
- `cmd/screendrop-release/main.go:1-40` - release CLI flags for non-interactive runs
- `scripts/check-recording-export-options.swift` - standalone settings and timing check
