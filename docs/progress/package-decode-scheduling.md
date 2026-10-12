# Package decode scheduling

The combined renderer-pressure regression sampled in `pcm-direct-writer-focused.sample.txt` showed twelve Swift cooperative worker threads blocked in `PackageVerifier.checkTrack` synchronous codec reads. A further six were in video reader initialization. The prior direct PCM renderer separately passed its pressure and normal export tests, so those isolated results did not prove the assembled parallel suite could progress.

CONSTRAINT: Swift's cooperative executor requires forward progress; an opaque synchronous codec read cannot occupy its worker indefinitely. Apple's [Swift concurrency: Behind the scenes](https://developer.apple.com/videos/play/wwdc2021/10254/) documents this runtime contract. Blocking reads belong on an independent Dispatch queue bridged with continuations, rather than in a task's synchronous read loop.

PackageVerifier now uses the existing bounded per-reader queue for `startReading` and each actual decode read. Cancellation calls `cancelReading` independently; stalled reads fail, and no cancelled or incomplete decode can pass. Every declared stream is still decoded to completion; duration, path, offset, positive-media, finalized-state and sample-count checks are unchanged. There is no global export lock or reduced test parallelism.

The first targeted command used a filter that matched no tests, so its exit 0 is build evidence only. The corrected `swift test --filter 'ProjectTests|VideoTimescaleTests'` passed 23 tests across two suites, including real generated video/audio, camera-loss duration, invalid packages and timestamp precision. Root's full `scripts/check.sh` gate remains the integration requirement.
