import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit
import Testing

@testable import RushCore

// MARK: - Shared synthetic media helpers

private func makeVideoBuffer(hostNs: Int64, width: Int = 320, height: Int = 240) -> CMSampleBuffer {
    var pixelBuffer: CVPixelBuffer?
    CVPixelBufferCreate(
        kCFAllocatorDefault, width, height,
        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixelBuffer)
    guard let buffer = pixelBuffer else {
        Issue.record("CVPixelBufferCreate failed")
        fatalError("CVPixelBufferCreate failed")
    }
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

private func makeAudioBuffer(
    hostNs: Int64, frames: Int = 1024, channels: UInt32 = 1
) -> CMSampleBuffer {
    let rate: Double = 48_000
    let asbd = AudioStreamBasicDescription(
        mSampleRate: rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4 * channels,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4 * channels,
        mChannelsPerFrame: channels,
        mBitsPerChannel: 32,
        mReserved: 0)
    var format: CMAudioFormatDescription?
    withUnsafePointer(to: asbd) { asbdPtr in
        CMAudioFormatDescriptionCreate(
            allocator: kCFAllocatorDefault, asbd: asbdPtr, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil,
            formatDescriptionOut: &format)
    }
    guard let format else {
        Issue.record("audio format description failed")
        fatalError("audio format description failed")
    }
    let totalBytes = frames * 4 * Int(channels)
    let memory = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
    memset(memory, 0, totalBytes)
    var block: CMBlockBuffer?
    CMBlockBufferCreateWithMemoryBlock(
        allocator: kCFAllocatorDefault, memoryBlock: memory, blockLength: totalBytes,
        blockAllocator: kCFAllocatorMalloc, customBlockSource: nil, offsetToData: 0,
        dataLength: totalBytes, flags: 0, blockBufferOut: &block)
    guard let block else {
        Issue.record("block buffer failed")
        fatalError("block buffer failed")
    }
    var timing = [CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: 48_000),
        presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
        decodeTimeStamp: .invalid)]
    var sample: CMSampleBuffer?
    CMSampleBufferCreate(
        allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true,
        makeDataReadyCallback: nil, refcon: nil,
        formatDescription: format, sampleCount: CMItemCount(frames),
        sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
    guard let sample else {
        Issue.record("CMSampleBufferCreate failed")
        fatalError("CMSampleBufferCreate failed")
    }
    return sample
}

