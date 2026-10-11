# Video track time precision

Original correction to the existing AVFoundation backend. A real saved hour-long
take selected the default video timescale 600. Distinct incoming nanosecond PTS
less than 1/600s apart could therefore share stored presentation timestamps. Set
only video AVAssetWriterInput.mediaTimeScale before startWriting; audio keeps its
format-selected clock (Apple prohibits setting this property for audio).

The existing nanosecond domain 1e9 failed actual HEVC and H264 MOV finalization
for a sixty-second sparse gap (AVFoundation -11829 / OSStatus -12848 on readback).
Use microsecond scale 1e6 and require actual MOV encoding, full decoding,
sixty-second duration and recovery to preserve close frames. Saved synthetic pixel
fixtures
exercise both HEVC and H264 with sub-600Hz timestamp gaps; they open no camera,
microphone or screen capture device. The current actual hour-long recording is
preserved unchanged and its old timescale warnings remain part of QA evidence.

Primary contract: [AVAssetWriterInput.mediaTimeScale](https://developer.apple.com/documentation/avfoundation/avassetwriterinput/mediatimescale).
