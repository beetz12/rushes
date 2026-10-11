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
- Read reader brief, sources.json, both checks.
- Steps 1-7: all listed files read (see Inspected paths in the note).
- Confirmed the Cloudflare Worker code is NOT in the clone (separate repo
  fayazara/screendrop-worker); only the client upload code is here.

## Unverified (reading only, nothing run)
- Pause handling across tracks: screen writer derives pause length from
  sparse screen frames, camera from its own frames, pointer/keys from
  host uptime. Suspected drift after pause on a static screen.
- Recording hotkey during a recording appears to flip the bar back to
  picker mode (togglePicker logic); not run.
- Recovered sessions lose cursor (no input.json, pointerSynthesized nil)
  and camera offset (cameraLeadIn nil).

## First unfinished step
- Step 8: write the note and JSON, run checks, commit.
