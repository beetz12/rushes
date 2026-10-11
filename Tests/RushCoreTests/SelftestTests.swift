import AVFoundation
import CoreMedia
import Foundation
import Testing

@testable import RushCore

// MARK: - Synthetic media helpers

/// Builds synthetic track files with known ground truth through the real
/// `TrackWriter` (the same writer the live capture path uses), so the
/// selftest's analysis primitives are validated against files whose flash
/// and click times are known exactly. Everything in this suite is synthetic:
/// no capture hardware, no permissions, no screen or sound on the machine
/// running the tests.
private enum SyntheticSelftestMedia {

    static let epochNs: Int64 = 1_000_000_000_000

    static func tempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("selftest-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// One NV12 frame at `width x height` filled with one luma value, at a
    /// host-time presentation stamp (30 fps timing).
    static func videoBuffer(
        hostNs: Int64, width: Int = 320, height: Int = 240, luma: UInt8
    ) -> CMSampleBuffer {
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixelBuffer)
        guard let buffer = pixelBuffer else {
            fatalError("CVPixelBufferCreate failed")
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        for plane in 0..<CVPixelBufferGetPlaneCount(buffer) {
            guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) else { continue }
            let fill: UInt8 = plane == 0 ? luma : 128
            memset(
                base, Int32(fill),
                CVPixelBufferGetHeightOfPlane(buffer, plane)
                    * CVPixelBufferGetBytesPerRowOfPlane(buffer, plane))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer,
            formatDescriptionOut: &format)
        guard let format else { fatalError("format description creation failed") }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil,
            formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        guard let sample else { fatalError("CMSampleBufferCreateForImageBuffer failed") }
        return sample
    }

    /// One mono Float32 PCM buffer at 48 kHz: a sine burst (a click or a
    /// tone) of `durationSeconds`, stamped at a host time. The writer's
    /// leading-silence fill covers everything before it.
    static func audioBuffer(
        hostNs: Int64, frames: Int, amplitude: Float = 0.8, frequency: Float = 1_000
    ) -> CMSampleBuffer {
        let asbd = AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0)
        var format: CMAudioFormatDescription?
        let status = withUnsafePointer(to: asbd) { asbdPtr in
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: asbdPtr, layoutSize: 0, layout: nil,
                magicCookieSize: 0, magicCookie: nil, extensions: nil,
                formatDescriptionOut: &format)
        }
        guard status == noErr, let format else { fatalError("audio format creation failed") }
        let totalBytes = frames * 4
        let memory = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
        let floats = memory.assumingMemoryBound(to: Float.self)
        for index in 0..<frames {
            let t = Float(index) / 48_000
            floats[index] = amplitude * sin(2 * Float.pi * frequency * t)
        }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: memory, blockLength: totalBytes,
            blockAllocator: kCFAllocatorMalloc, customBlockSource: nil, offsetToData: 0,
            dataLength: totalBytes, flags: 0, blockBufferOut: &block)
        guard let block else { fatalError("CMBlockBufferCreateWithMemoryBlock failed") }
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
        guard let sample else { fatalError("CMSampleBufferCreate failed") }
        return sample
    }

    /// Writes a video file of `durationSeconds` at 30 fps: dark frames with
    /// `width x height`, white frames exactly over each interval in
    /// `whiteIntervals` (media seconds).
    static func writeVideoWithFlashes(
        url: URL, durationSeconds: Double, whiteIntervals: [(start: Double, end: Double)],
        width: Int = 320, height: Int = 240
    ) async throws {
        let writer = try TrackWriter(
            configuration: TrackWriterConfiguration.camera(
                outputURL: url, width: width, height: height),
            clock: SessionClock(epochNs: epochNs))
        let frameIntervalNs: Double = 1_000_000_000 / 30
        let frameCount = Int(durationSeconds * 30)
        for frame in 0...frameCount {
            let mediaNs = Double(frame) * frameIntervalNs
            // Intervals arrive in seconds; the cursor is in nanoseconds.
            let white = whiteIntervals.contains {
                mediaNs >= $0.start * 1e9 && mediaNs < $0.end * 1e9
            }
            writer.appendVideo(videoBuffer(
                hostNs: epochNs + Int64(mediaNs),
                width: width, height: height,
                luma: white ? 235 : 16))
        }
        _ = await writer.finalize(endMediaTimeNs: Int64(durationSeconds * 1e9))
    }

    /// Writes an audio file: silence everywhere except a short burst at each
    /// time in `burstTimes` (media seconds). The writer writes the leading
    /// silence itself; only the bursts are appended.
    static func writeAudioWithBursts(
        url: URL, durationSeconds: Double, burstTimes: [Double],
        burstSeconds: Double = 0.05
    ) async throws {
        let writer = try TrackWriter(
            configuration: TrackWriterConfiguration.microphone(outputURL: url),
            clock: SessionClock(epochNs: epochNs))
        let frames = Int(48_000 * burstSeconds)
        for burst in burstTimes {
            writer.appendAudio(audioBuffer(
                hostNs: epochNs + Int64(burst * 1e9), frames: frames))
        }
        _ = await writer.finalize(endMediaTimeNs: Int64(durationSeconds * 1e9))
    }
}

