# Camera writer failures

Original implementation from our existing source and Apple's capture API contract;
no reference recorder source was opened.

The failed installed take on 2026-10-12 at 01:48 UTC reported a camera writer
error, zero usable camera samples and three dropped camera frames. Screen and
both audio tracks survived. Its complete status and successful verification were
incorrect: footage retention is independent of whether every requested track
completed successfully. An early fatal stop or failed requested writer therefore
marks the take failed while keeping other tracks and any partial failed file.
Camera disconnection remains a warning and may leave an empty camera track.

The camera output previously requested the device's native format with an empty
settings dictionary. Apple's installed SDK documents that behavior explicitly.
After attaching the input and output, select a supported eight-bit format: video
range NV12 first, full range NV12 next, then BGRA. Refuse unsupported output rather
than handing an unknown native format to the encoder. This removes a format
compatibility risk; it is not yet proof of the installed failure's cause.

Writer diagnostics include native error domain/code, a bounded underlying-error
chain and the first attempted frame's pixel format and dimensions. Arbitrary
error user-info values and pixels are excluded. Check actual 1080p encodes and
full decodes for each supported output type using generated constant frames.
Do not retry a failed encoder over a file with accepted samples: that could
replace recorded footage. Existing start-time HEVC fallback remains intact.

Regressions cover fatal early stop with healthy media, a camera writer failure
with healthy screen/audio, preserved partial bytes, normal four-track completion
and camera-loss continuation. The parent owns the installed physical retest and
package verification integration. Synthetic encodes cannot prove camera capture.
