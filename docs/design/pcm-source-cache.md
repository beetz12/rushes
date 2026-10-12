# PCM source cache

The original microphone and system-audio masters are decoded once, directly
through an AVAssetReaderTrackOutput for the original audio track. No audio mix
output or edited composition participates in this step. This is original code
using public Apple media APIs; no reference repository source is used.

Each recording package owns a `renders/pcm-sources` directory. A streaming hash
of the master and the conversion version identify a stereo 48 kHz Float32 CAF.
The CAF timeline begins at source-file time zero. Decoded presentation timestamps
place frames on that timeline: negative priming and declared decoder trim are
discarded, gaps contain zeroes, overlapping frames are discarded, and the file
ends at the asset duration. Recording offsets and measured latency are applied
later by the editing renderer, so changing an edit reuses the same source cache.

An 8,192-frame output buffer and 1 MiB hash chunks bound working storage apart
from AVFoundation's own decoder buffers. Cancellation interrupts the reader and
the worker removes its staged CAF before returning. Publication happens only
after decoding, closing, syncing and hashing the complete CAF, and confirming
that the master bytes still match the original hash. An atomic sidecar records
the source hash, output hash and frame count. A cache hit requires that sidecar,
an intact output hash, the expected format, and the expected length. Missing,
truncated, or altered cache files are regenerated. Managed directories and
cache files reject symbolic links before reads, publication and cleanup.

Generated-media tests cover actual AAC decode, absolute timestamps and gaps,
stereo conversion, duration, master preservation, cache reuse and invalidation,
corruption, concurrent preparation, cancellation, and path escapes. They use no
capture devices, permission prompts, GUI actions or external providers.