// MARK: - Pure finder tests

@Suite("Selftest onset finders")
struct SelftestOnsetFinderTests {

    private func block(_ timeMs: Double, _ rms: Double) -> AudioEnvelopeBlock {
        AudioEnvelopeBlock(timeMs: timeMs, rms: rms)
    }

    @Test("firstSustainedRise finds a tone rising out of silence")
    func sustainedRise() {
        var blocks: [AudioEnvelopeBlock] = []
        for millisecond in 0..<3_000 {
            let rms = millisecond < 2_000 ? 0.00001 : 0.5
            blocks.append(block(Double(millisecond), rms))
        }
        let onset = AudioOnset.firstSustainedRise(
            blocks: blocks, windowMs: 0...3_000)
        #expect(onset != nil)
        #expect(abs((onset ?? 0) - 2_000) <= 2)
    }

    @Test("firstSustainedRise ignores a single noisy block")
    func ignoresIsolatedSpike() {
        var blocks: [AudioEnvelopeBlock] = []
        for millisecond in 0..<1_000 {
            let rms = millisecond == 500 ? 0.9 : 0.00001
            blocks.append(block(Double(millisecond), rms))
        }
        #expect(
            AudioOnset.firstSustainedRise(blocks: blocks, windowMs: 0...1_000) == nil)
    }

    @Test("sharpAttacks finds three claps at their attack starts")
    func threeClaps() {
        var blocks: [AudioEnvelopeBlock] = []
        let attacks = [1_000.0, 2_000.0, 3_500.0]
        for millisecond in 0..<4_500 {
            var rms = 0.0005
            for attack in attacks {
                let distance = Double(millisecond) - attack
                if distance >= 0, distance < 60 {
                    // Sharp attack: full level within a few blocks.
                    rms = 0.7
                } else if distance >= 60, distance < 300 {
                    rms = 0.02
                }
            }
            blocks.append(block(Double(millisecond), rms))
        }
        let found = AudioOnset.sharpAttacks(blocks: blocks)
        #expect(found.count == 3, "expected three claps, found \(found)")
        for (attack, onset) in zip(attacks.sorted(), found) {
            #expect(abs(onset - attack) <= 15, "clap at \(attack) found at \(onset)")
        }
    }
}

// MARK: - Synthetic file tests

/// Serialized: these tests write hardware-encoded media through the real
/// `TrackWriter`, one writer at a time, keeping encoder load deterministic.
@Suite("Selftest analysis on synthetic files", .serialized)
struct SelftestSyntheticFileTests {

