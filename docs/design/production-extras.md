# Original native production extras

This implementation uses the approved PLAN and Apple's official Speech, AVFoundation, Vision and Core Image APIs. No reference clone source is opened or copied. Input comes from the recording's existing captured buffers. Tests use synthesized speech PCM and a saved webcam still; no device capture or alternate microphone session is created.

## Voice following

The engine starts one on-device SpeechTranscriber configured for progressive results. Required Apple assets are checked first and missing assets produce structured instructions; any OS asset installation requires the existing explicit caller option. Audio stays local. The module accepts captured PCM or CMSampleBuffer data with recording media time already applied. It copies bounded buffers before returning to capture, converts PCM to the analyzer's format on its own serial queue and yields to a bounded AsyncStream. There are limits on buffer duration, pending conversion work and queued speech inputs. Overflow drops recognition work, never the recording's audio, and is reported in progress.

The result consumer tracks each progressive audio range and only passes newly recognized token suffixes to the existing eight-word forward-only matcher. Repeated volatile results cannot advance through repeated script words a second time. Progress includes script token position, character offset, source-time range, recognized text, lifecycle state and drop counts. The engine publishes this progress to its excluded overlay. Finish drains accepted buffers and finalizes speech; cancel stops accepting input, terminates queued work and cancels the analyzer. Neither path owns microphone permissions or the recording lifecycle. Errors explain asset, format, availability or OS permission failures rather than inventing text.

## Person-aware background blur

A Vision person segmentation request produces an 8-bit foreground matte. Core Image scales that matte to the exact input extent, blurs a clamped background, and blends the original foreground over it. Output keeps the input width, height and presentation timestamp. A missing-person matte uses a complete blurred background and reports personDetected=false; failures return the original image with an explicit warning. The full source pixel buffer remains unchanged.

Processing is bounded by one in-flight request and a bounded reusable output pool. The service offers a worker-backed submit callback for capture integration and an explicit synchronous process function for saved fixtures. A busy submission immediately declines optional processing; the engine chooses the raw-frame fallback or accounts for a skipped effect frame. Root owns frame ordering, preview/record routing and live device verification. Record callbacks must not synchronously call the saved-fixture function. Segmentation and rendering run locally with no model provider or network.

## Progress checkpoint

Done: PLAN, clean-room rules, existing transcription contract and actual SDK declarations read; official API docs queried; callback contract shared with root.
Unverified: implementation and actual Apple streaming recognition/Vision fixture behavior.
First unfinished step: implement bounded live recognition and frame blur services.
