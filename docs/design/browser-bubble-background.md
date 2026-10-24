# Bounded bubble background

Mixed composition already copies the full screen into a cache and then copies that cache into every camera snapshot. The proposed path paints each arriving screen directly into the owned output surface. A small owned raster holds only the background under the most recently drawn bubble. This is a work-reduction hypothesis, not a proved CPU or timing cause.

Before an accepted camera update, restore its preceding background rectangle before resizing or replacing the patch. Capture the clean background under the new clipped bubble bounds, then perform the unchanged circular camera draw and output snapshot. A new full screen repaint invalidates the old patch. Integer cache bounds include an antialias fringe; actual fractional/clipped pixel comparison must validate it. The draw geometry itself is unchanged. Empty clipped patches are skipped.

Static screen still supports live camera. Neither input survives the existing synchronous consumption finally; output writing and closing retain their existing order. Screen-only and camera-only paths, timestamps, frame admission, layout and codec remain unchanged. Output snapshots must stay immutable when screen updates arrive during blocked writing.

Compare exact RGBA with the fixed old worker using real generated frames, including letterbox, transparency, fractional/clipped/moving/resized bubbles. Incorrect restore/capture/invalidation/resize variants must disagree in their targeted pixels. The genuine old full-frame strategy must still agree in pixels and fail only the separate operation-reduction predicate. No source/quality/deadline waiver is permitted.

A separate fixture marker records the already-received timing prefix once at its existing stopping state notification, using that state record's timestamp and current loss counters. It adds no clock read, worker command or lifecycle wait. It bounds received pre-Stop observations only and does not certify native readiness or undelivered/final work.
