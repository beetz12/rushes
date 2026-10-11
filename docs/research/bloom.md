# Bloom

## Snapshot

- Repo: video-db/bloom, clone folder `video-db__bloom`.
- Pinned SHA: 65aa9bf555d2 (clone HEAD 65aa9bf555d2b72c50f8e246eac290d704c6907c).
- Licence: MIT (from the LICENSE file; note that package.json says ISC, an inconsistency in the repo). Files and identifiers may be cited and code may be copied with the MIT notice.
- Stars: 235 (from sources.json).
- Stack: plain JavaScript on Electron 39 (CommonJS main process, vanilla HTML and JS renderer with a context bridge), `sql.js` for a local SQLite file, the `videodb` npm SDK (0.2.x) whose capture side spawns a closed native binary, `hls.js` for playback.
- Platforms: macOS (arm64 and x64 DMG) and Windows (NSIS installer, added in 2.2.0). Linux is listed as future.
- Latest commit in the clone: 2026-04-01. App version 2.2.0. The project was renamed from an earlier "Async Recorder" in March 2026 (CHANGELOG).

## What it does

Bloom is a thin desktop front end for VideoDB's cloud. A floating bar at the bottom of the screen toggles screen, microphone, system audio and a camera bubble, picks a display, and starts or stops recording (also with Command or Ctrl plus Shift plus R). The VideoDB capture binary records the chosen display, mic and system audio and streams chunks to VideoDB while recording. After stop the app polls the cloud until the session has been exported as a video, then asks the cloud to index spoken words, fetches the transcript and generates a subtitled HLS stream.

A library window lists recordings from a local SQLite file, plays them through HLS, lets the user rename, delete with undo, download the MP4 or the transcript, copy a share link, and open "chat with video" on VideoDB's hosted chat site. All the media and every AI step live in VideoDB's cloud, billed to the user's own API key; the local database stores only IDs, URLs, names, status and a cached transcript.

The README describes Bloom as local-first and agent-ready. Reading the code, neither claim holds inside this repo: no media file is written locally by the app during recording (downloads come back from the cloud), and there is no CLI, MCP server or local API. The "agent" story is that recordings sit in a VideoDB collection that agents can query with VideoDB's own APIs. The repo is still useful for its recording bar UX, per-track pause, the post-stop processing state machine and the permissions onboarding.

## Feature inventory

- capture-screen (3): one display per session, chosen in a small picker window; the screen track can be paused mid-recording. Capture is done by VideoDB's native binary, so resolution, frame rate and codec are not visible in this repo.
- capture-camera (1): the camera is only a 640 by 640 preview in an overlay window, captured as part of the screen. It is not a capture channel.
- capture-audio (3): mic and system audio are separate channels, each stored; either can be paused and resumed mid-recording, and channels switched off before start are paused immediately after start.
- recording-controls (3): always-on-top bottom bar, click-through outside the bar, hidden from the capture, visible on every space including full-screen apps, recording timer, tray menu, global shortcut, a "gearing up" state that blocks a second start, system notifications.
- camera-overlay (2): round, draggable, resizable 250 px window at the lower right, shown without taking focus; the camera stream stops whenever the window is hidden.
- annotation (0): absent.
- compositing-render (0): absent locally; export happens in the cloud.
- editing (0): absent; only renaming.
- transcription-captions (3): cloud spoken-word indexing, transcript text cached in the local DB, burned-in subtitle stream with a fixed style, transcript download as text.
- ai-features (2): "chat with video" opens VideoDB's hosted chat with the video and collection IDs; the spoken-word index makes the video searchable through VideoDB. No AI runs locally.
- export-formats (1): MP4 download from the cloud and transcript as plain text.
- project-format (0): no project file; a local SQLite table of recording metadata.
- sharing-hosting (3): upload during recording is automatic; a copy-link button fetches a fresh player URL. Hosting is VideoDB only.
- viewer-web (2): in-app HLS player (hls.js, native fallback) and VideoDB's hosted player link.
- teleprompter-scripts (0): absent.
- platform-packaging (2): electron-builder DMG and NSIS; unsigned macOS build; a curl-to-bash installer that strips quarantine; an afterPack hook that re-signs the nested capture app and adds privacy usage strings.
- performance-reliability (2): duplicate-start guard, a DB row created before capture, a status state machine, startup and manual re-sync of unfinished recordings, reuse of one capture process. No local fallback if the upload fails.
- extensibility-automation (2): no CLI or agent API in the repo; recordings land in one named VideoDB collection with session metadata, which external agents can query through VideoDB; env and file hooks allow scripted setup.
- privacy-security (2): context isolation on for every window, the control bar is excluded from capture; but the API key is stored in plain text in SQLite, all media goes to a third-party cloud, the build is unsigned with broad hardened-runtime exceptions, and hls.js is loaded from a CDN at an unpinned version.

