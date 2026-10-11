# Kap

## Snapshot

- Repo: wulkano/Kap, clone folder `wulkano__Kap`.
- Pinned SHA: c42692fa63ac (clone HEAD c42692fa63ac71ed192e01684beb78a1b864aa88).
- Licence: MIT (permissive). File and type names may be cited, and ideas may use copy-with-notice with the MIT notice kept.
- Stars: 19392 (from sources.json).
- Stack: TypeScript main process on Electron 13.6.9; renderer is React 17 on Next.js 10, exported as static pages; state in unstated containers; settings in electron-store; capture by the `aperture` npm package (a Swift command-line recorder from the same team); conversion by `ffmpeg-static` and `gifsicle` child processes. Tests use ava against real fixture videos.
- Platforms: macOS only (`minimumSystemVersion` 10.12.0 in package.json), Apple silicon and Intel builds.
- Latest commit in the clone: 2024-02-14 (a CI config change). The clone is shallow, one commit deep, so the project's activity history cannot be read from git here. App version 3.6.0.

## What it does

Kap is a menu bar screen recorder for macOS. Clicking the menu bar icon covers every display with a transparent cropper; the user drags a region, picks a preset aspect ratio, types exact dimensions, snaps the crop to an open app window, or goes full screen, then presses record. While recording, the menu bar icon animates and becomes the stop button; Option-click pauses and right-click opens a menu. Settings cover 30 or 60 fps, showing the cursor, highlighting clicks, and recording one microphone. There is no camera and no system audio.

On stop, an editor window opens with the recording. The user trims start and end on a play bar, scales the output (with ratio lock, percentage presets and arithmetic in the size fields), picks frame rate, mutes, takes a JPEG snapshot of the current frame, and chooses an output format: GIF, MP4 (H.264), WebM (VP9), APNG, HEVC or AV1. The export menu lists share targets for that format. Built-in targets save to disk, copy the file to the clipboard, or open it with any app that handles the extension. Everything else comes from plugins installed from npm: uploaders such as GIPHY, S3, Dropbox, Imgur and Streamable are named in the plugin docs, and edit plugins can reverse or speed up the clip before conversion.

Kap's distinctive design is that the editor never decides where a file goes. Export is a pipeline of conversion followed by a share service, and the share service asks for the converted file only when it needs it. That separation, plus a small, documented plugin contract, is the main thing worth borrowing. The capture side has aged: it depends on an external native recorder binary, has no camera, no system audio and no separate tracks.

## Feature inventory

- capture-screen (3): `aperture` records a crop rectangle on a chosen display at 30 or 60 fps with optional cursor and native click highlighting, producing H.264 in MP4. The cropper converts the selection from top-left to the bottom-left origin that the native recorder expects. HEVC capture is present but commented out with a TODO.
- capture-camera (0): absent.
- capture-audio (2): one microphone, chosen from devices listed by `macos-audio-devices` (built-in first, then by name), falling back to the recorder's own device list. Off by default. No system audio.
- recording-controls (3): menu bar icon as start and stop, Option-click pause, animated icon while recording, a configurable global shortcut (default Command+Shift+5), pause and resume with duration tracking, a discard confirmation when closing a new recording's editor, and a quit guard while exports run.
- camera-overlay (0): absent.
- annotation (0): absent; only the native click highlight option.
- compositing-render (0): absent; export applies scale, crop and frame rate only.
- editing (2): trim, scale, fps, mute, frame snapshot, and edit-service plugins that receive a trimmed MP4 and must write another MP4.
- transcription-captions (0): absent.
- ai-features (0): absent.
- export-formats (4): six formats with tuned ffmpeg settings, two-pass palette GIF with optional gifsicle lossy compression, loop control, progress and time-remaining estimates, cancellation, and a conversion cache.
- project-format (0): no project file. A small JSON store records the active recording and past recordings by path.
- sharing-hosting (3): share-service plugins, built-in save, clipboard file reference and Open With, and deep-link OAuth for uploaders. No hosted viewer of its own.
- viewer-web (0): absent.
- teleprompter-scripts (0): absent.
- platform-packaging (3): electron-builder with notarisation, hourly auto-update checks, menu bar only (dock hidden), forced move to /Applications, CI-built releases.
- performance-reliability (3): crash detection through a persisted active-recording record, a decode check on next launch, repair attempt for one known error, and record-plugin cleanup after a crash.
- extensibility-automation (4): the best plugin contract seen in this batch: share, edit and record services, JSON Schema config, lifecycle hooks, deep links. No CLI.
- privacy-security (2): analytics code is disabled; Sentry is used with scrubbing; but plugins run with full Node access in the main process and are reinstalled from npm at launch, and the cropper window runs with Node integration on and context isolation off.

## Architecture

