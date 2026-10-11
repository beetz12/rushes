# Screenity (clean-room note)

## Snapshot

- Repo: alyssaxuu/screenity, clone folder `alyssaxuu__screenity`.
- Pinned SHA: dddeeb668ad2 (clone HEAD dddeeb668ad285155a48fa89298f0fe2ef273579).
- Licence: GPL-3.0 (copyleft, no permissive sub-paths). Every idea below is clean-room or idea-only. This note describes behaviour in my own words and uses no Screenity-internal identifiers; only file paths are cited.
- Stars: 18770 (from sources.json).
- Stack: JavaScript with some TypeScript, React 18, webpack, Chrome Manifest V3. Third-party libraries named in package.json: fabric.js 6 (vector drawing), mediabunny (WebCodecs muxing and remuxing), MediaPipe Tasks Vision (selfie segmentation), wavesurfer.js, gif.js, localforage, react-rnd, Radix UI, Plyr, JSZip.
- Platforms: Chromium browsers on macOS, Windows and Linux (it is a browser extension, not a native app).
- Latest commit in the clone: 2026-09-25. Extension version 4.6.12.

## What it does

Screenity is a free Chrome extension that records a browser tab, a dragged region of a tab, a whole screen or window, or the camera alone, with microphone and optional tab or system audio. While recording, the user can draw on the page, add text, arrows, shapes and images, highlight the cursor and clicks, dim everything but a spotlight around the cursor, blur page elements, and hold a key to zoom into the page around the pointer. A round camera bubble floats on the page and can be dragged and resized.

When recording stops, a local editor tab opens. It can trim, cut out a middle section, crop, mute, replace or add audio, and export MP4, WebM or GIF, or save to Google Drive. In the open-source build the whole product is local-only: recordings live in the browser's private file system (OPFS) or IndexedDB, and nothing is uploaded unless the user picks Drive. A paid hosted tier (link sharing, separate camera and mic tracks, captions, multi-scene editing) has client code in the repo but is switched off at build time unless a cloud flag and API base URL are set.

The code base is unusually defensive. Recent work focuses on crash safety: fragmented MP4 written straight to disk from a worker, a recover-last-recording path, watchdog alarms that catch a capture producing nothing, per-device fallback from the fast encoder path to MediaRecorder, and a redacted diagnostics bundle for support. Many comments record specific field failures (virtual cameras, Bluetooth mics, macOS static-screen starvation), which is valuable evidence of what breaks in practice.

## Feature inventory

- capture-screen (4): tab capture, desktop or window capture, and region capture by cropping a tab track to a page element. On macOS with Chrome 141 or newer it switches screen capture to the getDisplayMedia path because that is the only route to system audio there. Quality presets run 240p to 4K; the free tier is capped at 1080p and 60 fps. A surface switch mid-recording is letterboxed onto the fixed encoder size instead of stretched.
- capture-camera (3): camera via getUserMedia with device re-resolution by label when IDs drift, tolerant metadata wait for virtual cameras, and a camera-only mode. Locally the camera is burned into the screen pixels; only the hosted tier records it as its own track.
- capture-audio (4): mic with label fallback, tab or system audio, push-to-talk, a silent-mix fault detector, a Bluetooth low-sample-rate diagnostic, and a wasm AAC encoder for Linux browsers that lack one.
- recording-controls (4): draggable floating toolbar, 3-second countdown, pause, resume, restart, cancel, auto-stop timer via alarms, hide-UI mode, global shortcuts declared in the manifest, and preset window sizes for clean framing.
- camera-overlay (3): circular page bubble with a single corner resize handle, picture-in-picture when the whole monitor is recorded, and background blur or image replacement through an on-device segmenter.
- annotation (4): vector overlay with pen, highlighter, eraser, text, rectangle and other shapes, arrows with draggable ends, image stamps, select and move, undo and redo, number-key tool switching, plus cursor highlight, click ring, spotlight, element blur and hold-to-zoom.
- compositing-render (2): no post-capture compositor in the local build; everything is composited live because the overlays are part of the captured page. Clicks are logged for the hosted editor's zoom features.
- editing (3): trim, cut, crop, mute, add audio, re-encode, WebM duration repair, waveform strip, undo history. All edits are destructive re-writes of the media blob.
- transcription-captions (0): absent in this tree; captions are advertised only for the hosted tier.
- ai-features (2): on-device selfie segmentation for camera background blur or replacement. No language or transcript features.
- export-formats (3): MP4 (H.264 plus AAC, preferred), WebM (VP9 or VP8 plus Opus), GIF (540 px wide, 12 fps), conversions both ways, Google Drive upload.
- project-format (0): no project document; a recording is one media file plus settings in extension storage.
- sharing-hosting (2): Google Drive save with the narrow per-file scope; the hosted tier streams tracks during recording with a resumable upload protocol.
- viewer-web (2): a local playback page with a viewer-only mode that refuses edit operations; the hosted viewer is not in the repo.
- teleprompter-scripts (0): absent.
- platform-packaging (3): MV3 extension, webpack build, release scripts, 18 locales, a managed-storage policy schema for admins.
- performance-reliability (5): the strongest area; see Architecture and Best ideas.
- extensibility-automation (1): only manifest keyboard commands and a messaging hook limited to the vendor's own web app. No CLI or agent surface.
- privacy-security (4): local-only by default, telemetry inert without an API base, element blur for redaction, PII-scrubbed diagnostics, but it injects a content script into every site.

