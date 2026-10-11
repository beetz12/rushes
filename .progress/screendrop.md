# Progress: screendrop (reader goal 1)

## Plan
1. Read AGENTS.md, README, .agents skills, docs/ in the clone.
2. Capture path: ScreenRecordingManager, CameraRecordingManager, RecordingSession, CaptureCoordinator, RecordingRecoveryCoordinator, RecordingInputAuthorization.
3. Project format and storage: RecordingProject, RecordingProjectStore, export folder layout.
4. Editing and studio: RecordingStudioModel, RecordingStudioExporter, timelines, zoom, cursor, camera bubble.
5. Transcription: RecordingTranscription, RecordingTranscriptEditing; teleprompter.
6. Sharing: CloudUploader, CloudSidecarUploader, CloudCredentialStore, SettingsCloudPane.
7. Automation: ScreendropAppIntents, hotkeys; privacy: entitlements, Info.plist, redaction.
8. Write docs/research/screendrop.md and .json; run both checks; commit.

## Done
- Steps 1-8 complete.
- Cloudflare Worker and share viewer confirmed absent from the clone
  (separate repo fayazara/screendrop-worker); client upload code documented.
- check_research.py screendrop: "OK 1 notes, 15 ideas".
- check_clean.py on both files: first line 0.
- Own-words self-check (10-word runs vs the Screendrop clone itself): 0
  after rephrasing one sentence.

## Unverified (reading only, nothing run)
- Pause handling across tracks: screen writer derives pause length from
  sparse screen frames, camera from its own frames, pointer/keys from
  host uptime. Suspected drift after pause on a static screen.
- Recording hotkey during a recording appears to flip the bar back to
  picker mode (togglePicker logic); not run.
- Recovered sessions lose cursor (no input.json, pointerSynthesized nil)
  and camera offset (cameraLeadIn nil).

## First unfinished step
- None. Goal complete; branch not merged, no PR (per contract).
