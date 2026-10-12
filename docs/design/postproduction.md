# Local postproduction design

This implementation is original code based on the allowed build plan. No reference clone source was opened or copied.

The editor stores kept source intervals, each with an independent speed. It maps every output timestamp back to a clip and source timestamp; all tracks use that mapping. A serialized service writes drafts atomically, retaining a previous generation, and keeps undo and redo snapshots. Explicit save and discard are separate from draft autosave. Source files are read only.

The exporter decodes video sequentially within each kept interval. It holds the most recent decoded frame on the fixed output clock. A pure layout planner provides normalized screen and camera rectangles. Core Image resizes and composites them, including a circular or rounded camera mask. Audio uses cached decoded PCM, shifted by the stored offset minus capture latency and cut with the same clip mapping. A bounded mixer applies each source gain and sums both channels into a temporary CAF before the final AAC or WAV writer starts. Staged files become visible only after successful completion; cancellation deletes staged files. Content hashes, draft data and options determine cache identity.

Zoom suggestions come from the plan's published constants, with no ported implementation. Cues refer to clip IDs and source times. A spring integrates the desired scale and centre on output ticks. Cursor movement can change the focus only after leaving the inner viewing box; nearby cues share that continuous spring state. Manual cues are preserved. No internal symbols or code from restricted projects are used.

Caption overlays use source-time cues, so cuts and playback speed follow the same edit mapping. Optional pointer drawing reads normalized coordinates from the captured append-only timeline. Pointer rendering is a seam for cursor-free masters; baked cursor recordings leave it off. Thumbnail generation decodes a frame from the exact cached composition export and letterboxes to the requested size.

Tests generate synthetic screen, camera and audio media with native writers, then decode exports and inspect dimensions, duration, audio energy, camera pixels and MP4 atom ordering. Synthetic tests cannot establish live capture permissions or capture-device synchronization, which the capture goal verifies separately.

## Facade contract

`PostproductionService(root:)` is an actor. `handle(ControlRequest)` accepts `export`, `thumbnail`, `layout.frames`, `edit.get`, `edit.set`, `edit.split`, `edit.cut`, `edit.undo`, `edit.redo`, `edit.save`, and `edit.discard`. Every command requires `id`. Export and thumbnail accept `output` or `path`; export accepts share/full/youtube/audio/editor-tracks plus codec/container/fps/sourceSize options. An audio output ending in WAV selects WAV when no container was supplied. `edit.set` takes a full `edit` document or simple trim/layout/audio/title/bubble fields. `layout.frames` returns top-left normalized rectangles and accepts preview-only `layout` and `canvasAspect` overrides. Transcript cutting adapters pass `[EditCut]` to `applyCuts(id:cuts:)`; chapter text export belongs to Metadata, not this module.

The command facade blocks until the finished artifact exists. The typed `export` API accepts a frame-progress callback and observes task cancellation. Root integration owns asynchronous job scheduling and socket progress events. UI draft requests coalesce over 250 milliseconds; the newest request's completion confirms the atomic draft write. Save and discard invalidate pending autosaves using unique generation tokens.

The full preset reuses an existing compatible render for a container-only MP4/MOV remux via native passthrough. Clip entry uses a decoded preceding frame seed so an off-grid trim or a static capture does not produce a black first frame. A shorter camera master holds its last image in later clips.

## Retry verification fixes

The independent checker proved that hidden-cursor zoom still consumes pointer samples for panning. Video cache identity now includes optional input-file presence and content independently of cursor visibility. Missing, newly created and mutated timelines each have distinct identities. Audio-only and raw editor-track exports do not consume that timeline.

Managed render directories must resolve to their exact canonical location inside the recording package. The same rule covers cache videos, stamps, unique staging files, remux siblings and thumbnail intermediates; linked directories or linked cache entries are rejected before reads or writes. Finalization and cleanup revalidate the managed directory. Cleanup targets only a validated unique staging prefix.

The added full-take media regressions also exposed a writer readiness deadlock with mixed audio. Audio now has a separate owner task that pumps its reader/output/input and signals completion independently of the fixed-clock video input. Finalize joins that task; failure or cancellation cancels and joins it before removing staging files. The 30-second readiness bound remains unchanged.

Regression oracles decode spatially distinct synthetic pixels, require cache-key changes when input changes, and compare unchanged-cache and forced-fresh controls. Separate H264 encodes can have small edge quantization differences: the fresh control requires exact center color plus a whole-frame average under one 8-bit intensity step. The checker's original independent tests were run unchanged.

## PCM audio repair

Compressed source tracks are decoded independently by the PCM source cache. The editor reads contiguous source ranges from those immutable CAF files, so a reordered clip never seeks a compressed composition backwards. Each clip writes bounded 4096-frame stereo Float32 blocks; absent source intervals and muted tracks contribute silence. Gains are summed before clipping the final sample to the PCM range. The renderer rounds cumulative clip duration at 48 kHz, keeping the output frame count equal to the edited timeline even when individual clip boundaries fall between samples.

For speeds above 1x, a per-source clip stream feeds an offline AVAudioEngine through AVAudioUnitTimePitch at the requested rate and zero pitch shift. Offline mode is enabled before accessing mixer or device nodes. The stream removes the unit's reported processing latency before adding output to the clip timeline and preserves partial rendered blocks before requesting their remainder. The final audio task reads the mixed CAF through AVAudioFile, copies bounded PCM buffers into owned CMSampleBuffers, and stamps each block with its exact position on the 48 kHz timeline. Audio and video retain independent writer ownership, bounded readiness waits and cancellation checks. Temporary mixed CAF files are removed on success and failure; the masters are never modified. Native render cache version 3 prevents an older compressed-composition result from hiding this path.