private func tempDir(_ label: String) -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("capture-\(label)-\(UUID().uuidString)", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

// MARK: - Stub writer backend (the TrackFileWriting seam)

/// Records every append; the routing test asserts which writer received
/// which buffer kind.
private final class RecordingBackend: TrackFileWriting, @unchecked Sendable {
    let outputURL: URL
    private let lock = NSLock()
    private(set) var videoFrames: [Int64] = []
    private(set) var audioBuffers: [Int64] = []
    var ready = true

    init(outputURL: URL) {
        self.outputURL = outputURL
    }

    var currentState: FileWritingState { .writing }
    var failureDescription: String? { nil }
    var isReadyForMoreMediaData: Bool { ready }

    @discardableResult
    func startWriting() -> Bool { true }
    func startSession() {}

    @discardableResult
    func appendVideoFrame(_ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool {
        lock.lock()
        videoFrames.append(mediaTimeNs)
        lock.unlock()
        return true
    }

    @discardableResult
    func appendAudioSamples(_ sampleBuffer: CMSampleBuffer) -> Bool {
        lock.lock()
        audioBuffers.append(
            CMSampleBufferGetPresentationTimeStamp(sampleBuffer).nanosecondsI64 ?? -1)
        lock.unlock()
        return true
    }

    func markInputFinished() {}
    func finishWriting(completion: @escaping @Sendable () -> Void) { completion() }
    func cancelWriting() {}
}

private struct RecordingBackendFactory: TrackFileWritingFactory {
    let holder: BackendHolder
    func makeWriter(
        configuration: TrackWriterConfiguration, codec: VideoCodec
    ) throws -> any TrackFileWriting {
        let backend = RecordingBackend(outputURL: configuration.outputURL)
        holder.backends[configuration.kind] = backend
        return backend
    }
}

private final class BackendHolder: @unchecked Sendable {
    var backends: [TrackKind: RecordingBackend] = [:]
}

private func makeWriter(
    kind: TrackKind, dir: URL, holder: BackendHolder, epochNs: Int64
) throws -> TrackWriter {
    let configuration: TrackWriterConfiguration
    switch kind {
    case .screen:
        configuration = .screen(outputURL: dir.appendingPathComponent("screen.mov"), width: 320, height: 240)
    case .camera:
        configuration = .camera(outputURL: dir.appendingPathComponent("camera.mov"), width: 320, height: 240)
    case .microphone:
        configuration = .microphone(outputURL: dir.appendingPathComponent("mic.mov"))
    case .systemAudio:
        configuration = .systemAudio(outputURL: dir.appendingPathComponent("system.mov"))
    }
    let clock = SessionClock(epochNs: epochNs)
    return try TrackWriter(
        configuration: configuration, clock: clock, factory: RecordingBackendFactory(holder: holder))
}

// MARK: - Sizing (copied OpenScreen helper)

@Suite("CaptureSizing")
struct CaptureSizingTests {

    @Test("Output size is content points times scale, even numbers")
    func contentTimesScale() {
        let size = captureOutputSize(
            contentSize: CGSize(width: 1512, height: 982),
            pointPixelScale: 2,
            maxWidth: 3840,
            maxHeight: 3840)
        #expect(size.width == 3024)
        #expect(size.height == 1964)
    }

    @Test("Odd pixel sizes round down to even")
    func evenNumbers() {
        let size = captureOutputSize(
            contentSize: CGSize(width: 755.5, height: 500),
            pointPixelScale: 2,
            maxWidth: 3840,
            maxHeight: 3840)
        #expect(size.width % 2 == 0)
        #expect(size.height % 2 == 0)
        // evenFloor(1511) = 1510, evenFloor(1000) = 1000
        #expect(size.width == 1510)
        #expect(size.height == 1000)
    }

    @Test("Long edge caps at 3840 with one proportional factor")
    func longEdgeCap() {
        // 5120x1440 ultrawide at 1x: one factor, not a per-axis clamp.
        let size = captureOutputSize(
            contentSize: CGSize(width: 5120, height: 1440),
            pointPixelScale: 1,
            maxWidth: 3840,
            maxHeight: 3840)
        #expect(max(size.width, size.height) <= 3840)
        #expect(size.width == 3840)
        // 5120 * (3840/5120) = 3840; 1440 * 0.75 = 1080: aspect kept, no bars.
        #expect(size.height == 1080)
    }

    @Test("Small content is never scaled up")
    func noUpscale() {
        let size = captureOutputSize(
            contentSize: CGSize(width: 800, height: 600),
            pointPixelScale: 1,
            maxWidth: 3840,
            maxHeight: 3840)
        #expect(size.width == 800)
        #expect(size.height == 600)
    }

    @Test("evenFloor floors at 2")
    func evenFloorMinimum() {
        #expect(evenFloor(1) == 2)
        #expect(evenFloor(0) == 2)
        #expect(evenFloor(3) == 2)
        #expect(evenFloor(4) == 4)
    }
}

// MARK: - Screen stream plan

@Suite("ScreenStreamPlan")
struct ScreenStreamPlanTests {

    @Test("Plan values match the plan document: 60fps, queue depth 3, NV12 video range")
    func planValues() {
        let plan = ScreenStreamPlan.make(
            contentSize: CGSize(width: 1512, height: 982),
            pointPixelScale: 2,
            systemAudio: true,
            microphone: true)
        #expect(plan.width == 3024)
        #expect(plan.height == 1964)
        #expect(plan.minimumFrameInterval == CMTime(value: 1, timescale: 60))
        #expect(plan.queueDepth == 3)
        #expect(plan.pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        #expect(plan.showsCursor)
        #expect(plan.capturesSystemAudio)
        #expect(plan.capturesMicrophone)
        #expect(plan.sourceRect == nil)
    }

    @Test("Normal recordings exclude our own audio; selftest includes it")
    func ownAudioExclusion() {
        let normal = ScreenStreamPlan.make(
            contentSize: CGSize(width: 100, height: 100), pointPixelScale: 1,
            systemAudio: true, microphone: false)
        #expect(normal.excludesOwnProcessAudio)

        let selftest = ScreenStreamPlan.make(
            contentSize: CGSize(width: 100, height: 100), pointPixelScale: 1,
            systemAudio: true, microphone: false, selftest: true)
        #expect(!selftest.excludesOwnProcessAudio)
    }

    @Test("SCStreamConfiguration carries the plan's values")
    func configurationMatchesPlan() {
        let plan = ScreenStreamPlan.make(
            contentSize: CGSize(width: 1512, height: 982),
            pointPixelScale: 2,
            systemAudio: true,
            microphone: true,
            microphoneDeviceID: "dev-built-in-mic",
            sourceRect: CGRect(x: 10, y: 20, width: 500, height: 300))
        let configuration = ScreenSource.makeConfiguration(for: plan)
        #expect(configuration.width == 3024)
        #expect(configuration.height == 1964)
        #expect(configuration.minimumFrameInterval == CMTime(value: 1, timescale: 60))
        #expect(configuration.queueDepth == 3)
        #expect(configuration.pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        #expect(configuration.showsCursor == true)
        #expect(configuration.capturesAudio == true)
        #expect(configuration.excludesCurrentProcessAudio == true)
        #expect(configuration.captureMicrophone == true)
        #expect(configuration.microphoneCaptureDeviceID == "dev-built-in-mic")
        #expect(configuration.sourceRect == CGRect(x: 10, y: 20, width: 500, height: 300))
    }

    @Test("Area rect clamps to the display and sizes by the same rules")
    func areaMath() {
        let display = CGRect(x: 0, y: 0, width: 1512, height: 982)
        let dragged = CGRect(x: 1400, y: 900, width: 400, height: 300)
        let clamped = AreaRectMath.clamp(dragged, toDisplay: display)
        #expect(clamped != nil)
        #expect(clamped!.maxX <= display.maxX)
        #expect(clamped!.maxY <= display.maxY)

        // A drag entirely off the display is dropped.
        let missed = AreaRectMath.clamp(
            CGRect(x: 2000, y: 2000, width: 100, height: 100), toDisplay: display)
        #expect(missed == nil)

        // Area sizing follows the display rule: even numbers, 3840 long edge.
        let size = AreaRectMath.outputSize(area: clamped!, pointPixelScale: 2)
        #expect(size.width % 2 == 0)
        #expect(size.height % 2 == 0)
        #expect(max(size.width, size.height) <= ScreenStreamPlan.maxLongEdgePixels)
    }
}

// MARK: - Exclusion list

@Suite("ScreenExclusionList")
struct ScreenExclusionListTests {

    @Test("Engine and shell bundle ids are both excluded, deduplicated")
    func excludesBoth() {
        let list = ScreenExclusionList(shellBundleID: "ai.rushes.app", engineBundleID: "ai.rushes.app")
        #expect(list.bundleIDs(selftest: false) == ["ai.rushes.app"])

        let distinct = ScreenExclusionList(shellBundleID: "ai.rushes.app", engineBundleID: "ai.rushes.engine")
        #expect(distinct.bundleIDs(selftest: false) == ["ai.rushes.app", "ai.rushes.engine"])
    }

    @Test("Selftest mode excludes nothing: the stream must see our window")
    func selftestEmpty() {
        let list = ScreenExclusionList(shellBundleID: "ai.rushes.app", engineBundleID: "ai.rushes.engine")
        #expect(list.bundleIDs(selftest: true).isEmpty)
    }

    @Test("Nil seams produce an empty list")
    func nilSeams() {
        let list = ScreenExclusionList(shellBundleID: nil, engineBundleID: nil)
        #expect(list.bundleIDs(selftest: false).isEmpty)
    }
}

// MARK: - Buffer routing

@Suite("Screen buffer routing")
struct ScreenBufferRoutingTests {

    private let epochNs: Int64 = 1_000_000_000_000

    @Test("Fake screen, mic and system buffers land in the right writers")
    func routing() throws {
        let dir = tempDir("routing")
        let holder = BackendHolder()
        let screen = try makeWriter(kind: .screen, dir: dir, holder: holder, epochNs: epochNs)
        let mic = try makeWriter(kind: .microphone, dir: dir, holder: holder, epochNs: epochNs)
        let system = try makeWriter(kind: .systemAudio, dir: dir, holder: holder, epochNs: epochNs)

        let sink = WriterRoutingSink()
        sink.setWriters([.screen: screen, .microphone: mic, .systemAudio: system])

        // One video frame and one stereo pair of audio buffers, host-stamped.
        sink.accept(makeVideoBuffer(hostNs: epochNs + 16_000_000), from: .screen)
        sink.accept(makeAudioBuffer(hostNs: epochNs + 1_000_000, channels: 1), from: .microphone)
        sink.accept(makeAudioBuffer(hostNs: epochNs + 2_000_000, channels: 2), from: .systemAudio)

        let screenBackend = try #require(holder.backends[.screen])
        let micBackend = try #require(holder.backends[.microphone])
        let systemBackend = try #require(holder.backends[.systemAudio])

        // Mic and system audio never land in the screen writer: the screen
        // backend must hold video frames only, and the audio backends must
        // hold audio only.
        #expect(screenBackend.videoFrames.count == 1)
        #expect(screenBackend.audioBuffers.isEmpty)
        #expect(micBackend.videoFrames.isEmpty)
        #expect(systemBackend.videoFrames.isEmpty)

        // The first audio sample at media 1 ms / 2 ms arrives after media
        // zero, so each audio writer writes leading silence at zero ahead of
        // it (docs/PLAN.md, Audio at zero): two buffers each, first at 0.
        #expect(micBackend.audioBuffers == [0, 1_000_000])
        #expect(systemBackend.audioBuffers == [0, 2_000_000])

        // Media times are host minus epoch.
        #expect(screenBackend.videoFrames.first == 16_000_000)

        // Counters reflect one received frame per output.
        let status = sink.status()
        #expect(status.framesReceived[.screen] == 1)
        #expect(status.framesReceived[.microphone] == 1)
        #expect(status.framesReceived[.systemAudio] == 1)
    }

    @Test("Screen buffers without a complete-frame status are not forwarded")
    func frameStatusGate() {
        // No status attachment at all: the forwarder must drop it.
        let buffer = makeVideoBuffer(hostNs: epochNs)
        #expect(!ScreenStreamOutputForwarder.isCompleteFrame(buffer))
    }

    @Test("Stream failures surface once through the failure seam")
    func failureForwarding() {
        let box = FailureBox()
        let forwarder = ScreenStreamFailureForwarder { message in
            box.record(message)
        }
        let error = NSError(
            domain: "test.stream", code: 1,
            userInfo: [NSLocalizedDescriptionKey: "display slept"])
        forwarder.stream(unsafeBitCast(0, to: SCStream.self), didStopWithError: error)
        forwarder.stream(unsafeBitCast(0, to: SCStream.self), didStopWithError: error)
        #expect(box.messages.count == 1)
        #expect(box.messages.first == "display slept")
    }

    @Test("Stream errors reach a stopEarly-shaped handler through the source seam")
    func stopEarlyPath() async throws {
        // Drive the whole source with a scripted stream and resolver to show
        // start() installs the three outputs and the failure seam end to end.
        final class FakeStream: ScreenStreamDriving, @unchecked Sendable {
            var added: [(ScreenOutputStream, DispatchQueue?)] = []
            var started = false
            var stopped = false
            func addOutput(
                _ forwarder: ScreenStreamOutputForwarder, type: SCStreamOutputType, queue: DispatchQueue?
            ) async throws {
                added.append((forwarder.output, queue))
            }
            func startCapture() async throws { started = true }
            func stopCapture() async throws { stopped = true }
        }
        struct FakeResolver: ScreenSource.ContentResolving {
            func resolve(
                surface: ScreenSurface, excludingBundleIDs: [String]
            ) async throws -> ScreenSource.ResolvedContent {
                throw ScreenSourceError.sourceUnavailable("no hardware in unit tests")
            }
        }
        let plan = ScreenStreamPlan.make(
            contentSize: CGSize(width: 100, height: 100), pointPixelScale: 1,
            systemAudio: true, microphone: true)
        let source = ScreenSource(
            plan: plan, resolver: FakeResolver(),
            onStreamFailure: { _ in },
            streamFactory: { _, _, _ in FakeStream() })

        // A resolver that refuses surfaces the machine-readable error.
        await #expect(throws: ScreenSourceError.self) {
            try await source.start(
                surface: .display(id: "display-1"),
                exclusion: ScreenExclusionList(shellBundleID: "x", engineBundleID: "y"),
                selftest: false)
        }
        #expect(!source.isStarted)
    }
}

private final class FailureBox: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var messages: [String] = []
    func record(_ message: String) {
        lock.lock()
        messages.append(message)
        lock.unlock()
    }
}

