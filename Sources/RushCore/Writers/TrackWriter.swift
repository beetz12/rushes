import CoreMedia
import Dispatch
import Foundation

/// Errors thrown while opening or finalizing a writer. Appends never throw:
/// an unhealthy writer is reported through `TrackWriterStatus`.
public enum TrackWriterError: Error, Sendable, CustomStringConvertible {

    /// Neither the preferred codec nor its fallback could start.
    case writerFailedToStart(codec: String, reason: String?)

    /// A video track was configured without usable dimensions.
    case videoTrackMissingDimensions(width: Int?, height: Int?)

    /// An audio track kind with no audio settings (internal inconsistency).
    case audioTrackWithoutSettings(kind: TrackKind)

    public var description: String {
        switch self {
        case .writerFailedToStart(let codec, let reason):
            return "asset writer for \(codec) could not start"
                + (reason.map { ": \($0)" } ?? "")
        case .videoTrackMissingDimensions(let width, let height):
            return "video track needs positive dimensions (width \(width ?? 0), height \(height ?? 0))"
        case .audioTrackWithoutSettings(let kind):
            return "no audio settings for kind \(kind.rawValue)"
        }
    }
}

/// Writes one media track of a recording into its own fragmented QuickTime
/// file.
///
/// Constraints and contract:
///
/// - One `TrackWriter` owns one output file and one `AVAssetWriter` input,
///   driven from one serial queue. Every public method is thread-safe and
///   may be called from the capture callback.
/// - Media time zero is the epoch of the `SessionClock` passed at init. The
///   caller owns the clock: after a pause or resume, hand the writer the
///   updated clock with `adoptClock(_:)`.
/// - Sample presentation timestamps must be host-clock times (the capture
///   layer's clock, converted where needed). Samples before the epoch are
///   handled per the plan: the newest pre-gate video frame is cached and
///   written at media time zero; pre-gate audio is discarded and leading
///   silence covers the gap when the first accepted sample arrives.
/// - Samples inside a pause are dropped; later samples keep flowing media
///   times because the clock subtracts the pause.
/// - Audio is retimed onto the session clock with `AudioSampleTiming`, which
///   shifts every timing entry by one constant. Gaps over the configured
///   threshold are filled with silence on the media clock, and a muted track
///   writes silence instead of dropping samples, so audio files stay
///   continuous.
/// - Backpressure: accepted-but-unwritten video frames are capped at
///   `maxPendingVideoFrames`; the writer drops the oldest frame rather than
///   grow memory. Audio appends that meet a busy encoder are dropped and
///   healed by the next silence fill.
/// - `finalize(endMediaTimeNs:deadline:)` pads every track to a common end
///   (the last video frame is repeated at the end time, audio is padded with
///   silence), then finishes bounded by the deadline. A finish that cannot
///   complete in the bound is left alone: the fragmented file keeps every
///   fragment AVAssetWriter flushed, and the status reports `.degraded`.
public final class TrackWriter: @unchecked Sendable {

    /// The configuration this writer was opened with.
    public let configuration: TrackWriterConfiguration

    private let factory: any TrackFileWritingFactory
    private let queue: DispatchQueue

    // State below is confined to `queue`.
    private var backend: (any TrackFileWriting)?
    private var clock: SessionClock
    private var sessionBegun = false
    private var wroteAnySample = false
    private var cachedPreGatePixelBuffer: CVPixelBuffer?
    private var lastPixelBuffer: CVPixelBuffer?
    private var lastVideoMediaNs: Int64?
    private var lastAudioEndNs: Int64?
    private var donorAudioBuffer: CMSampleBuffer?
    private var isMuted = false
    private var microphoneObserver: @Sendable (CMSampleBuffer, CMTime) -> Void = { _, _ in }
    private var pendingVideo: [(pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64)] = []
    private var framesWritten: Int64 = 0
    private var silenceFramesWritten: Int64 = 0
    private var framesDropped: Int64 = 0
    private var framesSuppressedByPause: Int64 = 0
    private var silenceWatch = SilenceWatch()
    private var microphoneSilent = false
    private var firstMediaTimeNs: Int64?
    private var lastReportedMediaNs: Int64?
    private var usedFallbackCodec = false
    private var finalizeState = TrackWriterStatus.FinalizeState.idle
    private var failureText: String?
    private let finalizeSignal = DispatchSemaphore(value: 0)