    @Test("the tone onset is found in a silent-then-tone mic file")
    func toneOnset() async throws {
        let dir = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("mic.mov")
        try await SyntheticSelftestMedia.writeAudioWithBursts(
            url: url, durationSeconds: 3, burstTimes: [2.0], burstSeconds: 0.4)

        let blocks = try await AudioEnvelope.blocks(url: url)
        #expect(blocks.count > 2_500, "expected a ~3 s envelope, got \(blocks.count) blocks")
        let onset = AudioOnset.firstSustainedRise(blocks: blocks, windowMs: 0...3_000)
        #expect(onset != nil, "the tone onset was not found")
        if let onset {
            #expect(
                abs(onset - 2_000) <= 20,
                "tone onset measured at \(onset) ms, expected 2000 ms")
        }
    }

    @Test("the flash onset is found in a dark-then-white camera file")
    func flashOnset() async throws {
        let dir = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("camera.mov")
        try await SyntheticSelftestMedia.writeVideoWithFlashes(
            url: url, durationSeconds: 3, whiteIntervals: [(2.0, 2.25)])

        let frames = try await VideoFrameSeries.samples(url: url)
        #expect(frames.count > 80, "expected ~90 frames, got \(frames.count)")
        let onset = VideoOnset.flashOnset(samples: frames, windowMs: 0...3_000)
        #expect(onset != nil, "the flash onset was not found")
        if let onset {
            #expect(
                abs(onset - 2_000) <= 40,
                "flash onset measured at \(onset) ms, expected 2000 ms (one 30 fps frame)")
        }
    }

    @Test("analyze clap recovers a known camera-mic offset (synthetic ground truth)")
    func clapKnownOffset() async throws {
        let dir = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cameraURL = dir.appendingPathComponent("camera.mov")
        let micURL = dir.appendingPathComponent("mic.mov")

        // Three flashes at these media times; each click sounds 80 ms later,
        // so the expected offset (visual minus audio) is -80 ms per clap.
        let flashTimes = [1.5, 3.0, 4.5]
        try await SyntheticSelftestMedia.writeVideoWithFlashes(
            url: cameraURL, durationSeconds: 6,
            whiteIntervals: flashTimes.map { ($0, $0 + 0.2) })
        try await SyntheticSelftestMedia.writeAudioWithBursts(
            url: micURL, durationSeconds: 6,
            burstTimes: flashTimes.map { $0 + 0.08 })

        let analysis = try await ClapAnalysis.analyze(
            cameraURL: cameraURL, microphoneURL: micURL)
        #expect(analysis.claps.count == 3, "expected three claps, got \(analysis.claps)")
        for clap in analysis.claps {
            #expect(clap.visualMs != nil, "no visual match for clap at \(clap.audioMs)")
            if let offset = clap.offsetMs {
                #expect(
                    abs(offset - (-80)) <= 20,
                    "clap offset measured \(offset) ms, expected -80 ms")
            }
        }
        // With a real -80 ms skew the pass verdict must be false (40 ms
        // tolerance); a perfectly aligned pair passes.
        #expect(analysis.pass == false)
    }

    @Test("analyze clap passes when camera and mic are aligned (synthetic ground truth)")
    func clapAligned() async throws {
        let dir = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cameraURL = dir.appendingPathComponent("camera.mov")
        let micURL = dir.appendingPathComponent("mic.mov")
        try await SyntheticSelftestMedia.writeVideoWithFlashes(
            url: cameraURL, durationSeconds: 4, whiteIntervals: [(2.0, 2.2)])
        try await SyntheticSelftestMedia.writeAudioWithBursts(
            url: micURL, durationSeconds: 4, burstTimes: [2.0])

        let analysis = try await ClapAnalysis.analyze(
            cameraURL: cameraURL, microphoneURL: micURL)
        #expect(analysis.claps.count == 1)
        #expect(analysis.pass == true, "analysis: \(analysis)")
    }

    @Test("the sync measurement recovers both raw offsets (synthetic ground truth)")
    func syncMeasurement() async throws {
        let dir = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let screenURL = dir.appendingPathComponent("screen.mov")
        let systemURL = dir.appendingPathComponent("system.mov")

        // Flashes at 1.5 s and 4.0 s; tones 80 and 90 ms later, so the raw
        // audio-minus-video offsets are +80 and +90 ms.
        try await SyntheticSelftestMedia.writeVideoWithFlashes(
            url: screenURL, durationSeconds: 6,
            whiteIntervals: [(1.5, 1.7), (4.0, 4.2)])
        try await SyntheticSelftestMedia.writeAudioWithBursts(
            url: systemURL, durationSeconds: 6,
            burstTimes: [1.58, 4.09], burstSeconds: 0.4)

        let measurement = try await SelftestSyncMeasurement.measure(
            screenURL: screenURL,
            systemAudioURL: systemURL,
            preWindowMs: 1_300...1_700,
            postWindowMs: 3_800...4_200)
        #expect(measurement.complete, "measurement incomplete: \(measurement)")
        if let pre = measurement.pre.rawOffsetMs {
            #expect(abs(pre - 80) <= 25, "pre raw offset \(pre), expected 80")
        }
        if let post = measurement.post.rawOffsetMs {
            #expect(abs(post - 90) <= 25, "post raw offset \(post), expected 90")
        }

        // The report applies the stored latency and fails only outside the
        // one-frame tolerance.
        let failingReport = SelftestSyncReport(
            recordingId: "x", packagePath: dir.path, measurement: measurement,
            appliedLatencyMs: 0, measuredLatencyMs: 85)
        #expect(failingReport.pass == false)
        let passingReport = SelftestSyncReport(
            recordingId: "x", packagePath: dir.path, measurement: measurement,
            appliedLatencyMs: 85, measuredLatencyMs: 85)
        #expect(passingReport.pass == true)
        #expect(abs((passingReport.pre.offsetMs ?? 999) - (-5)) <= 25)
    }
}