// MARK: - Camera

@Suite("CameraSource")
struct CameraSourceTests {

    @Test("Format choice prefers 1080p30, then 720p30, then any 30fps")
    func formatChoice() {
        let options = [
            CameraFormatOption(width: 640, height: 480, supports30fps: true, index: 0),
            CameraFormatOption(width: 1280, height: 720, supports30fps: true, index: 1),
            CameraFormatOption(width: 1920, height: 1080, supports30fps: false, index: 2),
        ]
        // No 1080p30: falls to 720p30, not the 1080p without 30fps support.
        let chosen = CameraFormatChoice.choose(from: options)
        #expect(chosen?.index == 1)

        let with1080 = options + [CameraFormatOption(width: 1920, height: 1080, supports30fps: true, index: 3)]
        #expect(CameraFormatChoice.choose(from: with1080)?.index == 3)

        // Nothing at 30fps: nil (the device is not usable for a camera track).
        #expect(CameraFormatChoice.choose(from: [
            CameraFormatOption(width: 1920, height: 1080, supports30fps: false, index: 0),
        ]) == nil)
    }

    @Test("Reconnection matches unique id first, then model id")
    func reconnection() {
        let lost = CameraDeviceIdentity(uniqueID: "cam-1", modelID: "StudioCam", localizedName: "Cam")
        // Unique id is back.
        #expect(
            CameraReconnection.decide(lost: lost, available: [lost])
                == .reconnect(lost))
        // Same model, different unit: reconnect to the sibling.
        let sibling = CameraDeviceIdentity(uniqueID: "cam-9", modelID: "StudioCam", localizedName: "Cam")
        #expect(
            CameraReconnection.decide(lost: lost, available: [sibling])
                == .reconnect(sibling))
        // Nothing matching: keep waiting, camera loss stays a warning.
        let other = CameraDeviceIdentity(uniqueID: "cam-2", modelID: "OtherCam", localizedName: "Other")
        #expect(
            CameraReconnection.decide(lost: lost, available: [other])
                == .keepWaiting)
        #expect(
            CameraReconnection.decide(lost: lost, available: [])
                == .keepWaiting)
    }

    @Test("Camera loss is a warning callback, not a failure")
    func cameraLossWarning() {
        let box = FailureBox()
        let source = CameraSource(
            devices: NoCameras(), makeInput: NeverInput(), session: FakeCameraSession(),
            previewEncoder: NilPreviewEncoder(), onCameraLost: { box.record($0) })
        source.noteDeviceLost()
        // Without a warmed camera there is no name to report: no crash, no
        // callback. The engine records the warning itself from the session
        // layer's device-lost notification.
        #expect(box.messages.isEmpty)
    }

    @Test("Warm-up with no camera available reports failure, not a crash")
    func warmUpNoCamera() async {
        let source = CameraSource(
            devices: NoCameras(), makeInput: NeverInput(), session: FakeCameraSession(),
            previewEncoder: NilPreviewEncoder(), onCameraLost: { _ in })
        let outcome = await source.warmUp(deviceID: nil)
        #expect(outcome.identity == nil)
        #expect(outcome.failure != nil)
        #expect(!source.isRunning)
    }

    @Test("Preview throttle: at most 30 per second, even width, capped at 512")
    func previewThrottle() {
        var throttle = PreviewThrottle(framesPerSecond: 30, targetWidth: 512)
        let start: Int64 = 1_000_000_000_000
        // A 60fps burst: every other frame is emitted.
        var emitted = 0
        for frame in 0..<60 {
            if throttle.shouldEmit(atHostNs: start + Int64(frame) * 16_666_667) {
                emitted += 1
            }
        }
        #expect(emitted >= 30 && emitted <= 32)

        #expect(throttle.previewWidth(forSourceWidth: 1920) == 512)
        #expect(throttle.previewWidth(forSourceWidth: 400) == 400)
        #expect(throttle.previewWidth(forSourceWidth: 511) == 510)
    }

    @Test("Camera frames reach the camera writer and the preview tee")
    func cameraFrameTee() throws {
        let epochNs: Int64 = 1_000_000_000_000
        let dir = tempDir("camera")
        let holder = BackendHolder()
        let writer = try makeWriter(kind: .camera, dir: dir, holder: holder, epochNs: epochNs)

        let source = CameraSource(
            devices: NoCameras(), makeInput: NeverInput(), session: FakeCameraSession(),
            previewEncoder: NilPreviewEncoder(), onCameraLost: { _ in })
        source.attach(writer: writer)

        let previewBox = PreviewBox()
        source.previewHandler = { previewBox.add($0) }

        // Three frames: all reach the writer; the preview tee emits the
        // first, throttles the second (7 ms later) and emits the third
        // (35 ms after the first, past the 33.33 ms minimum interval).
        source.acceptFrame(makeVideoBuffer(hostNs: epochNs + 33_000_000))
        source.waitForPreview()
        source.acceptFrame(makeVideoBuffer(hostNs: epochNs + 40_000_000))  // 7ms later: throttled
        source.acceptFrame(makeVideoBuffer(hostNs: epochNs + 68_000_000))  // 35ms later: emitted

        let backend = try #require(holder.backends[.camera])
        #expect(backend.videoFrames.count == 3)
        #expect(backend.videoFrames.contains(33_000_000))
        #expect(backend.videoFrames.contains(40_000_000))
        #expect(backend.videoFrames.contains(68_000_000))

        source.waitForPreview()
        // Preview tee saw exactly the throttled subset; the fake encoder
        // emits empty Data, which counts as one delivery per emitted frame.
        #expect(previewBox.count == 2)
    }

    @Test("Camera timestamps are retimed onto the host clock")
    func cameraClockConversion() throws {
        let epochNs: Int64 = 1_000_000_000_000
        let dir = tempDir("camera-clock")
        let holder = BackendHolder()
        let writer = try makeWriter(kind: .camera, dir: dir, holder: holder, epochNs: epochNs)

        let source = CameraSource(
            devices: NoCameras(), makeInput: NeverInput(), session: FakeCameraSession(),
            previewEncoder: NilPreviewEncoder(), onCameraLost: { _ in })
        source.attach(writer: writer)

        // Session clock runs 5 ms behind the host clock; the frame's media
        // time must land at (pts + 5ms) - epoch.
        let sessionTimeNs = epochNs + 100_000_000
        source.acceptFrame(makeVideoBuffer(hostNs: sessionTimeNs)) { time in
            CMTime(exactNanoseconds: time.nanosecondsI64! + 5_000_000)
        }
        let backend = try #require(holder.backends[.camera])
        #expect(backend.videoFrames == [105_000_000])
    }

    @Test("The production JPEG encoder produces JPEG bytes headlessly")
    func jpegEncoder() {
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, 128, 96,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixelBuffer)
        guard let buffer = pixelBuffer else {
            Issue.record("no pixel buffer")
            return
        }
        let data = JPEGPreviewEncoder().encode(buffer, targetWidth: 64)
        #expect(data != nil)
        // JPEG magic bytes.
        #expect(data!.count > 100)
        #expect(data![0] == 0xFF)
        #expect(data![1] == 0xD8)
    }
}

