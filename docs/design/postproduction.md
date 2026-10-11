# Local postproduction design

This implementation is original code based on the allowed build plan. No reference clone source was opened or copied.

The editor stores kept source intervals, each with an independent speed. It maps every output timestamp back to a clip and source timestamp; all tracks use that mapping. A serialized service writes drafts atomically, retaining a previous generation, and keeps undo and redo snapshots. Explicit save and discard are separate from draft autosave. Source files are read only.

The exporter decodes video sequentially within each kept interval. It holds the most recent decoded frame on the fixed output clock. A pure layout planner provides normalized screen and camera rectangles. Core Image resizes and composites them, including a circular or rounded camera mask. A composition shifts audio by the stored offset minus capture latency, cuts and scales it with the same clip mapping, and a reader mixes separate gains into PCM for AAC or WAV output. Staged files become visible only after successful completion; cancellation deletes staged files. Content hashes, draft data and options determine cache identity.

Zoom suggestions come from the plan's published constants, with no ported implementation. Cues refer to clip IDs and source times. A spring integrates the desired scale and centre on output ticks. Cursor movement can change the focus only after leaving the inner viewing box; nearby cues share that continuous spring state. Manual cues are preserved. No internal symbols or code from restricted projects are used.

Caption overlays use source-time cues, so cuts and playback speed follow the same edit mapping. Optional pointer drawing reads normalized coordinates from the captured append-only timeline. Pointer rendering is a seam for cursor-free masters; baked cursor recordings leave it off. Thumbnail generation decodes a frame from the exact cached composition export and letterboxes to the requested size.

Tests generate synthetic screen, camera and audio media with native writers, then decode exports and inspect dimensions, duration, audio energy, camera pixels and MP4 atom ordering. Synthetic tests cannot establish live capture permissions or capture-device synchronization, which the capture goal verifies separately.

## Facade contract

`PostproductionService(root:)` is an actor. `handle(ControlRequest)` accepts `export`, `thumbnail`, `layout.frames`, `edit.get`, `edit.set`, `edit.split`, `edit.cut`, `edit.undo`, `edit.redo`, `edit.save`, and `edit.discard`. Every command requires `id`. Export and thumbnail accept `output` or `path`; export accepts share/full/youtube/audio/editor-tracks plus codec/container/fps/sourceSize options. An audio output ending in WAV selects WAV when no container was supplied. `edit.set` takes a full `edit` document or simple trim/layout/audio/title/bubble fields. `layout.frames` returns top-left normalized rectangles and accepts preview-only `layout` and `canvasAspect` overrides. Transcript cutting adapters pass `[EditCut]` to `applyCuts(id:cuts:)`; chapter text export belongs to Metadata, not this module.

The command facade blocks until the finished artifact exists. The typed `export` API accepts a frame-progress callback and observes task cancellation. Root integration owns asynchronous job scheduling and socket progress events. UI draft requests coalesce over 250 milliseconds; the newest request's completion confirms the atomic draft write. Save and discard invalidate pending autosaves using unique generation tokens.

The full preset reuses an existing compatible render for a container-only MP4/MOV remux via native passthrough. Clip entry uses a decoded preceding frame seed so an off-grid trim or a static capture does not produce a black first frame. A shorter camera master holds its last image in later clips.
