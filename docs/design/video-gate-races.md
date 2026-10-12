# Video gate ordering

Original diagnosis from our recording source and installed failure metadata;
no reference recorder code was opened.

A screen writer can append its cached pre-gate picture at zero, then receive a
delayed callback whose capture timestamp is still before the epoch. The old frame
path repopulates the cache even after footage was accepted. Its next live frame
appends that cache at zero again, before the live-frame monotonic check. A second
route occurs when the encoder is busy at gate opening and the first real callback
has media timestamp zero: the real frame is accepted but the old cache remains.

Once any video frame has been accepted, a cached pre-gate frame can never be used
again. Discard delayed pre-gate callbacks after that point and count the loss;
clear the cache centrally on a successful append. Keep the initial cache rule so
the newest warm-up picture still starts the movie at zero if live video is late.

Replay both callback schedules against a strict timestamp observer and real
AVAssetWriter inputs. Require only one zero, increasing encoded presentation
times, unchanged first-frame behavior and complete native decoding. The installed
screen failure's -16364 is not publicly defined in the opened SDK headers; a
matching native replay signature supports the diagnosis, while the parent still
owns physical acceptance. Do not rewrite existing files or switch codecs to hide
failure. Separate files and clock semantics stay intact.

Primary timestamp contract: the installed VideoToolbox VTCompressionSession.h
requires each presentation timestamp to exceed the previous timestamp. Apple's
[VTCompressionSessionEncodeFrame](https://developer.apple.com/documentation/videotoolbox/vtcompressionsessionencodeframe(_:imagebuffer:presentationtimestamp:duration:frameproperties:sourceframerefcon:infoflagsout:))
documents the compression entry point used by native video encoding.
