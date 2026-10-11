# Local postproduction design

This implementation is original code based on the allowed build plan. No reference clone source was opened or copied.

The editor stores kept source intervals, each with an independent speed. It maps every output timestamp back to a clip and source timestamp; all tracks use that mapping. A serialized service writes drafts atomically, retaining a previous generation, and keeps undo and redo snapshots. Explicit save and discard are separate from draft autosave. Source files are read only.

The exporter decodes video sequentially within each kept interval. It holds the most recent decoded frame on the fixed output clock. A pure layout planner provides normalized screen and camera rectangles. Core Image resizes and composites them, including a circular or rounded camera mask. A composition shifts audio by the stored offset minus capture latency, cuts and scales it with the same clip mapping, and a reader mixes separate gains into PCM for AAC or WAV output. Staged files become visible only after successful completion; cancellation deletes staged files. Content hashes, draft data and options determine cache identity.

Zoom suggestions come from the plan's published constants, with no ported implementation. Cues refer to clip IDs and source times. A spring integrates the desired scale and centre on output ticks. Cursor movement can change the focus only after leaving the inner viewing box; nearby cues share that continuous spring state. Manual cues are preserved. No internal symbols or code from restricted projects are used.

Caption overlays use source-time cues, so cuts and playback speed follow the same edit mapping. Optional pointer drawing reads normalized coordinates from the captured append-only timeline. Pointer rendering is a seam for cursor-free masters; baked cursor recordings leave it off. Thumbnail generation decodes a frame from the exact cached composition export and letterboxes to the requested size.

Tests generate synthetic screen, camera and audio media with native writers, then decode exports and inspect dimensions, duration, audio energy, camera pixels and MP4 atom ordering. Synthetic tests cannot establish live capture permissions or capture-device synchronization, which the capture goal verifies separately.
