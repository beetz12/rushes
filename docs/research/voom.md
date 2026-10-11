# voom: research note

## Snapshot

- Repo: aritropaul/voom (clone folder `aritropaul__voom`).
- Pinned SHA: 410fb860b666 (full hash 410fb860b66687eaa55181423cc71200263390dd, matches the clone HEAD).
- Licence: MIT, as written in sources.json (class permissive). I found no files with a different licence header. One helper credits an outside pull request in a comment.
- Stars: 12 (sources.json).
- Stack and languages: Swift 6 with SwiftUI and AppKit, ScreenCaptureKit, AVFoundation, Core Image on Metal, CoreMediaIO and EventKit. The resolved third-party Swift packages are FluidAudio (Parakeet speech recognition and diarization on Core ML), Sparkle (updates) and WhatsNewKit (release notes). The share backend is a Cloudflare Worker in JavaScript, using R2 storage, a D1 database and a cron trigger, with an Astro and TypeScript share page. Swift code is split into local packages: VoomCore, VoomApp, VoomAI, VoomMeetings and VoomCLI.
- Platforms: macOS 15 and later. Some AI features need macOS 26 (Apple's on-device language model).
- Latest commit in the clone: 2026-10-01 (single shallow commit; changelog version 4.4.0).

## What it does

Voom is a small native Loom alternative for macOS. From a floating control panel or a global shortcut (Command-Shift-R) you pick a mode: full display, dragged region, a single window, or camera only. You toggle camera, microphone and system audio, choose a corner for the webcam bubble, and start after a three-second countdown. While recording you can pause, resume and draw on the screen with a live annotation layer. The output is a single HEVC MP4 in `~/Movies/Voom`. The webcam bubble and the cursor are part of the screen pixels, because the floating camera window itself is captured.

After you stop, the library window opens on the new recording. It is transcribed in the background with an on-device Parakeet model. With your own API key for OpenAI, Anthropic, Google or xAI, or with Apple's on-device model as a fallback, the app writes a title, a summary and chapters. The player supports trim, cut, stitch, transcript-based word deletion, filler-word removal, privacy blur regions, a GIF of the first 15 seconds, and transcript export in four formats. Folders, tags and search organise the library. A meetings module notices video calls, from calendar events plus the camera being busy in another app. It records them with separate microphone and system tracks so it can diarize speakers.

Sharing is opt-in and self-hosted. A Cloudflare Worker that you deploy into your own account stores the MP4 in R2 and the metadata in D1, and serves a share page. That page has a seekable player, captions, a clickable synced transcript, chapters, timestamped emoji reactions and comments, an optional password, an optional end-of-video call-to-action button, and an embed view. Links expire after 30 days unless renewed. The app can deploy the whole backend itself from a Cloudflare API token. A separate `voom` command-line tool gives AI agents JSON access to recording and the library.

## Feature inventory

- **capture-screen (3):** ScreenCaptureKit at native Retina resolution, capped at 60 fps, with dimensions rounded to even numbers. Region mode crops through the stream's source rectangle. Window mode uses a window-following filter that keeps capturing the window's own content when it moves or is covered. The app's own windows are excluded, except the camera bubble and annotation layer, which are deliberately included. The cursor is baked into the pixels. Stream queues run below user-interactive priority so the rest of the Mac stays responsive.
- **capture-camera (2):** Live camera only, with no separate camera file during screen recording. Capture prefers 1280x720 at 60 fps and supports external and Continuity cameras, remembering the choice and falling back when a camera is unplugged. Camera-only mode writes the webcam to its own MP4.
- **capture-audio (3):** System audio comes from ScreenCaptureKit as 48 kHz stereo. The microphone comes from an audio-engine input tap, resampled to 48 kHz mono so 16 kHz Bluetooth headsets play at the right pitch. In normal recordings the microphone is mixed into the system track with fixed gains. Meetings use separate tracks plus extra reference audio files.
- **recording-controls (3):** A floating panel with modes, saved presets, device toggles and bubble corner. Also a three-second countdown, pause and resume, a global toggle shortcut, a menu-bar item, and automatic finalize when the capture source disappears. Stopping opens the library on the new recording.
- **camera-overlay (2):** A 240-point circle with a layered shadow in one of four corners, movable between corners. On display capture it is a real window that ScreenCaptureKit records. On window capture it is drawn into each frame with a feathered circular mask. Either way it is baked in and cannot be changed later.
- **annotation (3):** A transparent full-screen layer for live drawing during recording: freehand, arrow, rectangle, circle and text. It is captured into the video. After recording, privacy blur regions are applied by re-encoding.
- **compositing-render (2):** The only compositing is the camera bubble on window captures, plus the blur re-encode. There are no backgrounds, zoom rendering or cursor effects.
- **editing (3):** Trim, cut and stitch use stream-copy (passthrough) composition exports, so they are fast and lossless. Word deletion from the transcript uses word times estimated by position within a segment. Filler detection is included. Transcript times are re-mapped after cuts.
- **transcription-captions (4):** On-device Parakeet through FluidAudio. Transcription starts automatically and resumes after a crash. Meetings get diarization with "You" labelling and echo-bleed rejection. Transcripts export as SRT, VTT, TXT or JSON, and the share page serves WebVTT captions.
- **ai-features (4):** Title, summary, chapters and meeting action items, through a bring-your-own-key provider (detected from the key's prefix) with Apple's on-device model as fallback. An auto-zoom analyzer and a clip-suggestion service exist but nothing calls them.
- **export-formats (2):** The recording itself is the deliverable: HEVC MP4 at a fixed 8 Mbps. There is also a 10 fps GIF of up to 15 seconds, copied to the clipboard or saved, and the transcript formats. There is no H.264, resolution or frame-rate choice.
- **project-format (2):** Flat MP4 files plus a `.cursor.json` sidecar and thumbnails. A SQLite library (WAL mode) keeps one JSON blob per recording. There is no edit document: every edit writes a new media file.
- **sharing-hosting (4):** A self-hosted Worker with R2 and D1. Uploads are multipart in 10 MB parts and aborted on failure. The API uses a bearer secret. Share codes are random. Links expire after 30 days, can be renewed or deleted, and are cleaned up daily. Passwords and call-to-action buttons are optional. The app polls for new views and posts a macOS notification. There is one-click deployment from inside the app.
- **viewer-web (4):** An Astro page with a range-request player, speed control, keyboard shortcuts, captions toggle, synced clickable transcript, chapters, timestamped reactions and comments, password gate, end-of-video call-to-action, embed page, Open Graph image, and a password-protected library dashboard.
- **teleprompter-scripts (0):** Absent.
- **platform-packaging (3):** An Xcode app plus local SwiftPM packages and a separately built CLI. Releases are signed and notarised by a release workflow, Sparkle updates come from GitHub releases, and the app is not sandboxed.
- **performance-reliability (2):** Finalize failures salvage any file that still plays. The stream-stop delegate is wired up, dropped frames are counted, the library index can be rebuilt from the disk, and interrupted transcriptions resume. The weak points: the MP4 is not fragmented, each stream is zeroed separately, and the microphone is mixed by sample count.
- **extensibility-automation (4):** The `voom` CLI has `guide`, `targets`, `record` and `list`, all with JSON output, plus an agent skill file that defers to the self-describing guide. App and CLI share the WAL-mode library. There is no CLI command for camera, sharing or transcripts.
- **privacy-security (3):** Local-first, with the share secret and AI keys in the Keychain. Passwords are hashed in the client and salted on the server, compared in constant time, and attempt-limited. But the share password also seems to be kept in plaintext in the local library rows. BYOK sends transcripts to third-party AI providers. All permissions are requested at launch.

## Architecture

**Process and module layout.** There is one menu-bar app process. The app target is thin: an app delegate, app state, and SwiftUI views. A session controller owns the recorder lifecycle. Logic lives in local Swift packages. VoomCore holds models, storage, capture helpers, the writer, transcription, editing, export, sharing and text analysis. VoomApp holds the two ScreenCaptureKit recorders, screen and camera-only. VoomAI holds the HTTP clients for the four AI providers. VoomMeetings holds detection, the meeting recorder and diarization. VoomCLI is a standalone SwiftPM executable that links VoomCore and VoomApp, so the CLI and the app share capture code and the library. Services follow an actor-singleton pattern.

**Recording data flow.** The session controller resolves the mode first. Region mode shows a selector, and window mode resolves the picked window at start time, because it may have closed. The controller starts or borrows the live camera session, which also feeds the on-screen bubble, and runs the countdown. Then the screen recorder builds a content filter. For a display, it excludes the app but adds the camera bubble and annotation windows back in. For a window, it uses a filter that follows the window. It configures 60 fps BGRA with the cursor shown, and creates one asset writer for an MP4 with HEVC video and one or two AAC tracks. ScreenCaptureKit delivers screen and system-audio samples to one output object. That object zeroes each stream against its own first timestamp, subtracts paused time, and hands frames to the writer's serial queue. The writer drops frames when the encoder is not ready, and counts the drops. Microphone buffers come from an audio-engine tap and are re-timed by a small helper with its own pause bookkeeping. They are then either written to their own track or resampled and queued for mixing into the system-audio buffers. On stop, the recorder repeats the last frame once so the file does not end early, finalizes, and writes the cursor-event sidecar. It saves a library row and a thumbnail, and starts transcription in the background.

**Sharing flow.** The app asks the Worker for an upload slot, which carries the title, size, an optional client-side password hash and an optional call to action. It gets back a share code, URL and expiry. It uploads the raw MP4 in 10 MB multipart parts, then the thumbnail, then a metadata post with transcript segments, title, summary and chapters. The link is copied to the clipboard. If the transcript or title changes later, the coordinator posts the metadata again, and the Worker replaces what it has. The Worker serves the page, range requests for video, WebVTT generated from the stored segments, reactions, comments and password checks. A daily cron deletes expired objects and rows.

**Why it is built this way.** The README and code comments give these reasons. Recordings stay on the Mac, sharing runs on the user's own free-tier Cloudflare account, and the app is pure Swift for a small binary. The HEVC master is uploaded as-is because re-encoding was a bottleneck. The library moved from one JSON file to SQLite so one corrupt row cannot wipe everything and so the CLI can read while the app writes.

## Best ideas

1. **Agent-first CLI with a self-describing contract** (extensibility-automation; copy-with-notice; must). `voom guide --json` prints every command, its usage and a summary. `targets` lists displays and windows with ids, and `record` takes a display or window id, audio flags and an optional duration. Recording stops on Ctrl-C or when the duration ends, and prints the new recording's id, title and path. Results go to stdout as JSON, and errors go to stderr as JSON with a non-zero exit. The bundled skill tells agents to read the guide first instead of hard-coding flags, so the skill cannot drift from the binary. App and CLI share a WAL-mode SQLite library. This is the clearest model in either repo for David's "drive it from an agent" goal. See `Packages/VoomCLI/Sources/voom/main.swift` and `Packages/VoomCLI/skill/voom/SKILL.md`.
2. **One-click self-host deploy from an API token** (sharing-hosting; copy-with-notice; must). Given a Cloudflare token, the app finds the account. It then creates the bucket and the database, applies the schema and migrations, uploads a Worker script bundled in the app, enables the workers.dev subdomain, and sets a daily cron. The Worker also migrates its own schema on first request, so a plain deploy works with no setup steps. CI fails if the bundled Worker drifts from source. This turns "storage he controls" into a two-minute setup. See `Packages/VoomCore/Sources/VoomCore/Services/Sharing/CloudflareDeployService.swift:99-575`.
3. **Share Worker essentials** (sharing-hosting; copy-with-notice; should). It uses multipart upload in 10 MB parts with an explicit abort on failure, and range-request streaming straight from object storage. Share codes are 10 characters from an alphabet without look-alike characters. Links expire after 30 days and can be renewed, a cron sweep cleans up, and a bearer secret is compared in constant time. Password checks are attempt-limited per IP and per video, and a successful unlock sets an HMAC cookie tied to the expiry. See `voom-share/src/index.js:590-630` and `voom-share/src/index.js:797-870`.
4. **Share first, enrich later** (transcription-captions; copy-with-notice; should). The link goes out at once. When transcription finishes, or the user retitles the recording, the app re-posts transcript, title, summary and chapters, and the server replaces the old values instead of adding to them. The coordinator re-reads the store rather than writing back the snapshot it took before the upload, so it never overwrites work that finished in the meantime. This keeps Loom-style speed without losing captions. See `Packages/VoomCore/Sources/VoomCore/Services/Sharing/ShareCoordinator.swift`.
5. **Interactive share page built from transcript data** (viewer-web; copy-with-notice; should). The page has WebVTT captions generated on the server from stored segments, a clickable synced transcript, chapters, reactions and comments pinned to timestamps, an end-of-video call-to-action, an embed route and an Open Graph image. See `voom-share/schema.sql` and `voom-share/web/src/scripts/player.ts`.
6. **Bring-your-own LLM with an on-device fallback** (ai-features; copy-with-notice; should). The provider is detected from the API key's prefix. Titles, summaries and chapters are generated from a transcript sampled evenly across the whole recording (about 60 to 80 segments), so chapters cover the full length. If the provider fails or no key is set, Apple's on-device model takes over. See `Packages/VoomCore/Sources/VoomCore/Services/TextAnalysis/TextAnalysisService.swift`.
7. **Audio timing and resampling done right** (capture-audio; copy-with-notice; should). When moving an audio buffer to a new timestamp, shift every timing entry by one offset rather than writing one entry with the whole buffer's duration. The repo explains how the naive version stretches the span thousands of times. Microphone audio is normalised to 48 kHz mono before mixing, so Bluetooth and 44.1 kHz devices keep their pitch. See `Packages/VoomCore/Sources/VoomCore/Services/Capture/AudioSampleTiming.swift` and `Packages/VoomCore/Sources/VoomCore/Services/Capture/MicResampler.swift:1-20`.
8. **Window capture that follows the window, with a drawn bubble** (capture-screen; copy-with-notice; could). A window-following filter records the window's own content even when it is covered or moved across displays. A window filter cannot include another window, so the camera is composited into each frame with a feathered circular mask on a Metal-backed context. If compositing fails, the raw frame is used so no frame is dropped. See `Packages/VoomCore/Sources/VoomCore/Services/Capture/CameraCompositor.swift:1-130`.
9. **Meeting detection and echo-aware diarization** (ai-features; copy-with-notice; could). Every 10 seconds the app checks two signals: a calendar event containing a meeting link, and another app using the camera. When both fire it offers to record. Meetings keep separate microphone and system reference tracks. An echo-bleed detector estimates how much speaker output leaks into the microphone, so remote voices are not labelled as the local user. See `Packages/VoomMeetings/Sources/VoomMeetings/Services/MeetingDetectionService.swift:78-310`.
10. **Lossless passthrough edits with transcript remapping** (editing; copy-with-notice; could). Trim, cut and stitch are built as compositions and exported without re-encoding, which makes them fast and lossless. Transcript segment times are then shifted to match the cuts. See `Packages/VoomCore/Sources/VoomCore/Services/Editing/VideoEditor.swift`.
11. **Saved recording presets** (recording-controls; idea-only; could). A named preset stores mode, camera, microphone, system audio and bubble corner, so a common setup is one click. See `Packages/VoomCore/Sources/VoomCore/Models/RecordingPreset.swift`.
12. **Library index that survives corruption** (project-format; copy-with-notice; could). The library stores one JSON blob per row in SQLite with WAL mode and a busy timeout, so the app and CLI can share it. If the index is empty but MP4s exist, it rebuilds from a disk scan and probes metadata in the background. See `Packages/VoomCore/Sources/VoomCore/Services/Storage/LibraryDatabase.swift:1-60`.

## Weaknesses and gaps

- **The camera and cursor are baked in.** There is no separate camera file and no cursor-free master, so layouts, bubble position and cursor styling cannot change after recording. That conflicts with David's separate-track editor. The cursor sidecar is saved but nothing uses it: the auto-zoom analyzer has no callers.
- **Crash safety is weak.** The writer produces a plain MP4 with no movie fragments, so a hard crash before finalize most likely leaves an unplayable file. Salvage only covers a finalize that fails cleanly. I inferred this from the writer settings and did not test it.
- **A/V sync risk.** Screen, system audio and microphone are each zeroed against their own first sample instead of one shared start time, and mixed microphone audio is added by sample count, not timestamp, with a one-second cap. Start-up skew or a device hiccup can shift audio against video. The fixed gains are also odd: system audio drops to 5 percent when mixed and the microphone is boosted 4.5 times, which risks clipping.
- **Rigid output.** Recordings use a fixed 8 Mbps HEVC MP4 with B-frames, which is low for Retina displays and may not play in every browser that opens a share link. Re-encoding was removed. There is no H.264 option and no resolution or frame-rate choice.
- **Crude word timing.** Word deletion estimates times from each word's position in its segment, so cuts can land mid-word.
- **Security nits.** The share password seems to be kept in plaintext in the local library row (it is a plain Codable field). Passwords are stored as a fast salted SHA-256, not a slow hash, which matters if the database leaks. Video responses carry a public cache header even when a password is set, though I did not verify what Cloudflare's edge does with that. The dashboard password falls back to the API secret.
- **Permissions all at once.** Screen, camera, microphone and accessibility are requested together at launch rather than when each is first needed.
- **No teleprompter, no export settings, no compositing studio.**
- **Instructions inside the repo, which I did not follow.** `AGENTS.md`, `CLAUDE.md` and the CLI README contain build, deploy and skill-install commands aimed at agents (for example copying the skill into a Claude skills folder). I treated them as data only.
- **Verification limits.** I read source and docs only; I built and ran nothing. Quality scores come from reading the code.

## Inspected paths

- `README.md` - feature list, Loom comparison, Cloudflare free-tier rationale.
- `AGENTS.md` - module layout, CLI and app sharing the library, Keychain rule, Worker bundle drift check.
- `CHANGELOG.md` - Parakeet Ultra model, transcription resume, share metadata re-sync, window mode.
- `Packages/VoomApp/Sources/VoomApp/Capture/ScreenRecorder.swift:26-213` - filter with PiP and annotation windows added back, stream config, mic wiring.
- `Packages/VoomApp/Sources/VoomApp/Capture/ScreenRecorder.swift:215-324` - stop, final-frame repeat, salvage, cursor sidecar, auto-transcribe.
- `Packages/VoomApp/Sources/VoomApp/Capture/ScreenRecorder.swift:345-519` - per-stream zeroing, pause offsets, window bubble compositing.
- `Packages/VoomCore/Sources/VoomCore/Services/Writing/VideoWriter.swift:20-134` - MP4 HEVC writer, mixed or separate audio tracks, fixed gains.
- `Packages/VoomCore/Sources/VoomCore/Services/Writing/VideoWriter.swift:244-389` - sample-count mic mixing with a one-second buffer cap.
- `Packages/VoomCore/Sources/VoomCore/VideoQualityPreset.swift` - 60 fps at 8 Mbps for screen, 30 fps at 4 Mbps for meetings.
- `Packages/VoomCore/Sources/VoomCore/Services/Capture/MicTimeAdjuster.swift` - mic re-timing with pause bookkeeping.
- `Packages/VoomCore/Sources/VoomCore/Services/Capture/AudioSampleTiming.swift` - correct buffer retiming and the explanation of the naive bug.
- `Packages/VoomCore/Sources/VoomCore/Services/Capture/MicResampler.swift:1-20` - why the mic is normalised to 48 kHz mono.
- `Packages/VoomCore/Sources/VoomCore/Services/Capture/CameraCapture.swift:155-281` - audio-engine tap converted to sample buffers on host time.
- `Packages/VoomCore/Sources/VoomCore/Services/Capture/CameraCompositor.swift:1-130` - circular bubble compositing for window captures.
- `Packages/VoomApp/Sources/VoomApp/Capture/CameraOnlyRecorder.swift` - webcam-only recording path.
- `Voom/Voom/Views/Overlay/RecordingOverlay.swift:144-362` - 240-point camera panel, shadows, corner placement, panel level.
- `Voom/Voom/Views/Overlay/AnnotationOverlay.swift:1-25` - live drawing panel.
- `Voom/Voom/Views/Panel/RecordingSessionController.swift:145-404` - mode resolution, countdown, recorder selection, stop and quit.
- `Voom/Voom/Views/Panel/ControlPanelView.swift:120-196` - hotkey toggle, stream-stop handling, presets, stop then open library.
- `Voom/Voom/App/AppDelegate.swift:23-117` - menu-bar item, global hotkey registration, upfront permission requests.
- `Packages/VoomCore/Sources/VoomCore/Services/GlobalHotkey.swift` - Command-Shift-R registration.
- `Packages/VoomCore/Sources/VoomCore/Models/Recording.swift:72-125` - library row fields, including share password and sidecar URLs.
- `Packages/VoomCore/Sources/VoomCore/Services/Storage/LibraryDatabase.swift:1-60` - SQLite JSON rows in WAL mode, shared with the CLI.
- `Packages/VoomCore/Sources/VoomCore/Services/Storage/RecordingStorage.swift:95-130` - rebuilding the index from MP4s on disk.
- `Packages/VoomCLI/Sources/voom/main.swift` - CLI commands, JSON output, SIGINT stop.
- `Packages/VoomCLI/skill/voom/SKILL.md` - agent skill that defers to the guide command.
- `Packages/VoomCLI/README.md` - CLI build and usage.
- `Packages/VoomCore/Sources/VoomCore/Services/Sharing/ShareService.swift:129-417` - upload slot, multipart parts, abort, metadata post, bearer auth.
- `Packages/VoomCore/Sources/VoomCore/Services/Sharing/ShareCoordinator.swift` - copy link, re-read store, metadata re-sync.
- `Packages/VoomCore/Sources/VoomCore/Services/Sharing/CloudflareDeployService.swift:99-575` - in-app backend deployment steps.
- `Packages/VoomCore/Sources/VoomCore/Services/Sharing/ViewNotificationService.swift` - five-minute view polling and notifications.
- `voom-share/src/index.js:1-12` - share code alphabet, length, expiry days.
- `voom-share/src/index.js:590-630` - upload slot and salted password storage.
- `voom-share/src/index.js:797-870` - range-request video streaming.
- `voom-share/src/index.js:1035-1052` - cron cleanup of expired shares.
- `voom-share/schema.sql` - videos, transcript segments, reactions, comments, chapters, password attempts.
- `voom-share/web/src/scripts/player.ts` - player controls, captions, transcript sync, call-to-action overlay.
- `Packages/VoomCore/Sources/VoomCore/Services/Transcription/TranscriptionService.swift:20-80` - Parakeet model load and one retry after Core ML invalidation.
- `Packages/VoomCore/Sources/VoomCore/Services/Transcription/EchoBleedDetector.swift:1-30` - echo leak model for diarization.
- `Packages/VoomCore/Sources/VoomCore/Services/TextAnalysis/TextAnalysisService.swift` - title, summary, chapters, provider then on-device fallback.
- `Packages/VoomAI/Sources/VoomAI/AIProvider.swift:1-40` - provider endpoints and key-prefix detection.
- `Packages/VoomCore/Sources/VoomCore/Services/Editing/VideoEditor.swift` - passthrough trim, cut, stitch, transcript remap.
- `Packages/VoomCore/Sources/VoomCore/Services/Editing/TranscriptEditor.swift:20-40` - word time estimated by position.
- `Packages/VoomCore/Sources/VoomCore/Services/Editing/AutoZoomAnalyzer.swift` - click-cluster zoom keyframes, not called by the app.
- `Packages/VoomCore/Sources/VoomCore/Services/Export/GIFExporter.swift` - 10 fps GIF of up to 15 seconds.
- `Packages/VoomCore/Sources/VoomCore/Services/Export/TranscriptExporter.swift` - SRT, VTT, TXT and JSON export.
- `Packages/VoomCore/Sources/VoomCore/Services/Editing/PrivacyBlurRenderer.swift` - blur regions applied by re-encoding.
- `Packages/VoomMeetings/Sources/VoomMeetings/Services/MeetingDetectionService.swift:78-310` - calendar and camera-in-use polling.
- `Packages/VoomMeetings/Sources/VoomMeetings/Services/MeetingRecorder.swift` - meeting preset and separate reference audio files.
- `Packages/VoomCore/Sources/VoomCore/Models/RecordingPreset.swift` - saved recording configurations.
- `Voom/Voom/Resources/Voom.entitlements` - sandbox off, camera and audio input.
- `Voom/Voom/Resources/Info.plist` - Sparkle feed and usage descriptions.