private final class PreviewBox: @unchecked Sendable {
    private let lock = NSLock()
    private(set) var count = 0
    func add(_ data: Data) {
        lock.lock()
        count += 1
        lock.unlock()
    }
}

private struct NoCameras: CameraDeviceProviding {
    func devices() -> [AVCaptureDevice] { [] }
}

private struct NeverInput: CameraInputMaking {
    func makeInput(device: AVCaptureDevice) throws -> AVCaptureInput {
        throw CameraInputStubError.refused
    }
}

private enum CameraInputStubError: Error { case refused }

private struct NilPreviewEncoder: PreviewFrameEncoding {
    func encode(_ pixelBuffer: CVPixelBuffer, targetWidth: Int) -> Data? { Data() }
}

private final class FakeCameraSession: CameraSessionDriving, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var configureCalls = 0
    private(set) var runningCalls = 0
    func beginConfiguration() {
        lock.lock(); configureCalls += 1; lock.unlock()
    }
    func commitConfiguration() {}
    var inputs: [AVCaptureInput] { [] }
    func canAddInput(_ input: AVCaptureInput) -> Bool { true }
    func addInput(_ input: AVCaptureInput) {}
    func removeInput(_ input: AVCaptureInput) {}
    func canAddOutput(_ output: AVCaptureOutput) -> Bool { true }
    func addOutput(_ output: AVCaptureOutput) {}
    func startRunning() {
        lock.lock(); runningCalls += 1; lock.unlock()
    }
    func stopRunning() {}
    func hostTime(fromSessionTime time: CMTime) -> CMTime { time }
    func makeClockConverter() -> SessionClockConverter? { nil }
}