    /// Opens the writer described by `configuration` on the session clock.
    ///
    /// The output file is created immediately. For a video kind, when the
    /// preferred codec cannot start the writer falls back to its `fallback`
    /// codec (HEVC to H.264) and reports it in every status; when there is no
    /// fallback left this throws.
    public convenience init(
        configuration: TrackWriterConfiguration,
        clock: SessionClock
    ) throws {
        try self.init(
            configuration: configuration, clock: clock, factory: AssetFileWriterFactory())
    }

    /// Designated init with an injectable backend factory (tests).
    internal init(
        configuration: TrackWriterConfiguration,
        clock: SessionClock,
        factory: any TrackFileWritingFactory
    ) throws {
        self.configuration = configuration
        self.clock = clock
        self.factory = factory
        self.queue = DispatchQueue(
            label: "rush.rushcore.trackwriter.\(configuration.kind.rawValue).\(UUID().uuidString)",
            qos: .userInitiated)

        let opened = try Self.openWriter(configuration: configuration, factory: factory)
        // Exclusive access during init: assigning queue-confined state here is
        // safe because self has not escaped yet.
        self.backend = opened.writer
        self.usedFallbackCodec = opened.usedFallback
    }

    /// Tries the preferred codec, then its fallback, returning a started
    /// writer. The fallback decision is the pure `VideoCodec.fallback` rule.
    private static func openWriter(
        configuration: TrackWriterConfiguration,
        factory: any TrackFileWritingFactory
    ) throws -> (writer: any TrackFileWriting, usedFallback: Bool) {
        let preferred: VideoCodec =
            configuration.kind.carriesVideo ? configuration.preferredVideoCodec : .hevc
        do {
            let writer = try factory.makeWriter(configuration: configuration, codec: preferred)
            guard writer.startWriting() else {
                throw TrackWriterError.writerFailedToStart(
                    codec: preferred.rawValue, reason: writer.failureDescription)
            }
            return (writer, false)
        } catch {
            guard configuration.kind.carriesVideo, let fallback = preferred.fallback else {
                throw error
            }
            // The failed attempt may have created the output file; remove it
            // so the fallback writer starts clean at the same URL.
            try? FileManager.default.removeItem(at: configuration.outputURL)
            let writer = try factory.makeWriter(configuration: configuration, codec: fallback)
            guard writer.startWriting() else {
                throw TrackWriterError.writerFailedToStart(
                    codec: fallback.rawValue, reason: writer.failureDescription)
            }
            return (writer, true)
        }
    }

    // MARK: - Clock

    /// Hands the writer the caller's current clock. Call after every pause or
    /// resume so media-time mapping stays current.
    public func adoptClock(_ clock: SessionClock) {
        queue.sync {
            self.clock = clock
            if let cached = cachedPreGatePixelBuffer, !wroteAnySample, let backend,
               clock.epochNs < Int64.max, backend.currentState == .writing {
                if !sessionBegun { backend.startSession(); sessionBegun = true }
                if backend.isReadyForMoreMediaData, backend.appendVideoFrame(cached, mediaTimeNs: 0) {
                    noteVideoAppended(pixelBuffer: cached, mediaTimeNs: 0)
                    cachedPreGatePixelBuffer = nil
                }
            }
        }
    }

    /// Optional bounded on-device speech tee. The observer must copy/submit quickly and never capture another device.
    public func setMicrophoneObserver(_ observer: @escaping @Sendable (CMSampleBuffer, CMTime) -> Void) {
        queue.sync { microphoneObserver = observer }
    }

    // MARK: - Appending video

