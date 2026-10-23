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