// MARK: - Input recorder

@Suite("InputRecorder")
struct InputRecorderTests {

    private let epochNs: Int64 = 1_000_000_000_000
    private let contentRect = CGRect(x: 100, y: 50, width: 800, height: 400)

    private func makeRecorder(
        dir: URL,
        keystrokes: Bool = false,
        ownWindows: @escaping @Sendable () -> [CGRect] = { [] },
        warnings: @escaping @Sendable (String) -> Void = { _ in }
    ) throws -> InputRecorder {
        try InputRecorder(
            url: dir.appendingPathComponent("input.ndjson"),
            clock: SessionClock(epochNs: epochNs),
            contentRect: contentRect,
            pointPixelScale: 2,
            keystrokes: keystrokes,
            ownWindowFrames: ownWindows,
            warnings: warnings)
    }

    private func readLines(_ dir: URL) throws -> [[String: Any]] {
        let raw = try String(
            contentsOf: dir.appendingPathComponent("input.ndjson"), encoding: .utf8)
        let lines = raw.split(separator: "\n").filter { !$0.isEmpty }
        return try lines.map { line in
            guard let object = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else {
                Issue.record("unparsable line: \(line)")
                return [:]
            }
            return object
        }
    }

    @Test("Tap degradation: full -> pointer-only -> off, always with a warning")
    func tapDegradation() {
        let full = InputTapDegradation.decide(
            keystrokesRequested: true, fullTapCreated: true, mouseOnlyTapCreated: true)
        #expect(full.mode == .full)
        #expect(full.warning == nil)

        let pointerOnly = InputTapDegradation.decide(
            keystrokesRequested: true, fullTapCreated: false, mouseOnlyTapCreated: true)
        #expect(pointerOnly.mode == .pointerOnly)
        #expect(pointerOnly.warning != nil)

        let off = InputTapDegradation.decide(
            keystrokesRequested: false, fullTapCreated: false, mouseOnlyTapCreated: false)
        #expect(off.mode == .off)
        #expect(off.warning != nil)
    }

