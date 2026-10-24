# Window audio mixer experiment

The two-input audio coordinator already owns its input processors, copied PCM and
output generator in the Window. A generated Windows observation on the preceding
shared source measured a long gap between two actual input-handler entries in the
dedicated mixer Worker while the Window continued sending input. This identifies
a delayed dispatch boundary; it does not identify an operating-system scheduler,
encoder, CPU or GPU cause. This change is a paired experiment until the same
Windows recording and retirement checks pass.

Run the existing timestamp mixer on an owned MessageChannel in that same Window.
Extract the existing mixer loop into a function taking its message endpoint; keep
the old dedicated endpoint as a generated-test reference. Both message ports use
real asynchronous dispatch and transferred PCM buffers. A consumed receipt follows
the actual ring push, written follows the actual generator write, ready follows
that first write receipt, and stopped follows the actual mixer stop handler.
There are no synthetic local credits, fallback modes or new source clocks.

Keep the single-input clone path, sinc conversion, supplied sample references,
five-millisecond correction model, quarter-second capacities and capacity wait,
one pending output write, write/readiness bounds, input ownership and native
recording/finalization checks. Pause still belongs to the native encoders. Graceful
quiescence retires new input but keeps the output track alive while awaiting the
real stopped port message; it does not wait for an encoder-dependent output write.

Closing ports does not terminate a Worker. A separate forced disposer must mark
the core stopped, wake pull/write waits, detach handlers and release the mixer
reference without reporting a successful stop receipt. The coordinator's existing
close path rejects unsettled start/stop promises and closes only its owned tracks.
Route message-deserialization failures through the existing fatal path. Late
callbacks cannot restart the core or replace a frozen failure.

Retain every existing capacity, partial/late/invalid receipt, missing Stop receipt,
pre/post-Stop discontinuity, borrowed-frame, source lifetime and real PCM test.
Controlled ports replace controlled Worker delivery in transport tests; assertions
and error injection remain. Add actual-port protocol/transfer/disposal controls,
and an end-to-end recording control where the old dedicated audio endpoint is
unavailable. Keep that old endpoint as the negative comparison before changing the
coordinator. No relaxed timing predicates, missing-data waiver, invented native
acknowledgements or larger deadline/buffer is allowed.

The Window now pays the mixing cost. Timer fairness, sample-rate conversion,
kernel-cache lifetime and source/recorder load must therefore be measured under
the existing short/reference/maximum gates and public Mac/Windows checks. A local
or generated positive alone does not qualify Windows, physical devices, background
recording, paid hosting or deployment. The separate Mac phase-classifier and
hosted source-cadence failures remain open.

Implementation uses only the existing original mixer and browser message ports.
No external recorder implementation, new dependency or proprietary asset is used.
