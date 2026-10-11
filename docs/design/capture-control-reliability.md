# Capture control and reliability

Original implementation from the recording plan. No reference clone source read.

One camera session is owned by a reusable capture coordinator. Selecting a camera
starts this session for JPEG preview; recording attaches its writer to that same
session and detaches it at Stop. Recording appends happen first. JPEG compression
runs on a separate queue with a single in-flight frame. A slow control client can
hold at most one pending preview frame, replacing older frames. Preview writes
never block capture or recording control.

Device format mutations require exclusive device configuration ownership. Camera
loss detaches its writer and records a warning while screen and audio continue.
Audio mute replaces samples with silence through the existing writer, preserving
the timeline. Input telemetry adopts the same clock after every pause and resume,
and a one-second heartbeat persists pointer position even when no tap is allowed.

Recording preparation is reserved before any actor suspension, preventing two
simultaneous start requests. Countdown cancellation sets a generation token, stops
capture and removes only the empty newly-created package. Explicit discard removes
only the current take after writers have closed; restart uses its prior parameters.
Permission checks never prompt. Explicit permission requests invoke native APIs;
screen's asked flag is persisted to distinguish first launch from a prior refusal.
Area rectangles are clamped to the selected display and kept in global points;
stream configuration converts them to display-local points. Cursor-free mode sets
the stream cursor flag and records that choice in metadata. Bubble placement is
stored as normalized center and a point size so review/export can reproduce it.

Camera preview processing forwards one optional pixel transform to the existing
camera preview queue. The coordinator retains it for a future explicit warm,
applies it to a reused camera, and changes no device lifecycle itself. A transform
may suppress a frame; source privacy guards decide whether a queued JPEG is stale.
Microphone observers attach once to the microphone writer in both real and stub
rigs. The writer supplies media-time PCM after its gate, pause and mute rules;
consumers bound their own downstream work. Capture adds no extra worker or clock.