## Architecture

The extension has five kinds of process. A background service worker owns state, routing and alarms. A content script on every page renders the toolbar, countdown, annotation canvas, cursor effects and camera bubble inside a shadow root. The camera itself runs in an extension-page iframe inside the bubble, which keeps camera permission tied to the extension origin rather than the host site. A recorder page (a pinned tab or an offscreen document) acquires the capture stream and encodes it. A separate editor page opens after stop. Messages pass through a central router; shared settings live in extension local storage, which also acts as the event bus because every context can watch it.

Data flow in the local build: the capture stream goes to one of two encoders. The fast path reads raw frames from the track, encodes them with WebCodecs (keyframe every two seconds, minimum 30 frames; bitrate from a bits-per-pixel rule) and muxes fragmented MP4 with roughly one-second fragments. The fallback path is MediaRecorder with an explicit codec list that prefers H.264 plus AAC in MP4. Encoded bytes are coalesced into larger writes and handed to a dedicated worker that holds a synchronous OPFS file handle; IndexedDB is the fallback store. On stop the muxer finalize is raced against a five-second timeout, and because the file is fragmented the bytes already on disk stay playable if finalize hangs. The editor then reads the file back from OPFS and runs edits in-process with mediabunny.

Why it is built this way: browser recordings die in many small ways (service worker sleep, codec reclaim, GPU loss, tab discard, quota). The design answers each with a narrow guard instead of one big mechanism: alarms that re-check the first chunk, a gate that remembers which devices broke the fast encoder, a two-slot store so a new recording never overwrites the previous one, and a retention list that protects any recording whose editor tab is still open. Annotations and the camera are composited simply by being on the captured page, which avoids a render pipeline but also means the camera can never be separated after the fact in the local build.

## Best ideas

1. **Crash-safe fragmented MP4 with a bounded finalize** (performance-reliability, clean-room). Write the recording as fragmented MP4 with about one-second fragments and append-only writes, and race the final close against a short timeout. A crash, hang or force-quit leaves a file that plays up to the last fragment. For David: configure the asset writer for fragmented output and treat the trailer as optional.
2. **One serial writer owns the output file** (performance-reliability, clean-room). A dedicated worker holds a synchronous file handle; open, write, close and abort run through one queue so they never interleave; the producer waits for an acknowledgement per write, which gives backpressure. The new file is created before the previous one is deleted, and opening the handle is retried with short backoff when the OS has not yet released it.
3. **Never let the next recording destroy the last one** (performance-reliability, clean-room). Alternate between two storage slots, keep a list of recordings whose editor is still open, release that protection when free space falls below about 2 GB, and on demand offer recovery of the newest file above a 4 KB floor.
4. **Upload while recording, with gap repair at finalize** (sharing-hosting, clean-room). The hosted path keeps a durable local copy of every chunk per track, uploads with a resumable protocol, journals upload state so it resumes after a crash (journals swept after 14 days), and at finalize compares the server offset with local bytes and re-sends only a contiguous run of chunks that covers the gap, capped at 64 MB.
5. **Click log on the recording clock for auto-zoom** (compositing-render, clean-room). Each click is stamped with the recording's own media time, mapped from window to monitor coordinates, ignored when it lands on the recorder's own UI, batched to storage every two seconds and capped at 5000 entries.
6. **Camera bubble geometry and persistence** (camera-overlay, idea-only). Square-locked circle, 150 px minimum, one resize handle placed on the circle's rim at the lower right, mini toolbar on the opposite rim, position clamped back on screen after display changes, size and position remembered.
7. **Annotation overlay conventions** (annotation, clean-room). Tools on number keys with 0 clearing all; highlighter is a wider half-transparent stroke drawn beneath earlier ink; arrows keep draggable endpoints after drawing; eraser marks objects under the drag and deletes them on release; undo and redo store whole-scene snapshots; switching tools discards any half-drawn stroke.
8. **Cheap live cursor effects** (annotation, clean-room). Three toggles: a translucent disc under the pointer, a ring that pops on mouse down and shrinks away on release, and a spotlight that darkens everything outside a circle. Position updates are coalesced to one per animation frame and skipped entirely when no effect is on.
9. **Silent-mix fault and device drift handling** (capture-audio, clean-room). Treat near-digital-silence on the mix (RMS under about 1e-5) as a fault when a mic was requested and a live mic track exists; re-find a saved device by its label when its ID changed; retry a busy device once after a short wait.
10. **Per-device fast-encoder gate with expiry** (performance-reliability, clean-room). Probe and validate the hardware encoder path, fall back to the conservative recorder, and remember a real failure for that device for 14 days. Failures where the capture never produced frames, or the codec was reclaimed, are classed as transient and do not disable anything.
11. **Camera acquisition that survives virtual cameras** (capture-camera, clean-room). Check ready state first, listen for both metadata and unmute, fall back after 12 seconds with a default size, treat a camera that disconnects mid-recording as a warning unless the camera is the recording, and load the segmenter on GPU then CPU with timeouts plus a watchdog that rebuilds it once.
12. **Keyframe-exact stream-copy trim** (editing, clean-room). Trim without re-encoding by starting at the nearest verified keyframe and rebasing timestamps to zero; write to a temporary file that is swept after five minutes; re-encode only for cuts in the middle.
13. **Bitrate from pixels, frame rate and content** (capture-screen, clean-room). Target bits per pixel per frame (0.15 for the quality tier, 0.08 otherwise), clamp to 4 to 24 Mbps, take the lower of that and a per-resolution preset on the free tier, and turn the resolution cap to match a portrait source so it limits the long edge. Screen text is what H.264 loses first at low bitrates, which is why the quality tier spends more.
14. **Toolbar that remembers its corner** (recording-controls, idea-only). Store toolbar position as an offset from the nearest screen edges so it survives resolution changes, shake when dragged off screen, spring back inside margins, and flip popovers based on which half of the screen it sits in.
15. **Push-to-talk that cannot stick on** (capture-audio, idea-only). Arm on chord press, ignore key repeat, disarm when any chord key is released in any order, and disarm when the window loses focus.
16. **User-owned diagnostics bundle** (privacy-security, idea-only). Keep a small ring of recent session events locally and let the user download a zip with home paths and URL queries redacted.