// MARK: - Latency store

@Suite("Selftest latency store")
struct SelftestLatencyStoreTests {

    @Test("saves and loads the measured latency")
    func roundTrip() throws {
        let dir = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = SelftestLatencyStore(
            url: dir.appendingPathComponent("latency.json"))
        #expect(store.load() == nil, "a fresh store must load nothing")

        try store.save(SelftestLatencyStore.Stored(
            systemAudioLatencyMs: 87.5, measuredAt: "2026-10-11T00:00:00Z",
            recordingId: "01JTEST"))
        let loaded = store.load()
        #expect(loaded?.systemAudioLatencyMs == 87.5)
        #expect(loaded?.recordingId == "01JTEST")
    }
}

// MARK: - Tone buffer math

@Suite("Selftest tone")
struct SelftestToneTests {

    @Test("the tone buffer carries the full duration at a real level")
    func toneBuffer() throws {
        let buffer = try SelftestTonePlayer.makeToneBuffer(
            frequency: 440, durationSeconds: 0.4, amplitude: 0.6)
        #expect(buffer.frameLength == AVAudioFrameCount(48_000 * 0.4))
        guard let samples = buffer.floatChannelData else {
            Issue.record("no channel data")
            return
        }
        var peak: Float = 0
        for frame in 0..<Int(buffer.frameLength) {
            peak = max(peak, abs(samples[0][frame]))
        }
        #expect(peak > 0.3, "the tone must be audible, peak was \(peak)")
    }

    @Test("mach tick conversion round-trips within a millisecond")
    func machTicks() {
        let nowNs = Int64(DispatchTime.now().uptimeNanoseconds) + 500_000_000
        let ticks = SelftestTonePlayer.machTicks(fromHostNanoseconds: nowNs)
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let backNs = Int64(Double(ticks) * Double(info.numer) / Double(info.denom))
        #expect(abs(backNs - nowNs) <= 1_000_000, "round trip drifted \(backNs - nowNs) ns")
    }
}

// MARK: - Controller command surface (headless)

/// A no-op signal: the command path runs end to end in the suite without
/// flashing a window or playing a tone on the machine running the tests.
private struct NoopSelftestSignal: SelftestSignaling {
    func prepare() throws {}
    func fire(atHostNs hostNs: Int64) {}
    func stop() {}
}

@Suite("Selftest commands", .serialized)
struct SelftestCommandTests {

    private func makeController(
        root: URL, indexURL: URL, latencyURL: URL
    ) throws -> EngineController {
        try EngineController(config: EngineControllerConfig(
            recordingsRoot: root,
            indexDatabaseURL: indexURL,
            catalog: StubSelftestCatalog(),
            volumeProvider: { _ in VolumeInfo(availableBytes: 100 * 1024 * 1024 * 1024) },
            captureRigs: StubCaptureRigFactory(),
            selftestLatencyURL: latencyURL,
            makeSelftestSignal: { NoopSelftestSignal() }))
    }

    @Test("selftest.sync runs the take and reports honestly when no signal lands in the files")
    func selftestSyncHonestFailure() async throws {
        let scratch = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"),
            latencyURL: scratch.appendingPathComponent("latency.json"))
        let exchange = ControlExchange()