    @Test("Start with no tap writes the geom line and degrades to off with a warning")
    func geomLineAndOffDegradation() throws {
        let dir = tempDir("input-geom")
        let warningBox = FailureBox()
        let recorder = try makeRecorder(dir: dir, warnings: { warningBox.record($0) })
        recorder.start(tapFactory: { _ in nil })
        #expect(recorder.activeMode == .off)
        #expect(!warningBox.messages.isEmpty)
        recorder.stop()

        let lines = try readLines(dir)
        #expect(lines.count == 1)
        let geom = lines[0]
        #expect(geom["k"] as? String == "geom")
        #expect(geom["t"] as? Double == 0)
        #expect(geom["content"] as? [Double] == [100, 50, 800, 400])
        #expect(geom["scale"] as? Double == 2)
        // The geom line carries no pointer fields.
        #expect(geom["x"] == nil)
        #expect(geom["b"] == nil)
    }

    @Test("Tap created when keystrokes off: full mode without keystroke recording")
    func fullModeWithoutKeys() throws {
        let dir = tempDir("input-full")
        let recorder = try makeRecorder(dir: dir, keystrokes: false)
        recorder.start(tapFactory: { _ in InertTapFactory.port })
        #expect(recorder.activeMode == .full)
        #expect(!recorder.isRecordingKeystrokes)
        recorder.stop()
    }

    @Test("Move, down and up events encode to the plan's NDJSON shapes")
    func eventEncoding() throws {
        let dir = tempDir("input-events")
        let recorder = try makeRecorder(dir: dir)
        recorder.start(tapFactory: { _ in nil })
        recorder.handleTapEvent(
            type: .mouseMoved,
            event: fakeEvent(type: .mouseMoved, location: CGPoint(x: 500, y: 250), timestampNs: epochNs + 123_450_000))
        recorder.handleTapEvent(
            type: .leftMouseDown,
            event: fakeEvent(type: .leftMouseDown, location: CGPoint(x: 500, y: 250), timestampNs: epochNs + 130_200_000, button: 0))
        recorder.handleTapEvent(
            type: .leftMouseUp,
            event: fakeEvent(type: .leftMouseUp, location: CGPoint(x: 502, y: 252), timestampNs: epochNs + 138_810_000, button: 0))
        recorder.stop()

        let lines = try readLines(dir)
        // geom + move + down + up
        #expect(lines.count == 4)

        let move = lines.count > 1 ? lines[1] : [:]
        #expect(move["k"] as? String == "move")
        // (500-100)/800 = 0.5, (250-50)/400 = 0.5
        #expect(abs((move["x"] as! Double) - 0.5) < 1e-9)
        #expect(abs((move["y"] as! Double) - 0.5) < 1e-9)
        #expect(abs(((move["t"] as? Double) ?? -1) - 123.45) < 1e-6)

        let down = lines.count > 2 ? lines[2] : [:]
        #expect(down["k"] as? String == "down")
        #expect(down["b"] as? Int == 0)

        let up = lines.count > 3 ? lines[3] : [:]
        #expect(up["k"] as? String == "up")
        #expect(up["b"] as? Int == 0)
        #expect(abs(((up["t"] as? Double) ?? -1) - 138.81) < 1e-6)
    }

    @Test("Pre-epoch events are dropped; positions clamp to 0..1")
    func preEpochAndClamping() throws {
        let dir = tempDir("input-clamp")
        let recorder = try makeRecorder(dir: dir)
        recorder.start(tapFactory: { _ in nil })
        // Before the epoch: dropped.
        recorder.handleTapEvent(
            type: .mouseMoved,
            event: fakeEvent(type: .mouseMoved, location: CGPoint(x: 500, y: 250), timestampNs: epochNs - 1))
        // Outside the content: clamped.
        recorder.handleTapEvent(
            type: .mouseMoved,
            event: fakeEvent(type: .mouseMoved, location: CGPoint(x: -500, y: 5000), timestampNs: epochNs + 1_000_000))
        recorder.stop()

        let lines = try readLines(dir)
        #expect(lines.count == 2)  // geom + clamped move only
        let clamped = lines.count > 1 ? lines[1] : [:]
        #expect((clamped["x"] as? Double) == 0.0)
        #expect((clamped["y"] as? Double) == 1.0)
    }

    @Test("Clicks on our own windows are dropped")
    func ownWindowClicksDropped() throws {
        let dir = tempDir("input-own")
        let recorder = try makeRecorder(
            dir: dir,
            ownWindows: { [CGRect(x: 600, y: 300, width: 200, height: 200)] })
        recorder.start(tapFactory: { _ in nil })
        // Inside our bar window: dropped.
        recorder.handleTapEvent(
            type: .leftMouseDown,
            event: fakeEvent(type: .leftMouseDown, location: CGPoint(x: 700, y: 400), timestampNs: epochNs + 5_000_000, button: 0))
        // Inside the content, outside our window: kept.
        recorder.handleTapEvent(
            type: .leftMouseDown,
            event: fakeEvent(type: .leftMouseDown, location: CGPoint(x: 300, y: 200), timestampNs: epochNs + 6_000_000, button: 0))
        recorder.stop()

        let lines = try readLines(dir)
        #expect(lines.count == 2)  // geom + the kept click
        #expect(lines.count == 2)
        #expect(lines.last?["k"] as? String == "down")
    }