## Architecture

Main process (`src/main/index.js`) creates five window types: the floating bar, the camera bubble, a display picker, the library (history) and modal windows for onboarding and permissions. It also owns the tray, the global shortcut and process signals. IPC handlers are split by concern under `src/main/ipc/` (capture, camera, config, history, permissions). Services under `src/main/services/` wrap the VideoDB SDK (`videodb.service.js`), session tokens and sync polling (`session.service.js`), and transcript plus subtitle indexing (`insights.service.js`). `src/main/db/database.js` keeps an in-memory sql.js database and rewrites the whole file to disk after each change. The preload (`src/preload/index.js`) exposes two bridged objects to the renderer, one for recording and library calls and one for config and auth.

Recording flow (`src/main/ipc/capture.js`): check the stored user; create a capture session in the "Bloom Recordings" collection with the client session ID and start time as metadata; insert a local row with status `recording` before anything is captured; get or reuse a cached client token (24-hour lifetime, refreshed five minutes early); reuse one `CaptureClient` (one native process) or create it; list channels and pick mic, system audio and display (display marked primary, all with store on); check macOS permissions; start. Stop calls the client, sets status `processing`, and starts a background poll every 10 seconds for up to 60 tries (about 10 minutes) until the session reports an exported video ID. Then it stores the video ID, stream and player URLs and duration, marks `ready`, and starts indexing in the background, which moves through `indexing` back to `ready` with the transcript and subtitle URL. On launch and on a manual refresh, every row without a video, or stuck at `indexing`, is re-checked.

Why: the team builds the cloud, so the desktop app is deliberately thin. The README mentions WebSocket event delivery, but in this repo the app only polls (a startup log line says WebSocket, the code does not use it).

## Best ideas

1. **Per-track pause during recording** (capture-audio, copy-with-notice). Mic and system audio are separate stored channels; the bar's toggles pause or resume one track live, and anything toggled off before start is paused right after start. David gets "mute my mic for a cough" without stopping, and separate tracks for editing.
2. **Control bar that never appears in the video** (recording-controls, copy-with-notice). The bar window is content-protected so screen capture skips it, ignores mouse events except while the pointer is over the bar (events are forwarded so hover still works), and stays visible over full-screen apps on every space. The camera window is left capturable on purpose. On macOS native the same split is a window sharing type of none for controls and an explicit exclude list in ScreenCaptureKit.
3. **Local row first, then a resumable post-stop state machine** (performance-reliability, copy-with-notice). Insert the recording row before capture starts, move it through recording, processing, indexing, ready or failed, and on every launch or refresh re-check unfinished rows (poll for the export, or retry indexing). Any slow post-stop job (upload, transcription, thumbnail) survives restarts this way.
4. **Transcript pipeline that never blocks playback** (transcription-captions, idea-only). After the video exists, mark it playable, then index speech, cache the transcript text locally, and generate a subtitled stream in the background; no speech is a normal outcome, not an error. For David the same shape runs a local speech model after stop and saves the transcript next to the recording.
5. **Guided permissions onboarding** (privacy-security, copy-with-notice). A modal with one Grant button per permission and an animated preview of the system dialog, swapping to a "how to fix it in Settings" preview after a denial; it opens the right Settings pane, and it checks screen permission only after the mic is granted so the macOS screen prompt does not fire too early.
6. **One named collection plus session metadata as the agent handle** (extensibility-automation, idea-only). Every recording goes into one named collection, and each capture session carries the client session ID and start time, so an outside agent can enumerate recordings and fetch transcripts by stable IDs. For David this suggests a local index (SQLite) with stable IDs and a JSON CLI over it.
7. **Copy-link button with clear states** (sharing-hosting, copy-with-notice). Disabled until the video exists, then "generating" while a fresh player URL is minted, "copied" for 2.5 seconds, then back to default; the URL is regenerated on demand so it includes subtitles once indexing is done.
8. **Library delete with a five-second undo** (viewer-web, copy-with-notice). Deleting animates the row out, selects the neighbour, shows an undo toast, and only commits after five seconds; a second delete flushes the first immediately.

