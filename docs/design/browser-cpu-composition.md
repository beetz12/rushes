# Browser composition surfaces

The compositor requests software 2D surfaces for its output and cached screen image. The output is converted to a video frame for VP8 encoding on every accepted source frame. Keeping that surface in software tests the GPU conversion boundary without changing source timestamps, frame cadence, layout or ownership.

In public qualification at a43b2f5, one native VP8 recorder starts and decodes on both Windows Chrome versions. The larger product graph still fails video startup. This does not identify the compositor as its cause. The surface change must pass the existing pixel, ownership, native-start, saved-byte, decoded-sync and retirement checks before it earns a repair claim.

Mac generated-reference acceptance explicitly selects the Default128 audio sink. The same-host None128/Default128 comparison preserved both failures: Default corrected actual PCM pacing, while source/video gaps remained. None controls remain available and their failures are retained. Windows keeps its qualified None128 source. These are generated-source settings; physical microphone capture is unchanged.

No startup, finalization, source, clock, PCM,100ms sync or250ms gap limit is relaxed. Real-device, background and production acceptance remain separate.