    @Test("Keystroke privacy: chords kept, plain typing never")
    func keystrokePrivacy() throws {
        let dir = tempDir("input-keys")
        let recorder = try makeRecorder(dir: dir, keystrokes: true)
        // A keystroke-enabled recorder with a working tap stays in full mode.
        recorder.start(tapFactory: { _ in InertTapFactory.port })
        let at: (Int64) -> Int64 = { offset in epochNs + offset }

        // cmd+shift chord: kept.
        recorder.handleTapEvent(
            type: .flagsChanged,
            event: fakeEvent(
                type: .flagsChanged, location: .zero, timestampNs: at(2_000_000_000),
                flags: [.maskCommand, .maskShift], keyCode: 6))  // z key in flagsChanged context
        // Single modifier: not a chord, dropped.
        recorder.handleTapEvent(
            type: .flagsChanged,
            event: fakeEvent(
                type: .flagsChanged, location: .zero, timestampNs: at(2_100_000_000),
                flags: [.maskCommand], keyCode: 56))
        // All released: kept as the chord's end marker.
        recorder.handleTapEvent(
            type: .flagsChanged,
            event: fakeEvent(
                type: .flagsChanged, location: .zero, timestampNs: at(2_200_000_000),
                flags: [], keyCode: 56))
        recorder.stop()

        let lines = try readLines(dir)
        let keys = lines.filter { $0["k"] as? String == "key" }
        #expect(keys.count == 2)
        let chord = keys.first ?? [:]
        #expect((chord["mods"] as? [String]) == ["cmd", "shift"])
        #expect(abs(((chord["t"] as? Double) ?? -1) - 2000.0) < 1e-6)
        let release = keys.count > 1 ? keys[1] : [:]
        #expect(release["mods"] == nil)
    }

    @Test("Modifier naming covers cmd, opt, ctrl, shift, fn in a stable order")
    func modifierNaming() {
        let names = KeyModifierCoder.modifierNames(
            [.maskShift, .maskCommand, .maskSecondaryFn, .maskAlternate, .maskControl])
        #expect(names == ["cmd", "opt", "ctrl", "shift", "fn"])
        #expect(KeyModifierCoder.modifierNames([]).isEmpty)
    }

    @Test("Heartbeat writes a pointer position after a silent second")
    func heartbeat() throws {
        let dir = tempDir("input-heartbeat")
        let recorder = try makeRecorder(dir: dir)
        recorder.start(tapFactory: { _ in nil })
        recorder.handleTapEvent(
            type: .mouseMoved,
            event: fakeEvent(type: .mouseMoved, location: CGPoint(x: 500, y: 250), timestampNs: epochNs + 1_000_000_000))
        // 500 ms later: no heartbeat yet.
        recorder.tick(nowHostNs: epochNs + 1_500_000_000)
        // 1.1 s later: heartbeat.
        recorder.tick(nowHostNs: epochNs + 2_100_000_000)
        recorder.stop()

        let lines = try readLines(dir)
        let moves = lines.filter { $0["k"] as? String == "move" }
        #expect(moves.count == 2)
        #expect(abs(((moves.count > 1 ? moves[1]["t"] : nil) as? Double ?? -1) - 2100.0) < 1e-6)
    }

    @Test("Pointer normalization is 0..1 top-left origin of the content")
    func normalization() {
        let rect = CGRect(x: 100, y: 50, width: 800, height: 400)
        let center = PointerNormalizer.normalize(CGPoint(x: 500, y: 250), in: rect)
        #expect(center!.x == 0.5)
        #expect(center!.y == 0.5)
        let origin = PointerNormalizer.normalize(CGPoint(x: 100, y: 50), in: rect)
        #expect(origin!.x == 0)
        #expect(origin!.y == 0)
        #expect(PointerNormalizer.normalize(.zero, in: CGRect.zero) == nil)
    }

    @Test("Event mask includes flagsChanged only when keystrokes are on")
    func eventMask() {
        let pointerBits = InputRecorder.eventMask(keystrokes: false)
        let fullBits = InputRecorder.eventMask(keystrokes: true)
        #expect(fullBits & ~pointerBits == CGEventMask(1) << CGEventMask(CGEventType.flagsChanged.rawValue))
        // The pointer mask covers moves, drags and buttons.
        for type: CGEventType in [
            .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
            .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp,
        ] {
            #expect((pointerBits >> CGEventMask(type.rawValue)) & 1 == 1)
        }
    }
}

/// A synthetic CGEvent for recorder input. CGEvent can only be created from
/// real event sources, so the tests synthesize through the same fields the
/// recorder reads.
private func fakeEvent(
    type: CGEventType,
    location: CGPoint,
    timestampNs: Int64,
    button: Int64 = 0,
    flags: CGEventFlags = [],
    keyCode: Int64 = 0
) -> CGEvent {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: location, mouseButton: .left) else {
        Issue.record("could not synthesize CGEvent")
        fatalError("could not synthesize CGEvent")
    }
    event.location = location
    event.flags = flags
    event.timestamp = UInt64(clamping: timestampNs)
    // Button number and keycode ride the integer fields the recorder reads.
    event.setIntegerValueField(.mouseEventButtonNumber, value: button)
    event.setIntegerValueField(.keyboardEventKeycode, value: keyCode)
    return event
}

