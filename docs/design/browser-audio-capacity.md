# Audio input receipt capacity

The coordinator counts input samples posted to its mixer until the Window
dispatches the mixer's acceptance receipts. Buffered stream reads can continue
as microtasks before those receipt tasks run. A full transport window therefore
needs backpressure before the next packet, rather than an immediate overflow.

Keep at most a quarter second of unacknowledged samples per input. Hold one
already-read packet outside that window and await an existing acceptance receipt
before copying or posting it. One absolute 250 ms wait budget covers every wake
for that held packet; check the clock after a wake as well as in the timer.
Quiescence wakes waiting readers so they close their held packets without
posting more input. Missing, malformed or late receipts remain failures.

The receipt acknowledges admission to the mixer's ring, not playback. Its own
ring bound, timestamp checks, output delivery deadline and error propagation
remain authoritative. Do not change sample rates, reference timestamps, packet
contents, the clock model, reader count, source qualification or media limits.
Use a controlled transport test for the task/microtask boundary, then the real
audio, capture and fresh duration tests for actual media acceptance.

A fatal parent failure rejects startup with its original error, then closes
its owned audio resources before notifying the capture controller. That
controller may synchronously enter native recorder Stop; its callback must
not hold the audio cleanup that Stop can depend on. Notify in a finally block
so a cleanup exception cannot suppress the original failure message. Input
tracks owned by the caller stay live. Waking another held input still closes
its AudioData in a later microtask; do not claim synchronous frame retirement
or a bounded native Stop solely from this notification order.

For a fatal parent failure, retain one immutable scalar snapshot before close:
capacity edge and held packet, pending/posted/consumed counts, received worker
message count and age, output packet/write/receipt counts and current flags.
Ages are same-Window durations rounded upward to milliseconds, not native
clock offsets. Supply this optional typed detail on the existing warning
callback. One-argument UI consumers keep the same message. Preserve worker
error diagnostics and never include PCM planes or raw message payloads.

Only the explicit generated startup diagnostic serializes that fixed shape.
Its strict parser keeps the existing 512-character warning and 4096-character
raw limits. A passive listener positively identifies the owned audio-worker
URL and retains at most one late consumed, error and stopped scalar row after
the first detailed warning, with duplicate/rejection counters. No worker
message, reader, probe, timer, evaluation, waveform or clock model is added.
Parent-only progress cannot distinguish a silent worker from undelivered
messages; missing late rows remain unmeasured. Worker code stays unchanged.