## Weaknesses and gaps

- The local-first claim is not supported by this repo: the app writes no media locally, downloads come back from the cloud, and every AI step needs VideoDB. If upload or export fails there is nothing on disk to recover. Whether the closed capture binary keeps a local copy could not be checked, because its code is not in the repo.
- No agent-facing interface in the repo: no CLI, no MCP server, no local HTTP API, no transcript search inside the app (library search matches names only).
- The camera is a screen overlay, not a track; there is no editing, no annotation and no compositing.
- The VideoDB API key is stored in plain text in the local SQLite file; macOS builds are unsigned and the installer strips the quarantine flag; entitlements disable library validation and allow dyld environment variables; hls.js loads from a CDN at "latest".
- A runtime patch replaces Node's child-process spawn so the capture binary runs from a writable copy, which is fragile across SDK updates.
- The indexing service opens the account's default collection while recordings live in the named Bloom collection, so indexing may not find the video (my inference from reading, not verified against the SDK).
- Documentation drift: the README lists an auth IPC file that does not exist, describes WebSocket events the code never uses, and its reset steps name a database file that differs from the one the code writes; the package.json licence field disagrees with LICENSE.
- The renderer can ask the main process to open any external URL and to merge arbitrary keys into the saved config; harmless while the UI is trusted, but loose.
- sql.js rewrites the whole database file on every update.
- Verified by reading: claims with paths. Not verified: native capture behaviour, codecs and any local buffering. Nothing was built or run. The README tells users to pipe a remote installer into bash and to strip quarantine with xattr; those were treated as data and not followed.

## Inspected paths

- `README.md` - claims, architecture diagram, setup steps.
- `CHANGELOG.md` - version history, rename, Windows support.
- `SECURITY.md` - reporting scope.
- `package.json` - Electron 39, sql.js, videodb SDK, builder config, usage strings.
- `install` - curl installer, quarantine removal.
- `build/afterPack.js` - nested capture app re-sign and plist patch.
- `build/entitlements.mac.plist` - hardened runtime exceptions.
- `src/main/index.js:45-89` - floating bar window, content protection, click-through.
- `src/main/index.js:225-253` - camera bubble window.
- `src/main/index.js:505-564` - startup services and scripted auto-registration.
- `src/main/index.js:690-822` - bar IPC, global shortcut, shutdown.
- `src/main/ipc/capture.js` - session creation, channel selection, permissions, start, stop, per-track pause.
- `src/main/ipc/history.js` - library, share URL, MP4 and transcript download, chat link, rename, delete.
- `src/main/ipc/camera.js` - camera permission and bubble show or hide.
- `src/main/ipc/permissions.js:1-60` - permission check and request.
- `src/main/ipc/config.js` - API key registration and local access token.
- `src/main/services/session.service.js` - token cache, export polling, indexing state, re-sync.
- `src/main/services/videodb.service.js` - collection, capture session, share URL, download, transcript.
- `src/main/services/insights.service.js` - spoken-word index, transcript, subtitle style.
- `src/main/db/database.js` - schema, migrations, unresolved query, whole-file save.
- `src/main/lib/videodb-patch.js` - binary relocation and spawn redirect.
- `src/main/lib/config.js` - persisted auth config.
- `src/main/lib/paths.js` - data, config and log file locations.
- `src/preload/index.js` - bridged renderer API.
- `src/renderer/camera.js` - camera preview constraints and stop on hide.
- `src/renderer/camera.html` - round draggable bubble styling.
- `src/renderer/display-picker.js` - display list window.
- `src/renderer/renderer.js:70-130` - start flow and permission check order.
- `src/renderer/ui/bar.js:330-400` - track toggles and pre-start pauses.
- `src/renderer/ui/permissions.js:1-70` - guided permission buttons.
- `src/renderer/permissions.html` - animated permission previews and denied variants.
- `src/renderer/history.js:495-580` - delete with undo.
- `src/renderer/history.js:620-660` - HLS playback.
- `src/renderer/history.js:740-800` - copy-link button states.