    /// Appends one video sample buffer.
    ///
    /// The buffer's presentation timestamp must be a host time. Pre-gate
    /// frames (before the epoch) replace the cached frame; paused frames are
    /// dropped and counted; everything else is placed at its media time. The
    /// cached pre-gate frame is written at media time zero ahead of the first
    /// post-gate frame, so the file always starts with a picture at zero.
    public func appendVideo(_ sampleBuffer: CMSampleBuffer) {
        queue.sync {
            guard let backend = self.backend else { return }
            guard configuration.kind.carriesVideo else {
                self.framesDropped += 1
                self.failureText = failureText
                    ?? "appendVideo called on an audio writer (\(configuration.kind.rawValue))"
                return
            }
            guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
                self.framesDropped += 1
                self.failureText = failureText ?? "video sample carried no image buffer"
                return
            }
            guard let hostNs = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).nanosecondsI64 else {
                self.framesDropped += 1
                self.failureText = failureText ?? "video sample had no valid presentation time"
                return
            }

            if hostNs < clock.epochNs {
                // Newest pre-gate frame wins; it is written at media time
                // zero when the gate opens (docs/PLAN.md, Frame at zero).
                cachedPreGatePixelBuffer = pixelBuffer
                return
            }
            if clock.isPaused(atHostNs: hostNs) { framesSuppressedByPause += 1; return }
            enqueueVideo(
                pixelBuffer, mediaTimeNs: clock.mediaTimeNs(atHostNs: hostNs), backend: backend)
            drainPendingVideo(backend)
        }
    }

    private func enqueueVideo(
        _ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64, backend: any TrackFileWriting
    ) {
        pendingVideo.append((pixelBuffer, mediaTimeNs))
        while pendingVideo.count > configuration.maxPendingVideoFrames {
            // The append is already a synchronous hop, so the caller is
            // blocked either way: give the encoder a bounded moment to make
            // room before shedding a frame.
            waitForReadiness(backend, budgetNs: 50_000_000, stepNs: 2_000_000)
            drainPendingVideo(backend)
            guard pendingVideo.count > configuration.maxPendingVideoFrames else { break }
            // Still full: drop the oldest frame. A frame lost is preferable
            // to holding full-size surfaces in memory until the process dies.
            pendingVideo.removeFirst()
            framesDropped += 1
        }
    }

    /// Moves pending frames into the encoder while it accepts them.
    ///
    /// An append that reports "not now" (encoder busy) leaves the frame
    /// pending; it is retried on the next append, flush or finalize.
    private func drainPendingVideo(_ backend: any TrackFileWriting) {
        while let front = pendingVideo.first {
            guard backend.currentState == .writing else {
                noteBackendFailure(backend)
                return
            }
            guard backend.isReadyForMoreMediaData else { return }
            if !sessionBegun {
                backend.startSession()
                sessionBegun = true
            }
            // The cached pre-gate frame lands at zero ahead of the first
            // post-gate frame (skipped when that frame is itself at zero).
            if let cached = cachedPreGatePixelBuffer, front.mediaTimeNs > 0 {
                guard backend.appendVideoFrame(cached, mediaTimeNs: 0) else { return }
                noteVideoAppended(pixelBuffer: cached, mediaTimeNs: 0)
                cachedPreGatePixelBuffer = nil
            }
            // Presentation times must be strictly increasing.
            guard front.mediaTimeNs > (lastVideoMediaNs ?? Int64.min) else {
                pendingVideo.removeFirst()
                framesDropped += 1
                continue
            }
            guard backend.appendVideoFrame(
                front.pixelBuffer, mediaTimeNs: front.mediaTimeNs) else { return }
            noteVideoAppended(pixelBuffer: front.pixelBuffer, mediaTimeNs: front.mediaTimeNs)
            pendingVideo.removeFirst()
        }
    }

    private func noteVideoAppended(pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) {
        framesWritten += 1
        wroteAnySample = true
        if firstMediaTimeNs == nil { firstMediaTimeNs = mediaTimeNs }
        lastVideoMediaNs = mediaTimeNs
        lastReportedMediaNs = mediaTimeNs
        lastPixelBuffer = pixelBuffer
    }

    // MARK: - Appending audio

    /// Appends one audio sample buffer.
    ///
    /// The buffer's presentation timestamp must be a host time. Samples
    /// before the epoch are discarded (leading silence covers the start);
    /// samples inside a pause are dropped. The first accepted sample fixes
    /// the track's input format, and leading silence from media time zero is
    /// written ahead of it. Gaps on the media clock longer than the
    /// configured threshold are bridged with silence. A muted writer writes
    /// silence with the buffer's own timing, keeping the track continuous.
    public func appendAudio(_ sampleBuffer: CMSampleBuffer) {
        queue.sync {
            guard let backend = self.backend else { return }
            guard configuration.kind.carriesAudio else {
                self.framesDropped += 1
                self.failureText = failureText
                    ?? "appendAudio called on a video writer (\(configuration.kind.rawValue))"
                return
            }
            guard let hostNs = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).nanosecondsI64 else {
                self.framesDropped += 1
                self.failureText = failureText ?? "audio sample had no valid presentation time"
                return
            }
            guard hostNs >= clock.epochNs else { return }
            if clock.isPaused(atHostNs: hostNs) { framesSuppressedByPause += 1; return }

            let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
            guard frameCount > 0,
                  let format = CMSampleBufferGetFormatDescription(sampleBuffer),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format),
                  asbd.pointee.mSampleRate > 0 else {
                self.framesDropped += 1
                self.failureText = failureText ?? "audio sample had no readable format"
                return
            }
            var mediaNs = clock.mediaTimeNs(atHostNs: hostNs)
            let durationNs = Int64(
                (Double(frameCount) / Double(asbd.pointee.mSampleRate) * 1e9).rounded())
            if configuration.kind == .microphone {
                microphoneSilent = silenceWatch.receive(rms: AudioLevel.rms(sampleBuffer), mediaNs: mediaNs, muted: isMuted)
            }
            if donorAudioBuffer == nil {
                // The first accepted sample fixes the input format every
                // synthesized buffer must match.
                donorAudioBuffer = sampleBuffer
            }

            if let lastEnd = lastAudioEndNs {
                if mediaNs > lastEnd + configuration.audioGapThresholdNs {
                    writeSilence(fromMediaNs: lastEnd, toMediaNs: mediaNs)
                }
            } else if mediaNs > 0 {
                // Leading silence: the file starts at the epoch even when the
                // device's first sample arrives later (docs/PLAN.md, Audio at
                // zero).
                writeSilence(fromMediaNs: 0, toMediaNs: mediaNs)
            }
            // Host timestamps and frame durations round independently to
            // integer nanoseconds. Snap sub-sample overlaps to the previous
            // end instead of dropping every other real PCM buffer.
            if let lastEnd = lastAudioEndNs, mediaNs < lastEnd,
               lastEnd - mediaNs <= Int64(ceil(1e9 / asbd.pointee.mSampleRate)) {
                mediaNs = lastEnd
            }
            guard mediaNs >= (lastAudioEndNs ?? 0) else {
                self.framesDropped += 1
                return
            }
            if !sessionBegun {
                backend.startSession()
                sessionBegun = true
            }

            if isMuted {
                // Muting writes silence so the track stays continuous
                // (docs/PLAN.md, Mute).
                guard let donor = donorAudioBuffer,
                      let silence = AudioSilence.makeSilence(
                        mediaStartNs: mediaNs, frameCount: frameCount, donor: donor) else {
                    self.framesDropped += 1
                    self.failureText = failureText ?? "could not synthesize mute silence"
                    return
                }
                appendAudioSample(
                    silence, startNs: mediaNs, endNs: mediaNs + durationNs, synthesized: true)
            } else if let retimed = AudioSampleTiming.retime(
                sampleBuffer, to: CMTime(exactNanoseconds: mediaNs))
            {
                if configuration.kind == .microphone {
                    microphoneObserver(retimed, CMTime(exactNanoseconds: mediaNs))
                }
                appendAudioSample(
                    retimed, startNs: mediaNs, endNs: mediaNs + durationNs, synthesized: false)
            } else {
                self.framesDropped += 1
                self.failureText = failureText ?? "audio retiming failed"
            }
        }
    }

    private func appendAudioSample(
        _ buffer: CMSampleBuffer,
        startNs: Int64,
        endNs: Int64,
        synthesized: Bool
    ) {
        guard let backend else { return }
        if !backend.isReadyForMoreMediaData {
            // Real-time pacing keeps the audio encoder ready; a burst (tests,
            // a source catching up) waits briefly instead of dropping sound.
            waitForReadiness(backend, budgetNs: 100_000_000, stepNs: 2_000_000)
        }
        guard backend.isReadyForMoreMediaData, backend.appendAudioSamples(buffer) else {
            // The encoder stayed busy: drop the buffer; the next silence
            // fill heals the gap on the session clock.
            framesDropped += 1
            return
        }
        framesWritten += 1
        if synthesized { silenceFramesWritten += 1 }
        wroteAnySample = true
        if firstMediaTimeNs == nil { firstMediaTimeNs = startNs }
        lastAudioEndNs = endNs
        lastReportedMediaNs = endNs
    }

    /// Writes silence over a media-time span, in the donor's format.
    private func writeSilence(fromMediaNs startNs: Int64, toMediaNs endNs: Int64) {
        guard let backend, backend.currentState == .writing, endNs > startNs else { return }
        guard let donor = donorAudioBuffer else { return }
        let frameCount = AudioSilence.frameCount(
            fromMediaNs: startNs, toMediaNs: endNs, donor: donor)
        guard frameCount > 0,
              let silence = AudioSilence.makeSilence(
                mediaStartNs: startNs, frameCount: frameCount, donor: donor) else { return }
        if !sessionBegun {
            backend.startSession()
            sessionBegun = true
        }
        appendAudioSample(silence, startNs: startNs, endNs: endNs, synthesized: true)
    }

    // MARK: - Mute and silence heartbeat

    /// Mute or unmute an audio track. While muted, appended samples are
    /// replaced with silence of the same timing. No effect on video writers.
    public func setMuted(_ muted: Bool) {
        queue.sync {
            self.isMuted = muted
        }
    }

    /// Silence-fill and static-screen heartbeat, driven by the session layer's
    /// 100 ms timer (docs/PLAN.md, Silence fill).
    ///
    /// Fills silence from the last written audio up to 250 ms before
    /// `nowHostNs`, so a source that stops delivering (nothing playing on the
    /// system, a stalled device) never shortens the track. No-op before the
    /// first accepted sample (its arrival writes the leading silence) or while
    /// paused. Screen video repeats its last pixels at the declared cadence;
    /// continuous camera callbacks keep their actual capture timestamps.
    public func tick(nowHostNs: Int64) {
        if configuration.kind.carriesVideo {
            // Camera outputs already arrive continuously, including unchanged
            // pixels. Filling ahead to wall time can overtake delayed camera
            // capture timestamps; only SCK's idle screen needs a heartbeat.
            guard configuration.kind == .screen else { return }
            queue.sync {
                guard let backend, backend.currentState == .writing,
                      !clock.isPaused(atHostNs: nowHostNs), nowHostNs >= clock.epochNs,
                      let last = lastPixelBuffer else { return }
                let mediaNs = clock.mediaTimeNs(atHostNs: nowHostNs)
                let intervalNs: Int64 = 1_000_000_000 / 60
                let cursor = max(lastVideoMediaNs ?? 0, pendingVideo.last?.mediaTimeNs ?? 0)
                var nextNs = cursor + intervalNs
                var emitted = 0
                // Fill at the declared output cadence, not just the timer's
                // cadence. A sparse variable-rate master with 1/60s sample
                // durations has empty playable intervals between samples.
                // Work per tick remains bounded if the host was stalled.
                while nextNs <= mediaNs, emitted < 120 {
                    enqueueVideo(last, mediaTimeNs: nextNs, backend: backend)
                    drainPendingVideo(backend)
                    nextNs += intervalNs
                    emitted += 1
                }
            }
            return
        }
        guard configuration.kind.carriesAudio else { return }
        queue.sync {
            guard let backend, backend.currentState == .writing,
                  !clock.isPaused(atHostNs: nowHostNs) else { return }
            guard let lastEnd = lastAudioEndNs else { return }
            let fillThroughNs = clock.mediaTimeNs(atHostNs: nowHostNs)
                - configuration.audioGapThresholdNs
            if fillThroughNs > lastEnd {
                writeSilence(fromMediaNs: lastEnd, toMediaNs: fillThroughNs)
            }
        }
    }

    // MARK: - Health and status

    /// Drains pending video frames the encoder will currently accept. Cheap;
    /// safe to call at any time.
    public func flush() {
        queue.sync {
            if let backend { drainPendingVideo(backend) }
        }
    }

    /// A consistent snapshot of the writer's health and progress.
    public func status() -> TrackWriterStatus {
        queue.sync {
            TrackWriterStatus(
                kind: configuration.kind,
                framesWritten: framesWritten,
                silenceFramesWritten: silenceFramesWritten,
                framesDropped: framesDropped,
                firstMediaTimeNs: firstMediaTimeNs,
                lastMediaTimeNs: lastReportedMediaNs,
                pendingDepth: pendingVideo.count,
                usedFallbackCodec: usedFallbackCodec,
                finalizeState: finalizeState,
                errorDescription: failureText,
                framesSuppressedByPause: framesSuppressedByPause,
                microphoneSilent: microphoneSilent)
        }
    }

    private func noteBackendFailure(_ backend: any TrackFileWriting) {
        if backend.currentState == .failed {
            failureText = failureText
                ?? backend.failureDescription
                ?? "asset writer failed"
        }
    }

    // MARK: - Finalize

    /// Pads the track to a common end and finishes the file, bounded by
    /// `deadline`.
    ///
    /// Video repeats its last frame at `endMediaTimeNs` (the cached pre-gate
    /// frame is used when the gate never produced a post-epoch frame), audio
    /// is padded with silence to it; pass nil to skip tail padding. The
    /// finish is raced against the deadline (docs/PLAN.md, Finishing): a
    /// writer that cannot complete in the bound is left alone - the
    /// fragmented file keeps every fragment AVAssetWriter flushed and the
    /// status reports `.degraded`. A writer with no written samples produces
    /// no file and reports `.failed`. Finalize runs at most once; later calls
    /// return the current status.
    @discardableResult
    public func finalize(
        endMediaTimeNs: Int64? = nil,
        deadline: Duration = .seconds(5)
    ) async -> TrackWriterStatus {
        let timeoutNs = deadline.components.seconds * 1_000_000_000
            + deadline.components.attoseconds / 1_000_000_000
        var waitForFinish = false

        queue.sync {
            guard finalizeState == .idle else { return }
            guard let backend = self.backend else {
                finalizeState = .failed
                failureText = failureText ?? "writer was never opened"
                return
            }

            drainPendingVideo(backend)
            if !pendingVideo.isEmpty, backend.currentState == .writing {
                // Real-time encoders accept frames slightly behind wall-clock
                // pace, so a burst leaves frames pending here. Give the rest
                // a bounded chance (most of the finish deadline, keeping a
                // reserve for finishWriting itself) before counting them
                // dropped.
                let drainDeadline = DispatchTime.now()
                    + .nanoseconds(Int(max(timeoutNs - 500_000_000, 100_000_000)))
                while !pendingVideo.isEmpty, backend.currentState == .writing,
                      DispatchTime.now() < drainDeadline {
                    waitForReadiness(backend, budgetNs: 10_000_000, stepNs: 2_000_000)
                    drainPendingVideo(backend)
                }
            }
            if let endNs = endMediaTimeNs {
                padTail(toMediaNs: endNs, backend: backend)
            }
            // Frames still pending (the encoder stayed busy through the pad,
            // or capture raced finalize) cannot be appended after the input
            // is marked finished.
            framesDropped += Int64(pendingVideo.count)
            pendingVideo.removeAll()

            guard sessionBegun, wroteAnySample else {
                // QuickTime has no representation for an empty track: remove
                // the file and report failure (the session layer treats this
                // as a track that never started).
                backend.cancelWriting()
                try? FileManager.default.removeItem(at: configuration.outputURL)
                finalizeState = .failed
                failureText = failureText ?? "no samples were written"
                return
            }
            guard backend.currentState == .writing else {
                finalizeState = .failed
                failureText = failureText ?? backend.failureDescription ?? "asset writer failed"
                return
            }
            if let endNs = endMediaTimeNs { backend.endSession(atMediaNs: endNs) }
            backend.markInputFinished()
            finalizeState = .finalizing
            backend.finishWriting { [finalizeSignal] in
                finalizeSignal.signal()
            }
            waitForFinish = true
        }

        if waitForFinish {
            // Hop off the cooperative pool for the bounded blocking wait; the
            // engine's stop path runs one of these per track.
            let result: DispatchTimeoutResult = await withCheckedContinuation {
                continuation in
                DispatchQueue.global(qos: .userInitiated).async { [finalizeSignal] in
                    continuation.resume(
                        returning: finalizeSignal.wait(
                            timeout: .now() + .nanoseconds(Int(timeoutNs))))
                }
            }
            queue.sync {
                guard finalizeState == .finalizing else { return }
                switch result {
                case .success:
                    if backend?.currentState == .completed {
                        finalizeState = .finalized
                    } else {
                        finalizeState = .failed
                        failureText = failureText
                            ?? backend?.failureDescription
                            ?? "finishWriting did not complete cleanly"
                    }
                case .timedOut:
                    // Deadline hit. Leave the writer completely alone: the
                    // fragmented file on disk is playable up to its last
                    // complete fragment, and cancelling it now could destroy
                    // the trailer a late finish is still writing.
                    finalizeState = .degraded
                @unknown default:
                    break
                }
            }
        }
        return status()
    }

    /// Pads the track's tail to the common end media time.
    private func padTail(toMediaNs endNs: Int64, backend: any TrackFileWriting) {
        guard backend.currentState == .writing else { return }
        if configuration.kind.carriesVideo {
            if sessionBegun, let last = lastPixelBuffer, endNs > (lastVideoMediaNs ?? 0) {
                // After a burst the encoder may need a moment before it
                // accepts more; wait briefly so every track can still end at
                // the common time.
                waitForReadiness(backend, budgetNs: 200_000_000)
                // Repeat the last frame at the end time so every track ends
                // together (docs/PLAN.md, Common end).
                if backend.appendVideoFrame(last, mediaTimeNs: endNs) {
                    framesWritten += 1
                    lastVideoMediaNs = endNs
                    lastReportedMediaNs = endNs
                }
            } else if !wroteAnySample, let cached = cachedPreGatePixelBuffer {
                // The gate never produced a post-epoch frame; still leave one
                // picture at zero rather than an unusable file.
                backend.startSession()
                sessionBegun = true
                waitForReadiness(backend, budgetNs: 200_000_000)
                if backend.appendVideoFrame(cached, mediaTimeNs: 0) {
                    noteVideoAppended(pixelBuffer: cached, mediaTimeNs: 0)
                }
                cachedPreGatePixelBuffer = nil
            }
        } else {
            if let lastEnd = lastAudioEndNs, endNs > lastEnd {
                writeSilence(fromMediaNs: lastEnd, toMediaNs: endNs)
            }
        }
    }

    /// Polls input readiness for at most `budgetNs`. Used only on paths that
    /// may briefly outpace a real-time encoder (audio bursts, finalize).
    private func waitForReadiness(
        _ backend: any TrackFileWriting, budgetNs: Int64, stepNs: Int64 = 5_000_000
    ) {
        var waitedNs: Int64 = 0
        while !backend.isReadyForMoreMediaData, waitedNs < budgetNs {
            usleep(useconds_t(stepNs / 1_000))
            waitedNs += stepNs
        }
    }

    /// Cancels the writer and removes its output file (docs/PLAN.md, Start
    /// failure). No effect after finalize has started.
    public func cancel() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { [configuration] in
                if self.finalizeState == .idle {
                    self.backend?.cancelWriting()
                    try? FileManager.default.removeItem(at: configuration.outputURL)
                    self.finalizeState = .cancelled
                }
                continuation.resume()
            }
        }
    }
}
