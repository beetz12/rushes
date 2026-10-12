---
name: rushes
description: Record, review, edit, export and share local Rushes videos through its installed native CLI or paired loopback MCP service.
---

# Rushes

Read the installed command table first:

```sh
/Applications/Rushes.app/Contents/Resources/bin/rushes guide --json
```

Use that guide's current command names, parameters, structured errors and exit
codes. Open Rushes before commands that need its desktop sharing service. The
CLI starts its bundled native engine on demand for local commands.

Check `status` and `targets` before recording. Use the source and devices the
user requested. Camera and microphone stay off unless explicitly selected;
respect any paused device-testing request. Request macOS permissions through
Rushes and the normal system prompts. Never reset permissions or bypass them.

Read the real recording id from a successful start response. Stop that id and
check the finalized status and playable media. A processing link is available
before its video is ready; wait for readiness when the user asks for a finished
share. A successful request alone does not prove recording, upload or playback.

Editing and exports preserve original tracks. `editor-tracks` exports raw
originals with timing information; it does not apply cuts or composition.
Read the current draft before modifying it, and preserve unrelated edits.

Cloud credentials belong in the app's encrypted Settings store. Never put
owner tokens, API credentials or private footage into prompts, logs or Git.
Sharing a recording needs the user's authorization for that footage and
destination. Read share status, policy and feedback without changing access.

MCP starts disabled and permits reads until the user separately enables
mutations. Copy pairing configuration from Settings; retain its loopback URL
and bearer token privately. Do not enable mutations or share a pairing token
merely to resolve an error. Background jobs report real failures and can be
retried explicitly; Apple model downloads require explicit opt-in.