There are three layers. The main process (`main/`) owns the tray, global shortcuts, windows, recording control (`main/aperture.ts`), the plugin manager (`main/plugins/`), conversion (`main/conversion.ts` and `main/converters/`) and export orchestration (`main/export.ts`). The renderer (`renderer/`) is a set of Next.js pages: cropper, editor, exports list, preferences, plugin config and dialogs. They communicate through `electron-better-ipc` plus a small "remote state" layer (`main/remote-states/`): each named state has a getter, a set of actions, and pushes updates to every subscribed window, which keeps editor option menus live when plugins are installed or reconfigured.

Recording flow: the cropper reports bounds, display and ratio; `startRecording` reads settings, builds `ApertureOptions`, collects enabled record services and runs their `willStartRecording` hooks, starts the native recorder, persists the active recording (path, options and each plugin's persisted state) to the `recording-history` store, then runs `didStartRecording`. Stop reverses this, runs `didStopRecording`, wraps the file in a `Recording` (a `Video` with known fps, encoding and pixel density) and opens the editor.

Export flow: the editor sends format, size, fps, trim range, mute and the chosen share service. `Export` builds a `ShareServiceContext` whose `filePath()` lazily creates or reuses a `Conversion`. A `Conversion` is keyed by a hash of source path, format and options, so exporting the same settings to a second target reuses the file. `convertTo` picks the converter for the source encoding (only H.264 is mapped) and format; if an edit service is chosen it first crops to a temporary MP4, runs the plugin with a cancellable `convert(args)` helper, then converts the plugin output. Every ffmpeg or gifsicle run goes through one cancellable process wrapper that streams stderr into progress and an estimate.

Why: the team wanted an extensible exporter without building every uploader. Keeping conversion lazy and cached means share plugins stay tiny and format-agnostic, and Kap controls progress UI for the expensive step.

## Best ideas

1. **Share-service contract with lazy file conversion** (extensibility-automation, copy-with-notice). A share target declares a title, the formats it accepts and an action. The action receives a context with `filePath()` that converts on demand, plus `setProgress`, `notify`, `copyToClipboard`, a cancellable `request`, `cancel` and `waitForDeepLink`. David can define "Upload to my S3", "Copy share link" and "Send to editor" as targets of the same shape, and an agent can invoke them by name.
2. **Conversion cache keyed by inputs** (export-formats, copy-with-notice). Hash source path, format and options to identify a conversion; reuse a finished file for further shares; reset on failure so a retry starts clean; let a target override the format.
3. **Record-time hooks with crash cleanup** (extensibility-automation, copy-with-notice). Record services get start and stop hooks and a shared state object; the serialisable part is stored with the active recording, and on the next launch after a crash each service's `cleanUp` receives it. This is how "turn on Do Not Disturb and hide desktop icons while recording" can be done safely.
4. **Persisted active recording and a launch-time check** (performance-reliability, copy-with-notice). Write the in-progress recording to a small store at start, delete it on clean stop, and on launch decode-check any leftover file and offer Show in Editor, Show in Finder or Copy Error, with a repair step for known errors.
5. **Copy the file itself, or open it with any app** (sharing-hosting, copy-with-notice). Put a Finder file reference on the pasteboard so pasting into Slack or Mail attaches the video, and list every app registered for the extension, default first.
6. **Cropper with ratio snapping and app-window snap** (recording-controls, copy-with-notice). One transparent window per display; dimensions snap to the nearest common aspect ratio; ratio lock and swap; pick a running app window (sorted by how often it was used) to size the crop to it; remember the last crop per display.
7. **Menu bar icon as the recording control** (recording-controls, idea-only). Click to start the cropper, click to stop, Option-click to pause, right-click for a menu, animated icon while recording, no dock icon.
8. **ffmpeg progress and time remaining** (export-formats, copy-with-notice). Parse `time=` and `speed=` from stderr, compute progress against the trimmed duration, and show an estimate only after two seconds of media or 15 seconds of wall time so it does not jump around; kill the child on cancel.
9. **Two-pass palette GIF and APNG** (export-formats, copy-with-notice). Generate a palette, then apply it with Lanczos scaling, fall back to a direct pass if the palette is missing for very short clips, optionally compress with gifsicle (lossy level 50), and control looping per format.
10. **JSON Schema plugin config** (extensibility-automation, copy-with-notice). Each service declares config keys with JSON Schema; validation hides a service until its config is valid; required keys open the config on install; custom types render colours and keyboard shortcuts.
11. **App URL scheme for OAuth and actions** (sharing-hosting, copy-with-notice). A `kap://` route table hands `plugins/<name>/<rest>` to the waiting plugin and routes install or configure requests. The same pattern gives an agent a way to trigger app actions from a link.
12. **Menus ranked by recent use** (export-formats, copy-with-notice). Formats and share targets sort by last use and frame rate is remembered per format, so a repeat export is one click.
13. **Instant copies on APFS** (platform-packaging, copy-with-notice). Saving the original uses a clone-on-write copy, which is free in time and space on APFS.

## Weaknesses and gaps

- No camera, no system audio, no separate tracks, no cursor data; it records a flat screen region only.
- Raw recordings are temporary: on quit Kap deletes every past recording, so only exports survive. That is the opposite of a local library.
- Why it went stale (inferred from the pinned code, not from history, because the clone is shallow): it is pinned to Electron 13 and windows enable the `remote` module, which later Electron releases dropped (general knowledge, not checked in the clone); Next.js 10, React 17 and `got` 9 are similarly old; HEVC capture is stubbed out with a TODO; analytics are disabled with a TODO; capture depends on a separate native package whose code is not in this repo. Each dependency upgrade became a migration project.
- Plugins run with full Node access in the main process, are installed with a bundled yarn, and are re-installed at every launch from the npm registry. That is a supply-chain and network-on-launch risk.
- The cropper window runs with Node integration on and context isolation off.
- Media inspection parses ffmpeg's human-readable stderr for fps and codec instead of structured probe output, which is fragile across ffmpeg versions. Only H.264 sources have a converter, so an HEVC source would fail export.
- The one known repair (a faststart remux when the MP4 index is missing) probably cannot work, because remuxing needs that index. Fragmented MP4 at capture time is the real fix.
- Plugin docs list four share formats while the code supports six.
- Verified by reading: all claims with paths. Not verified: the native recorder's internals and output location, which live in the separate aperture project. Nothing was built or run. The README and plugin docs contain shell instructions for installing and linking plugins; they were treated as data and not followed.

## Inspected paths

- `README.md` - product summary and usage tips for pause and menu.
- `docs/plugins.md` - share, edit and record service contracts, config schema, OAuth deep links.
- `maintaining.md` - release process through CI.
- `PRIVACY.md` - analytics and Sentry stance.
- `package.json` - Electron 13, Next 10, aperture, ffmpeg-static, gifsicle, minimum macOS.
- `main/index.ts` - startup order, crash check, permissions gate, deep links, quit cleanup.
- `main/aperture.ts` - recording start, stop, pause, resume and record-service hooks.
- `main/common/types/base.ts` - Format, Encoding and ApertureOptions types.
- `main/common/settings.ts` - defaults: Kaptures folder, 30 fps, cursor on, audio off, shortcut.
- `main/common/constants.ts` - format list and extensions.
- `main/common/system-permissions.ts` - screen and microphone permission prompts.
- `main/common/analytics.ts` - analytics disabled.
- `main/recording-history.ts` - active recording persistence, crash check and repair.
- `main/video.ts` - Video and Recording models, preview conversion.
- `main/conversion.ts` - cached conversion keyed by hash.
- `main/export.ts:1-140` - Export object and share context wiring.
- `main/converters/index.ts` - converter selection and edit-service pipeline.
- `main/converters/h264.ts` - per-format ffmpeg settings.
- `main/converters/process.ts` - cancellable ffmpeg and gifsicle wrapper.
- `main/converters/utils.ts` - progress and estimate parsing, even sizes, conditional args.
- `main/plugins/index.ts` - plugin install, upgrade, npm discovery, built-ins.
- `main/plugins/plugin.ts` - installed and npm plugin models, compatibility, record service enablement.
- `main/plugins/service.ts` - service interfaces and hook names.
- `main/plugins/config.ts` - JSON Schema validation per service.
- `main/plugins/service-context.ts` - share, edit and record contexts.
- `main/plugins/built-in/save-file-plugin.ts` - save to disk and save dialog filters.
- `main/plugins/built-in/copy-to-clipboard-plugin.ts` - Finder file reference on the pasteboard.
- `main/plugins/built-in/open-with-plugin.ts` - open with registered apps.
- `main/utils/deep-linking.ts` - URL scheme routes.
- `main/utils/encoding.ts` - codec detection and H.264 preview conversion.
- `main/utils/fps.ts` - fps detection from stderr.
- `main/utils/image-preview.ts` - preview image and snapshot.
- `main/utils/devices.ts:1-60` - microphone listing and fallback.
- `main/utils/windows.ts:1-60` - app window list with usage history.
- `main/tray.ts` - menu bar icon behaviour.
- `main/global-accelerators.ts` - configurable global shortcut.
- `main/windows/cropper.ts:1-90` - per-display transparent cropper windows.
- `main/windows/editor.ts:80-150` - discard confirmation and save original.
- `main/remote-states/editor-options.ts` - usage-ranked export menu and fps history.
- `main/remote-states/setup-remote-state.ts` - remote state pattern over IPC.
- `renderer/containers/cropper.js` - ratio snapping, app selection, fullscreen.
- `renderer/components/editor/options/left.tsx:1-80` - size inputs with arithmetic and percent presets.
- `renderer/components/editor/controls/play-bar.tsx` - trim handles and hover preview.
- `build/entitlements.mac.inherit.plist` - hardened runtime entitlements.
- `test/convert.ts:1-60` - conversion tests on real fixtures.