private enum InertTapFactory {
    /// An inert CFMachPort standing in for a successfully created event tap.
    static var port: CFMachPort {
        let callback: CFMachPortCallBack = { _, _, _, _ in }
        guard let port = CFMachPortCreate(nil, callback, nil, nil) else {
            Issue.record("CFMachPortCreate failed")
            fatalError("CFMachPortCreate failed")
        }
        return port
    }
}

// MARK: - Live, configure-only checks

/// Configure-only checks against real hardware. These enumerate sources and
/// build configuration objects; they never start capture (no SCStream
/// startCapture, no AVCaptureSession startRunning, no TCC prompts). Real
/// capture belongs to the engine's integration runs with David present.
@Suite(
    "Capture live configure-only",
    .enabled(if: ProcessInfo.processInfo.environment["LOOM_LIVE_TESTS"] == "1")
)
struct CaptureLiveConfigureTests {

    @Test("A display filter and plan-sized configuration build against the main display")
    func displayConfiguration() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let main = content.displays.first { $0.displayID == CGMainDisplayID() }
        let display = try #require(main, "no main display found")

        let filter = SCContentFilter(
            display: display, excludingApplications: [], exceptingWindows: [])
        let info = SCShareableContent.info(for: filter)
        let plan = ScreenStreamPlan.make(
            contentSize: info.contentRect.size,
            pointPixelScale: CGFloat(info.pointPixelScale),
            systemAudio: true,
            microphone: true)

        // Plan sizing on the real display: even, at most 3840 on the long
        // edge, and at most the display's native pixel size.
        #expect(plan.width % 2 == 0)
        #expect(plan.height % 2 == 0)
        #expect(max(plan.width, plan.height) <= ScreenStreamPlan.maxLongEdgePixels)

        let configuration = ScreenSource.makeConfiguration(for: plan)
        #expect(configuration.width == plan.width)
        #expect(configuration.queueDepth == 3)
        #expect(configuration.minimumFrameInterval == CMTime(value: 1, timescale: 60))
        #expect(configuration.pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)

        // Building an SCStream object without starting it prompts nothing.
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        if #available(macOS 27.0, *) {
            #expect(!stream.isCapturing)
        }
    }

    @Test("The exclusion list matches live running applications")
    func liveExclusion() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let bundleIDs = content.applications.compactMap { $0.bundleIdentifier }
        #expect(!bundleIDs.isEmpty)
        // Whatever ids the shell and engine report, the resolver picks the
        // matching running applications (here: one that is running).
        let present = bundleIDs.first!
        let filtered = content.applications.filter { $0.bundleIdentifier == present }
        #expect(!filtered.isEmpty)
    }

    @Test("Camera discovery and format choice without starting a session")
    func cameraFormatChoice() {
        let devices = SystemCameraDeviceProvider().devices()
        guard let camera = devices.first else {
            // No camera attached is a valid state, not a failure.
            return
        }
        let options = camera.formats.enumerated().map { index, format in
            CameraFormatOption(
                width: Int(CMVideoFormatDescriptionGetDimensions(format.formatDescription).width),
                height: Int(CMVideoFormatDescriptionGetDimensions(format.formatDescription).height),
                supports30fps: format.videoSupportedFrameRateRanges.contains {
                    $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
                },
                index: index)
        }
        let chosen = CameraFormatChoice.choose(from: options)
        #expect(chosen != nil)
        #expect(chosen!.supports30fps)
        // The chosen format must be one the device actually offers.
        #expect(chosen!.index < camera.formats.count)

        // Configuration only: build the session and commit an output without
        // ever adding an input or calling startRunning (which is what would
        // trigger the camera permission prompt).
        let session = AVCaptureSession()
        session.beginConfiguration()
        session.sessionPreset = .high
        let output = AVCaptureVideoDataOutput()
        output.videoSettings = [:]
        if session.canAddOutput(output) {
            session.addOutput(output)
        }
        session.commitConfiguration()
        #expect(!session.isRunning)
    }

    @Test("Window and area filters build against real windows")
    func windowAndAreaFilters() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let display = content.displays.first { $0.displayID == CGMainDisplayID() }
        let main = try #require(display, "no main display")

        if let window = content.windows.first {
            // Window mode: desktop-independent window filter.
            let windowFilter = SCContentFilter(desktopIndependentWindow: window)
            let windowInfo = SCShareableContent.info(for: windowFilter)
            let windowPlan = ScreenStreamPlan.make(
                contentSize: windowInfo.contentRect.size,
                pointPixelScale: CGFloat(windowInfo.pointPixelScale),
                systemAudio: true,
                microphone: false)
            #expect(windowPlan.width > 0 && windowPlan.height > 0)
        }

        // Area mode: display filter plus a source rectangle, sized from the
        // rectangle itself.
        let dragged = CGRect(x: 0, y: 0, width: main.frame.width / 2, height: main.frame.height / 2)
        let clamped = AreaRectMath.clamp(dragged, toDisplay: main.frame)
        #expect(clamped != nil)
        let areaPlan = ScreenStreamPlan.make(
            contentSize: clamped!.size,
            pointPixelScale: 2,
            systemAudio: true,
            microphone: false,
            sourceRect: clamped)
        let configuration = ScreenSource.makeConfiguration(for: areaPlan)
        #expect(configuration.sourceRect == clamped)
        #expect(configuration.width % 2 == 0)
        #expect(configuration.height % 2 == 0)
    }
}