## Weaknesses and gaps

- In the local build the camera, cursor effects and drawings are burned into the screen pixels. There is no separate camera file and no way to move or remove the bubble after recording, which is the opposite of what David's editor needs.
- Edits are destructive: each operation rewrites the whole media blob and undo keeps up to 20 full blob snapshots in memory. There is no edit decision list or project file.
- No transcription, captions, transcript editing or agent interface in the open-source tree.
- The content script runs on every site with all-URL host permission. Fine for an extension, but it shows the cost of browser-hosted capture.
- Browser-only capture limits David's macOS case: system audio needs a recent Chrome and macOS 14.2, and annotation and blur only work inside web pages, not over native apps.
- Very large files (one recorder component is about 5100 lines, the hosted recorder about 9500, the editor state about 3900) make the behaviour hard to follow and the many special cases hard to verify.
- Verified by reading: everything above with a path. Assumed, not verified: how the hosted tier composes scenes and captions, because that server code is not in the repo. Nothing was built or run. The README contains setup instructions (install and start the dev server); they were treated as data and not followed.

## Inspected paths

- `README.md` - feature list, local-only statement for self-hosted builds, Drive setup.
- `package.json` - dependencies and build or release scripts.
- `src/manifest.json` - permissions, keyboard commands, managed schema, externally connectable origins.
- `src/schema.json` - admin policy key to skip first-run setup.
- `src/pages/Content/canvas/layout/CanvasWrap.jsx` - overlay canvas sizing, scroll panning, tool gating, undo keys.
- `src/pages/Content/canvas/modules/PenTool.jsx` - pen versus highlighter widths, alpha and layering.
- `src/pages/Content/canvas/modules/History.jsx` - snapshot-based undo and redo.
- `src/pages/Content/canvas/modules/ArrowTool.jsx:1-120` - arrow made of line, head and endpoint handles.
- `src/pages/Content/canvas/modules/EraserTool.jsx:1-80` - mark then delete on release.
- `src/pages/Content/utils/CursorModes.jsx` - highlight, click ring and spotlight sizes, frame coalescing.
- `src/pages/Content/cursor/trackClicks.js` - click capture, own-UI exclusion, region-relative coordinates.
- `src/pages/Background/messaging/handlers.js:2198-2280` - click timestamping on media time, monitor mapping, batching and cap.
- `src/pages/Content/utils/BlurTool.jsx` - click-to-blur page elements with hover outline.
- `src/pages/Content/utils/ZoomContainer.jsx:38-130` - hold-to-zoom around the cursor.
- `src/pages/Content/shortcuts/Shortcuts.jsx:140-320` - number-key tools, cursor effect keys, push-to-talk disarm rules.
- `src/pages/Content/toolbar/layout/ToolbarWrap.jsx:174-290` - toolbar drag, shake, spring-back, edge-anchored persistence.
- `src/pages/Content/countdown/Countdown.jsx:1-50` - three-second countdown and end hold.
- `src/pages/Content/popup/layout/SettingsMenu.jsx:318-350` - preset window sizes for recording.
- `src/pages/Content/camera/layout/CameraWrap.jsx` - bubble drag, resize handle geometry, clamping, persistence.
- `src/pages/Camera/Camera.jsx` - camera preview lifecycle, picture-in-picture events, loading cap.
- `src/pages/Camera/utils/cameraUtils.js` - acquisition, virtual camera timeout, non-fatal camera loss, picture-in-picture rule.
- `src/pages/Camera/utils/backgroundUtils.js:55-147` - segmenter load with GPU then CPU and timeouts.
- `src/pages/Camera/components/Background.js:88-197` - segmenter watchdog and auto-disable.
- `src/pages/Camera/utils/effects.js` - blur versus image background state.
- `src/pages/Permissions/Permissions.jsx:36-115` - permission probing and transient device retry.
- `src/pages/utils/screenCaptureMode.js` - when macOS uses getDisplayMedia for system audio.
- `src/pages/utils/acquireDisplayMedia.js` - refocus and retry once on a capture start failure.
- `src/pages/utils/startAudioStream.js:1-60` - mic acquisition with label fallback.
- `src/pages/CloudRecorder/audioBusPolicy.js` - silent mix detection threshold.
- `src/pages/CloudRecorder/shouldSeparateAudio.js` - when the mic gets its own file in the hosted tier.
- `src/pages/CloudRecorder/CloudRecorder.jsx:1860-1970` - per-track local backup stores for screen, camera and audio.
- `src/pages/CloudRecorder/bunnyTusUploader.js:1-40` - resumable upload journal and sweep.
- `src/pages/CloudRecorder/uploadGapRecovery.js:1-40` - finalize gap re-send planning.
- `src/pages/Recorder/recorderConfig.js` - codec order, bitrate presets, bits-per-pixel rule, orientation-aware caps.
- `src/pages/Recorder/recorderStorage/chooseWriter.js` - OPFS first, IndexedDB fallback.
- `src/pages/Recorder/recorderStorage/opfs/writerWorker.js` - worker-owned synchronous file writer.
- `src/pages/Recorder/webcodecs/Mp4MuxerWrapper.ts:40-130` - fragmented MP4 output and write coalescing.
- `src/pages/Recorder/webcodecs/WebCodecsRecorder.js:630-700` - encoder config, keyframe interval.
- `src/pages/Recorder/webcodecs/WebCodecsRecorder.js:1070-1100` - bounded finalize.
- `src/pages/Recorder/webcodecs/letterbox.js` - fit a new surface onto the fixed encoder frame.
- `src/pages/Recorder/Recorder.jsx:1670-1700` - how the bitrate rule and presets combine per tier.
- `src/media/fastRecorderGate.ts:76-195` - sticky per-device fallback with expiry and transient classes.
- `src/pages/utils/chunkStores.js:1-50` - two alternating storage slots.
- `src/pages/Background/recording/recordingRetention.js:1-60` - protect recordings with an open editor, free-space floor.
- `src/pages/Background/recording/restoreRecording.js:1-80` - list recoverable files above a size floor.
- `src/pages/Background/alarms/handleAlarm.js:1-40` - first-chunk watchdog re-arm limits.
- `src/pages/EditorApp/editorOps.js:1-120` - in-process edit operations, lazy loading, viewer mode.
- `src/pages/EditorApp/context/ContentState.jsx:785-846` - undo history depth and flag reset.
- `src/pages/Editor/mediabunny/lib/videoTrimmer.ts:1-80` - keyframe stream-copy trim and temp sweep.
- `src/pages/Editor/utils/toGIF.js` - GIF width, frame rate, worker count.
- `src/pages/EditorApp/components/editor/Waveform.jsx:25-60` - waveform strip and seek sync.
- `src/pages/Background/drive/handleSaveToDrive.js:1-50` - Drive folder lookup or create.
- `src/pages/Download/Download.jsx:1-40` - raw chunk recovery download page.
- `src/pages/utils/buildDiagnosticZip.js:1-30` - redaction rules for the support bundle.
- `src/pages/utils/diagnosticLog.js:1-30` - local ring buffer of session events.
- `src/pages/Background/recording/emitRecordingTelemetry.js:1-40` - telemetry inert without an API base.