        await controller.handle(
            ControlRequest(
                id: "st", cmd: "selftest.sync",
                args: .object(["seconds": .double(6), "pauseAt": .double(2.5)])),
            context: exchange.context)

        let response = try #require(exchange.lastResponse)
        #expect(response.ok == false)
        #expect(response.error?.code == "selftest-measurement-failed")
        // No latency was invented: the store stays empty.
        let store = SelftestLatencyStore(url: scratch.appendingPathComponent("latency.json"))
        #expect(store.load() == nil)
        // The take itself is finished and listed, not left dangling.
        await controller.handle(
            ControlRequest(id: "s", cmd: "status"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["state"]?.string == "idle")
    }

    @Test("selftest.sync rejects invalid parameters")
    func selftestSyncUsage() async throws {
        let scratch = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"),
            latencyURL: scratch.appendingPathComponent("latency.json"))
        let exchange = ControlExchange()

        await controller.handle(
            ControlRequest(id: "b1", cmd: "selftest.sync", args: .object([
                "seconds": .double(2),
            ])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "invalid-params")

        await controller.handle(
            ControlRequest(id: "b2", cmd: "selftest.sync", args: .object([
                "seconds": .double(20), "pauseAt": .double(19),
            ])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "invalid-params")
        #expect(exchange.lastResponse?.result == nil)
    }

    @Test("analyze.clap reports not-found for an unknown id")
    func analyzeClapUnknown() async throws {
        let scratch = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"),
            latencyURL: scratch.appendingPathComponent("latency.json"))
        let exchange = ControlExchange()

        await controller.handle(
            ControlRequest(id: "c", cmd: "analyze.clap", args: .object([
                "id": .string("01JANOTREAL0000000000000000"),
            ])),
            context: exchange.context)
        #expect(exchange.lastResponse?.ok == false)
        #expect(exchange.lastResponse?.error?.code == "not-found")
    }

    @Test("analyze.clap measures a real package's camera and mic files")
    func analyzeClapOnPackage() async throws {
        let scratch = try SyntheticSelftestMedia.tempDir()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root", isDirectory: true)
        let controller = try makeController(
            root: root,
            indexURL: scratch.appendingPathComponent("index.sqlite"),
            latencyURL: scratch.appendingPathComponent("latency.json"))

        // A package whose camera and mic carry one aligned clap at 2 s.
        let package = try RecordingPackage.create(root: root, id: RecordingId.generate())
        try await SyntheticSelftestMedia.writeVideoWithFlashes(
            url: package.trackURL(for: .camera), durationSeconds: 4,
            whiteIntervals: [(2.0, 2.2)])
        try await SyntheticSelftestMedia.writeAudioWithBursts(
            url: package.trackURL(for: .microphone), durationSeconds: 4,
            burstTimes: [2.0])
        try package.writeManifest(RecordingManifest(
            id: package.id, status: .complete,
            tracks: [
                .init(kind: .camera, present: true),
                .init(kind: .microphone, present: true),
            ]))

        let exchange = ControlExchange()
        await controller.handle(
            ControlRequest(id: "c", cmd: "analyze.clap", args: .object([
                "id": .string(package.id),
            ])),
            context: exchange.context)
        let response = try #require(exchange.lastResponse)
        #expect(response.ok == true, "error: \(String(describing: response.error))")
        let claps = response.result?["claps"]?.array ?? []
        #expect(claps.count == 1)
        #expect(response.result?["pass"]?.bool == true)
    }
}

/// The catalog stub the selftest command suite needs (same shape as the
/// control suite's).
private struct StubSelftestCatalog: SourceCataloging {
    func displays() async throws -> [DisplaySource] {
        [DisplaySource(
            id: "display-1", name: "Built-in",
            widthPoints: 640, heightPoints: 480, isMain: true)]
    }
    func windows() async throws -> [WindowSource] { [] }
    func cameras() async throws -> [CameraDevice] { [] }
    func microphones() async throws -> [MicrophoneDevice] {
        [MicrophoneDevice(id: "dev-mic", name: "MacBook Pro Microphone")]
    }
}
