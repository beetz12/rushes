# Local composition observations

Fresh video can reach a recording while its composed output becomes sparse. We need a small record of the existing worker operations before changing the pipeline. The record describes elapsed wall intervals on that worker and cannot establish CPU usage, a native encoder acknowledgement, or an absolute transfer delay.

Keep every current read, draw, frame timestamp, admission decision, output write, close and control branch in its current order. Surround the existing synchronous raster/snapshot/frame-construction calls and the existing read/write awaits with local clock reads. Separate the two input roles. Aggregate counts, sums and maxima in a fixed table; never retain frames or pixels. Output only on messages already emitted by the worker. A generated-test listener retains at most32 such snapshots and records missing, malformed or dropped observations honestly.

Observe the existing controls to distinguish preroll, start-control, paused and ending work. An interval crossing those controls belongs to a mixed group. Start-control does not mean all native encoders are ready. It never changes media time, shutdown ownership or an existing bound. A pending interval with no later message is unknown.

Injected-clock tests execute the actual worker code with controlled input, draw and writer objects. Separate slow draw, slow read and slow write completion; verify timestamps, cadence, call counts and exactly-once closing. Preserve failures for a worker lacking observations and for an incorrectly measured writer interval. No live device, browser or decoder is needed for these controls.

A local control sequence accompanies each pending interval. Returning from pause to the same label cannot hide that boundary. The fixture accepts only its credential-free same-origin worker identity and catches serialization refusals. Its bounded collection validates envelopes only; a later reader must check all numeric table fields before interpreting complete observations.
