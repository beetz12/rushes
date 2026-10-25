# Live screen buffers

The live screen rig requests BGRA buffers from ScreenCaptureKit. Recorded masters
retain their existing HEVC/H264 codecs, dimensions, timeline and separate audio
files. The generic stream-plan value still permits explicit NV12 callers.

The release qualification investigation observed lost visual cues in the native
NV12 path while an independently recorded, matched full-resolution BGRA reference
preserved six coded cues with30–38ms raw screen/system-audio differences. The
change is a compatibility candidate, not proof that every OS or device fails with
NV12. The actual packaged-app comparison, raw decoding, source selection, memory
endurance and normal source gates must pass before this candidate is installed.
No capture timestamp, fixture offset or100ms/250ms acceptance bound is changed.
