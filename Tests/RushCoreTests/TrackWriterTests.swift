import AVFoundation
import CoreMedia
import Foundation
import Testing

@testable import RushCore

@Suite("TrackWriter")
struct TrackWriterTests {

    // A host-time epoch far from zero, the way real capture timestamps look.
    private let epochNs: Int64 = 1_000_000_000_000

    // MARK: - Synthetic media

    private func tempDir() -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("trackwriter-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// One NV12 video frame at a host time, 320x240, 30 fps timing.
    private func makeVideoBuffer(hostNs: Int64, width: Int = 320, height: Int = 240) -> CMSampleBuffer {
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixelBuffer)
        guard let buffer = pixelBuffer else {
            Issue.record("CVPixelBufferCreate failed")
            fatalError("CVPixelBufferCreate failed")
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        for plane in 0..<CVPixelBufferGetPlaneCount(buffer) {
            if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) {
                memset(
                    base, 128,
                    CVPixelBufferGetHeightOfPlane(buffer, plane)
                        * CVPixelBufferGetBytesPerRowOfPlane(buffer, plane))
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])

        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format)
        guard let format else {
            Issue.record("format description creation failed")
            fatalError("format description creation failed")
        }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil,
            formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        guard let sample else {
            Issue.record("CMSampleBufferCreateForImageBuffer failed")
            fatalError("CMSampleBufferCreateForImageBuffer failed")
        }
        return sample
    }

    /// One buffer of `frames` mono Float32 PCM samples at 48 kHz, carrying a
    /// 440 Hz sine of `amplitude`, stamped at a host time.
    private func makeAudioBuffer(
        hostNs: Int64, frames: Int = 1024, amplitude: Float = 0.5
    ) -> CMSampleBuffer {
        let rate: Double = 48_000
        let asbd = AudioStreamBasicDescription(
            mSampleRate: rate,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0)
        var format: CMAudioFormatDescription?
        let formatStatus = withUnsafePointer(to: asbd) { asbdPtr in
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: asbdPtr, layoutSize: 0, layout: nil,
                magicCookieSize: 0, magicCookie: nil, extensions: nil,
                formatDescriptionOut: &format)
        }
        guard formatStatus == noErr, let format else {
            Issue.record("audio format description creation failed")
            fatalError("audio format description creation failed")
        }

        let totalBytes = frames * 4
        let memory = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
        let floats = memory.assumingMemoryBound(to: Float.self)
        for i in 0..<frames {
            let t = Float(i) / 48_000
            floats[i] = amplitude * sin(2 * Float.pi * 440 * t)
        }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: memory, blockLength: totalBytes,
            blockAllocator: kCFAllocatorMalloc, customBlockSource: nil, offsetToData: 0,
            dataLength: totalBytes, flags: 0, blockBufferOut: &block)
        guard let block else {
            Issue.record("CMBlockBufferCreateWithMemoryBlock failed")
            fatalError("CMBlockBufferCreateWithMemoryBlock failed")
        }

        // One timing entry with a single-sample duration: CoreMedia applies
        // a single entry to every sample in the buffer.
        var timing = [CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)]
        var sample: CMSampleBuffer?
        CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
            sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
        guard let sample else {
            Issue.record("CMSampleBufferCreate failed")
            fatalError("CMSampleBufferCreate failed")
        }
        return sample
    }

    private struct AssetSummary {
        var durationSeconds: Double
        var videoTracks: Int
        var audioTracks: Int
    }

    private func inspect(url: URL) async throws -> AssetSummary {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let video = try await asset.loadTracks(withMediaType: .video)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        return AssetSummary(
            durationSeconds: duration.seconds, videoTracks: video.count, audioTracks: audio.count)
    }

    // MARK: - Stub backend

    private final class StubFileWriter: TrackFileWriting, @unchecked Sendable {
        let outputURL: URL
        var state: FileWritingState = .writing
        var ready = true
        var beginResult = true
        var hungFinish = false
        var failure: String?
        var videoAppends: [Int64] = []
        var audioAppends = 0
        var markedFinished = false

        init(outputURL: URL) { self.outputURL = outputURL }

        var currentState: FileWritingState { state }
        var failureDescription: String? { failure }
        var isReadyForMoreMediaData: Bool { ready }

        @discardableResult
        func startWriting() -> Bool { beginResult }

        func startSession() {}

        @discardableResult
        func appendVideoFrame(_ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool {
            videoAppends.append(mediaTimeNs)
            return true
        }

        @discardableResult
        func appendAudioSamples(_ sampleBuffer: CMSampleBuffer) -> Bool {
            audioAppends += 1
            return true
        }

        func markInputFinished() { markedFinished = true }

        func finishWriting(completion: @escaping @Sendable () -> Void) {
            guard !hungFinish else { return }  // a wedged encoder never completes
            state = .completed
            completion()
        }

        func cancelWriting() { state = .failed }
    }

    private final class StubFactory: TrackFileWritingFactory, @unchecked Sendable {
        let stub: StubFileWriter
        var refuseCodecs: Set<VideoCodec> = []
        var madeCodecs: [VideoCodec] = []

        init(outputURL: URL) { stub = StubFileWriter(outputURL: outputURL) }

        func makeWriter(
            configuration: TrackWriterConfiguration, codec: VideoCodec
        ) throws -> any TrackFileWriting {
            madeCodecs.append(codec)
            if refuseCodecs.contains(codec) {
                throw TrackWriterError.writerFailedToStart(
                    codec: codec.rawValue, reason: "stub refuses \(codec.rawValue)")
            }
            return stub
        }
    }

    // MARK: - Video

    @Test("The newest pre-gate frame is written at media time zero")
    func videoPreGateFrameAtZero() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240, codec: .h264)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))

        // Two frames before the gate: the newer one must win.
        writer.appendVideo(makeVideoBuffer(hostNs: epochNs - 400_000_000))
        writer.appendVideo(makeVideoBuffer(hostNs: epochNs - 100_000_000))

        let frameNs: Int64 = 33_333_333
        var host = epochNs + 50_000_000
        let postFrames = 30
        for _ in 0..<postFrames {
            writer.appendVideo(makeVideoBuffer(hostNs: host))
            host += frameNs
            // Exercise clock mapping at the screen writer's declared 60fps
            // input cadence; overload shedding has its own scripted test.
            try await Task.sleep(for: .nanoseconds(16_666_667))
        }
        let expectedEndNs = host - epochNs

        let status = await writer.finalize(endMediaTimeNs: expectedEndNs, deadline: .seconds(10))
        #expect(status.finalizeState == .finalized)
        #expect(status.usedFallbackCodec == false)
        #expect(status.framesDropped == 0)
        // Cached pre-gate frame + post-gate frames + the repeated end frame.
        #expect(status.framesWritten == postFrames + 2)
        #expect(status.firstMediaTimeNs == 0)
        #expect(status.lastMediaTimeNs == expectedEndNs)

        let summary = try await inspect(url: url)
        #expect(summary.videoTracks == 1)
        #expect(summary.audioTracks == 0)
        #expect(abs(summary.durationSeconds - Double(expectedEndNs) / 1e9) < 0.15)

        // Fragmented: a crash loses at most one interval, and the finalized
        // file carries movie fragments on disk.
        let bytes = try Data(contentsOf: url)
        #expect(bytes.range(of: Data("moof".utf8)) != nil)
    }

    @Test("Video frames after a pause jump across it on the media clock")
    func videoPauseJump() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240, codec: .h264)

        var clock = SessionClock(epochNs: epochNs)
        // A one-second pause one second in.
        try clock.beginPause(nowNs: epochNs + 500_000_000)
        try clock.endPause(nowNs: epochNs + 1_500_000_000)

        let writer = try TrackWriter(configuration: config, clock: clock)
        let frameNs: Int64 = 33_333_333
        var host = epochNs
        var liveFrames = 0
        var pausedFrames = 0
        while host < epochNs + 2_000_000_000 {
            if clock.isPaused(atHostNs: host) { pausedFrames += 1 } else { liveFrames += 1 }
            writer.appendVideo(makeVideoBuffer(hostNs: host))
            host += frameNs
            try await Task.sleep(for: .nanoseconds(16_666_667))
        }
        let expectedEndNs = clock.mediaTimeNs(atHostNs: host)

        let status = await writer.finalize(endMediaTimeNs: expectedEndNs, deadline: .seconds(10))
        #expect(status.finalizeState == .finalized)
        #expect((status.framesSuppressedByPause ?? 0) == Int64(pausedFrames))
        #expect(status.framesDropped == 0)
        // Live frames plus the repeated end frame.
        #expect(status.framesWritten == liveFrames + 1)

        let summary = try await inspect(url: url)
        #expect(summary.videoTracks == 1)
        // Two seconds of host time minus a one-second pause.
        #expect(abs(summary.durationSeconds - Double(expectedEndNs) / 1e9) < 0.15)
    }

    // MARK: - Audio

    @Test("Screen heartbeat does not overtake delayed genuine camera timestamps")
    func cameraHeartbeatDoesNotInventFrames() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("camera.mov")
        let factory = StubFactory(outputURL: url)
        let config = TrackWriterConfiguration(kind: .camera, outputURL: url, videoWidth: 320, videoHeight: 240)
        let writer = try TrackWriter(configuration: config, clock: SessionClock(epochNs: epochNs), factory: factory)
        writer.appendVideo(makeVideoBuffer(hostNs: epochNs + 100_000_000))
        // The next captured frame arrives fifty milliseconds after its PTS.
        // Filling synthetic camera pixels through wall time would move past it.
        writer.tick(nowHostNs: epochNs + 250_000_000)
        writer.appendVideo(makeVideoBuffer(hostNs: epochNs + 200_000_000))
        #expect(factory.stub.videoAppends == [100_000_000, 200_000_000])
        #expect(writer.status().framesWritten == 2)
        #expect(writer.status().framesDropped == 0)
    }

    @Test("Audio writes leading silence from media time zero")
    func audioLeadingSilence() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("mic.mov")
        let config = TrackWriterConfiguration.microphone(outputURL: url)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))

        // First sample 400 ms after the epoch, then 15 contiguous buffers
        // (about 320 ms more).
        var host = epochNs + 400_000_000
        let bufferNs: Int64 = Int64(Double(1024) / 48_000 * 1e9)
        for _ in 0..<15 {
            writer.appendAudio(makeAudioBuffer(hostNs: host))
            host += bufferNs
        }

        let status = await writer.finalize(deadline: .seconds(10))
        #expect(status.finalizeState == .finalized)
        #expect(status.firstMediaTimeNs == 0)
        #expect(status.framesWritten == 16)
        #expect(status.silenceFramesWritten == 1)
        #expect(status.framesDropped == 0)

        let summary = try await inspect(url: url)
        #expect(summary.audioTracks == 1)
        #expect(summary.videoTracks == 0)
        let expected = Double(host - epochNs) / 1e9
        #expect(abs(summary.durationSeconds - expected) < 0.15)
    }

    @Test("Static video heartbeat advances media and creates recoverable fragments")
    func staticVideoHeartbeat() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let writer = try TrackWriter(configuration: .screen(outputURL: url, width: 320, height: 240), clock: .init(epochNs: epochNs))
        writer.appendVideo(makeVideoBuffer(hostNs: epochNs))
        for tick in 1...30 {
            try await Task.sleep(nanoseconds: 100_000_000)
            writer.tick(nowHostNs: epochNs + Int64(tick) * 100_000_000)
        }
        writer.flush()
        let status = await writer.finalize(endMediaTimeNs: 3_000_000_000)
        #expect(status.finalizeState == .finalized)
        #expect(status.lastMediaTimeNs == 3_000_000_000)
        #expect(status.framesWritten >= 175)
        #expect(status.framesDropped == 0)
        let summary = try await inspect(url: url)
        #expect(abs(summary.durationSeconds - 3) < 0.005)
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        _ = try await generator.image(at: CMTime(seconds: 2.5, preferredTimescale: 600))
    }

    @Test("Silence warning requires three seconds of measured unmuted PCM")
    func measuredSilence() {
        var watch = SilenceWatch()
        let measurements = [
            watch.receive(rms: 0, mediaNs: 0, muted: false),
            watch.receive(rms: 0, mediaNs: 2_999_999_999, muted: false),
            watch.receive(rms: 0, mediaNs: 3_000_000_000, muted: false),
            watch.receive(rms: nil, mediaNs: 4_000_000_000, muted: false),
            watch.receive(rms: 0, mediaNs: 8_000_000_000, muted: false),
            watch.receive(rms: 0, mediaNs: 12_000_000_000, muted: true),
            watch.receive(rms: .nan, mediaNs: 20_000_000_000, muted: false),
        ]
        #expect(measurements == [false,false,true,false,false,false,false])
    }

    @Test("Sub-sample timestamp rounding preserves every real-shaped PCM buffer")
    func audioRoundingOverlap() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("mic.mov")
        let writer = try TrackWriter(configuration: .microphone(outputURL: url), clock: .init(epochNs: epochNs))
        let count = 150
        for index in 0..<count {
            let offset = Int64((Double(index) * 512 / 48_000 * 1e9).rounded())
            writer.appendAudio(makeAudioBuffer(hostNs: epochNs + offset, frames: 512))
        }
        let end = Int64((Double(count) * 512 / 48_000 * 1e9).rounded())
        let status = await writer.finalize(endMediaTimeNs: end)
        #expect(status.framesWritten >= count)
        #expect(status.framesDropped == 0)
        let summary = try await inspect(url: url)
        #expect(abs(summary.durationSeconds - 1.6) < 0.005)
    }

    @Test("Audio gaps over the threshold are filled with silence")
    func audioGapFill() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("mic.mov")
        let config = TrackWriterConfiguration.microphone(outputURL: url)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))

        let bufferNs: Int64 = Int64(Double(1024) / 48_000 * 1e9)
        var host = epochNs
        for _ in 0..<10 {  // media 0 ... 213 ms
            writer.appendAudio(makeAudioBuffer(hostNs: host))
            host += bufferNs
        }
        // A 787 ms gap (over the 250 ms threshold), then five more buffers.
        host = epochNs + 1_000_000_000
        for _ in 0..<5 {
            writer.appendAudio(makeAudioBuffer(hostNs: host))
            host += bufferNs
        }

        let status = await writer.finalize(deadline: .seconds(10))
        #expect(status.finalizeState == .finalized)
        #expect(status.framesWritten == 16)
        #expect(status.silenceFramesWritten == 1)

        let summary = try await inspect(url: url)
        #expect(summary.audioTracks == 1)
        let expected = Double(host - epochNs) / 1e9
        #expect(abs(summary.durationSeconds - expected) < 0.15)
    }

    @Test("Muted audio writes silence and keeps the track continuous")
    func mutedAudioWritesSilence() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("mic.mov")
        let config = TrackWriterConfiguration.microphone(outputURL: url)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))

        let bufferNs: Int64 = Int64(Double(1024) / 48_000 * 1e9)
        var host = epochNs
        for index in 0..<30 {
            if index == 10 { writer.setMuted(true) }
            if index == 20 { writer.setMuted(false) }
            writer.appendAudio(makeAudioBuffer(hostNs: host, amplitude: 0.5))
            host += bufferNs
        }

        let status = await writer.finalize(deadline: .seconds(10))
        #expect(status.finalizeState == .finalized)
        // Every buffer was written; ten of them as silence.
        #expect(status.framesWritten == 30)
        #expect(status.silenceFramesWritten == 10)
        #expect(status.framesDropped == 0)

        let summary = try await inspect(url: url)
        #expect(summary.audioTracks == 1)
        let expected = Double(host - epochNs) / 1e9
        #expect(abs(summary.durationSeconds - expected) < 0.15)

        // Decode and check the muted span really is silent while the spans on
        // either side carry the sine.
        let peaks = try await peakAmplitudeByBucket(url: url, bucketSeconds: 0.02)
        func peak(_ fromSeconds: Double, _ toSeconds: Double) -> Float {
            let lo = Int(fromSeconds / 0.02)
            let hi = Int(toSeconds / 0.02)
            return (lo..<hi).reduce(Float(0)) { max($0, peaks[$1] ?? 0) }
        }
        // Muted media window is [10, 20) buffers = [0.213, 0.427) s.
        #expect(peak(0.24, 0.40) < 0.02)
        #expect(peak(0.00, 0.15) > 0.1)
        #expect(peak(0.50, 0.62) > 0.1)
    }

    /// Decodes the audio track as Float32 PCM and returns the peak absolute
    /// sample per time bucket on the media timeline.
    private func peakAmplitudeByBucket(
        url: URL, bucketSeconds: Double
    ) async throws -> [Int: Float] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            Issue.record("no audio track to decode")
            return [:]
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ] as [String: Any])
        reader.add(output)
        reader.startReading()

        var peaks: [Int: Float] = [:]
        while let sample = output.copyNextSampleBuffer() {
            let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            let format = CMSampleBufferGetFormatDescription(sample)
            let asbd = format.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            let rate = Double(asbd?.mSampleRate ?? 48_000)
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            var length = 0
            var pointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(
                block, atOffset: 0, lengthAtOffsetOut: &length, totalLengthOut: nil,
                dataPointerOut: &pointer) == noErr, let pointer else { continue }
            let sampleCount = length / 4
            pointer.withMemoryRebound(to: Float.self, capacity: sampleCount) { floats in
                for i in 0..<sampleCount {
                    let t = pts + Double(i) / rate
                    let bucket = Int(t / bucketSeconds)
                    let magnitude = abs(floats[i])
                    if magnitude > peaks[bucket, default: 0] { peaks[bucket] = magnitude }
                }
            }
        }
        guard reader.status == .completed else {
            Issue.record("audio decode did not complete: \(String(describing: reader.error))")
            return peaks
        }
        return peaks
    }

    // MARK: - Backpressure

    @Test("Backpressure drops the oldest video frames when the queue is full")
    func backpressureDropsOldest() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let factory = StubFactory(outputURL: url)
        let config = TrackWriterConfiguration(
            kind: .screen, outputURL: url, videoWidth: 320, videoHeight: 240,
            preferredVideoCodec: .h264, maxPendingVideoFrames: 4)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs), factory: factory)

        // The stub encoder never accepts a frame.
        factory.stub.ready = false
        for index in 0..<10 {
            writer.appendVideo(makeVideoBuffer(hostNs: epochNs + Int64(index) * 33_333_333))
        }

        let status = writer.status()
        #expect(status.pendingDepth == 4)
        #expect(status.framesDropped == 6)
        #expect(status.framesWritten == 0)

        // Finalize with nothing drainable ends failed: no media was written.
        let finalStatus = await writer.finalize(deadline: .seconds(2))
        #expect(finalStatus.finalizeState == .failed)
    }

    // MARK: - Bounded finalize

    @Test("Finalize on a healthy writer completes within its deadline")
    func healthyFinalize() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240, codec: .h264)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))
        for index in 0..<5 {
            writer.appendVideo(makeVideoBuffer(hostNs: epochNs + Int64(index) * 33_333_333))
        }

        let start = DispatchTime.now()
        let status = await writer.finalize(deadline: .seconds(8))
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        #expect(status.finalizeState == .finalized)
        #expect(elapsed < 8)
        #expect(FileManager.default.fileExists(atPath: url.path))
    }

    @Test("A hung writer finalizes as degraded within the deadline")
    func hungFinalizeReportsDegraded() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let factory = StubFactory(outputURL: url)
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240, codec: .h264)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs), factory: factory)

        factory.stub.hungFinish = true
        for index in 0..<2 {
            writer.appendVideo(makeVideoBuffer(hostNs: epochNs + Int64(index) * 33_333_333))
        }

        let start = DispatchTime.now()
        let status = await writer.finalize(deadline: .milliseconds(300))
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9
        #expect(status.finalizeState == .degraded)
        #expect(status.framesWritten == 2)
        #expect(elapsed < 2)
    }

    @Test("Finalizing a writer with no samples fails and removes the file")
    func emptyFinalizeFails() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240, codec: .h264)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))

        let status = await writer.finalize(deadline: .seconds(5))
        #expect(status.finalizeState == .failed)
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }

    // MARK: - Codec fallback

    @Test("HEVC falls back to H.264 only from HEVC, and settings follow the plan")
    func codecFallbackDecision() {
        #expect(VideoCodec.hevc.fallback == .h264)
        #expect(VideoCodec.h264.fallback == nil)

        let screen = TrackWriterConfiguration.screen(
            outputURL: URL(fileURLWithPath: "/nonexistent/screen.mov"),
            width: 1920, height: 1080)
        let hevc = screen.videoOutputSettings(codec: .hevc)
        #expect(hevc != nil)
        #expect((hevc?[AVVideoCodecKey] as? AVVideoCodecType) == AVVideoCodecType.hevc)
        let screenProps = hevc?[AVVideoCompressionPropertiesKey] as? [String: Any]
        #expect((screenProps?[AVVideoAverageBitRateKey] as? Int) == max(20_000_000, 1920 * 1080 * 4))
        #expect((screenProps?[AVVideoExpectedSourceFrameRateKey] as? Int) == 60)
        #expect((screenProps?[AVVideoMaxKeyFrameIntervalKey] as? Int) == 60)

        let h264 = screen.videoOutputSettings(codec: .h264)
        #expect((h264?[AVVideoCodecKey] as? AVVideoCodecType) == AVVideoCodecType.h264)

        let camera = TrackWriterConfiguration.camera(
            outputURL: URL(fileURLWithPath: "/nonexistent/camera.mov"),
            width: 1280, height: 720)
        let cameraSettings = camera.videoOutputSettings(codec: .hevc)
        let cameraProps = cameraSettings?[AVVideoCompressionPropertiesKey] as? [String: Any]
        #expect((cameraProps?[AVVideoAverageBitRateKey] as? Int) == max(6_000_000, 1280 * 720 * 6))
        #expect((cameraProps?[AVVideoMaxKeyFrameIntervalKey] as? Int) == 30)

        let mic = TrackWriterConfiguration.microphone(
            outputURL: URL(fileURLWithPath: "/nonexistent/mic.mov"))
        let micSettings = mic.audioOutputSettings()
        #expect((micSettings?[AVNumberOfChannelsKey] as? Int) == 1)
        #expect((micSettings?[AVEncoderBitRateKey] as? Int) == 128_000)

        let system = TrackWriterConfiguration.systemAudio(
            outputURL: URL(fileURLWithPath: "/nonexistent/system.mov"))
        let systemSettings = system.audioOutputSettings()
        #expect((systemSettings?[AVNumberOfChannelsKey] as? Int) == 2)
        #expect((systemSettings?[AVEncoderBitRateKey] as? Int) == 192_000)
    }

    @Test("A codec that cannot start falls back to H.264 and reports it")
    func fallbackAtStart() throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")

        let factory = StubFactory(outputURL: url)
        factory.refuseCodecs = [.hevc]
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs), factory: factory)

        #expect(factory.madeCodecs == [.hevc, .h264])
        #expect(writer.status().usedFallbackCodec == true)

        // With no fallback left, opening fails.
        let exhausted = StubFactory(outputURL: url)
        exhausted.refuseCodecs = [.hevc, .h264]
        #expect(throws: TrackWriterError.self) {
            _ = try TrackWriter(
                configuration: config, clock: SessionClock(epochNs: epochNs), factory: exhausted)
        }
    }

    // MARK: - Status plumbing

    @Test("TrackWriterStatus round-trips through JSON")
    func statusCodable() throws {
        let status = TrackWriterStatus(
            kind: .screen, framesWritten: 12, silenceFramesWritten: 1, framesDropped: 3,
            firstMediaTimeNs: 0, lastMediaTimeNs: 400_000_000, pendingDepth: 0,
            usedFallbackCodec: false, finalizeState: .finalized, errorDescription: nil)
        let data = try JSONEncoder().encode(status)
        let decoded = try JSONDecoder().decode(TrackWriterStatus.self, from: data)
        #expect(decoded == status)
    }

    // MARK: - Live-gated (hardware encoder)

    @Test(
        "HEVC master encodes on hardware",
        .enabled(if: ProcessInfo.processInfo.environment["LOOM_LIVE_TESTS"] != nil))
    func liveHevcMaster() async throws {
        let dir = tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("screen.mov")
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240)
        let writer = try TrackWriter(
            configuration: config, clock: SessionClock(epochNs: epochNs))
        for index in 0..<20 {
            writer.appendVideo(makeVideoBuffer(hostNs: epochNs + Int64(index) * 33_333_333))
        }
        let status = await writer.finalize(
            endMediaTimeNs: 20 * 33_333_333, deadline: .seconds(10))
        #expect(status.usedFallbackCodec == false)
        #expect(status.finalizeState == .finalized)
        let summary = try await inspect(url: url)
        #expect(summary.videoTracks == 1)
    }
}
