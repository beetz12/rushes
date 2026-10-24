# Native-call invocation wall boundaries

This is trace-only observation, not a recording or Stop repair. Existing streamed before/after records include our own mark and before-console work around the native method. Their total wall interval is useful but cannot be called exclusive native time.

After the existing before mark/console record, read a process-local performance clock immediately before Reflect.apply and again immediately when it returns or throws. Retain those bounds on the same existing after record, leaving the original before/after fields, message count, call order, errors and media behavior intact. A thrown native value must remain the thrown value even if its diagnostic string cannot be obtained.

Unavailable or invalid new clock reads produce unknown bounds, never zero, a fitted value or a replacement media clock. The invocation interval is wall time, not CPU time, and does not exclude scheduling or native callbacks. Existing tracing overhead can still affect the run. No new message, await, flag, reader, source, offset, codec or guard change is introduced.

A pure fake clock drives the actual installed wrapper: before-console work takes300ms and the native method200ms, so the old total remains500ms while the invocation is200ms. The same test on the old wrapper must fail for missing boundaries. Cover original return/throw identity, unavailable bounds and strict before/after row parsing. Actual ordinary-profile cause and cleanup still require separate provider/native evidence.
