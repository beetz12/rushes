import AVFoundation
import CoreMedia
import Foundation
import Testing

@testable import RushCore

// MARK: - Shared fixtures

/// A catalog with fixed contents, so preflight and the session never touch
/// live device discovery.
private struct StubCatalog: SourceCataloging {
    let displayList: [DisplaySource]
    let windowList: [WindowSource]
    let cameraList: [CameraDevice]
    let microphoneList: [MicrophoneDevice]

    init(
        displays: [DisplaySource] = [
            DisplaySource(id: "display-1", name: "Built-in", widthPoints: 1512, heightPoints: 982, isMain: true),
            DisplaySource(id: "display-2", name: "Studio Display", widthPoints: 3008, heightPoints: 1692, isMain: false),
        ],
        windows: [WindowSource] = [
            WindowSource(id: "window-77", title: "Plan", owningApplication: "com.example", displayID: "display-1"),
        ],
        cameras: [CameraDevice] = [
            CameraDevice(id: "dev-facecam", name: "FaceTime HD Camera"),
        ],
        microphones: [MicrophoneDevice] = [
            MicrophoneDevice(id: "dev-mic", name: "MacBook Pro Microphone"),
        ]
    ) {
        self.displayList = displays
        self.windowList = windows
        self.cameraList = cameras
        self.microphoneList = microphones
    }

    func displays() async throws -> [DisplaySource] { displayList }
    func windows() async throws -> [WindowSource] { windowList }
    func cameras() async throws -> [CameraDevice] { cameraList }
    func microphones() async throws -> [MicrophoneDevice] { microphoneList }
}

/// A controllable host clock, so a whole take runs on a synthetic timeline
/// with no wall-clock sleeps.
private final class FakeHostClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64

    init(_ value: Int64) {
        self.value = value
    }

    var now: Int64 {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ value: Int64) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func advance(_ nanoseconds: Int64) {
        lock.lock()
        value += nanoseconds
        lock.unlock()
    }
}

private func tempRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("session-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

private let hugeVolume = VolumeInfo(availableBytes: 100 * 1024 * 1024 * 1024)

// MARK: - Synthetic media (same technique as TrackWriterTests)

/// One NV12 video frame at a host time, 320x240, 30 fps timing.
private func makeVideoBuffer(hostNs: Int64) -> CMSampleBuffer {
    var pixelBuffer: CVPixelBuffer?
    CVPixelBufferCreate(
        kCFAllocatorDefault, 320, 240,
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

/// One buffer of 1024 mono Float32 PCM samples at 48 kHz, a quiet sine,
/// stamped at a host time.
private func makeAudioBuffer(hostNs: Int64) -> CMSampleBuffer {
    let frames = 1024
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
        floats[i] = 0.5 * sin(2 * Float.pi * 440 * t)
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

/// Builds writers with H.264 preferred for video, so the suite runs
/// headless without depending on a hardware HEVC encoder.
private func h264WriterOpener(
    _ configuration: TrackWriterConfiguration, _ clock: SessionClock
) throws -> TrackWriter {
    guard configuration.kind.carriesVideo else {
        return try TrackWriter(configuration: configuration, clock: clock)
    }
    let h264 = TrackWriterConfiguration(
        kind: configuration.kind,
        outputURL: configuration.outputURL,
        videoWidth: configuration.videoWidth,
        videoHeight: configuration.videoHeight,
        preferredVideoCodec: .h264,
        fragmentIntervalSeconds: configuration.fragmentIntervalSeconds,
        maxPendingVideoFrames: configuration.maxPendingVideoFrames,
        audioGapThresholdNs: configuration.audioGapThresholdNs)
    return try TrackWriter(configuration: h264, clock: clock)
}

private func screenMicRequest(
    display id: String = "display-1", title: String? = "Session test"
) -> SessionRequest {
    SessionRequest(
        screen: .display(id: id),
        screenDimensions: .init(width: 320, height: 240),
        microphoneId: "dev-mic",
        countdownSeconds: 0,
        title: title)
}

// MARK: - Preflight

@Suite("Session preflight")
struct SessionPreflightTests {

    @Test("Low disk refuses the start with low-disk")
    func lowDiskRefusal() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(),
            outputRoot: root,
            volume: VolumeInfo(availableBytes: 500 * 1024 * 1024))
        let result = await preflight.run(request: screenMicRequest())
        #expect(!result.ok)
        #expect(result.failureCode == .lowDisk)
        #expect(result.effectiveRequest == nil)
    }

    @Test("An unknown screen source refuses with unknown-source")
    func unknownSourceRefusal() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(request: screenMicRequest(display: "display-99"))
        #expect(!result.ok)
        #expect(result.failureCode == .unknownSource)
    }

    @Test("An unknown window id also refuses with unknown-source")
    func unknownWindowRefusal() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(
            request: SessionRequest(
                screen: .window(id: "window-404"),
                screenDimensions: .init(width: 640, height: 480)))
        #expect(!result.ok)
        #expect(result.failureCode == .unknownSource)
    }

    @Test("An already-active recording refuses with already-active")
    func alreadyActiveRefusal() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume,
            alreadyActive: true)
        let result = await preflight.run(request: screenMicRequest())
        #expect(!result.ok)
        #expect(result.failureCode == .alreadyActive)
    }

    @Test("A missing optional device is dropped with a warning, not a refusal")
    func unknownOptionalDeviceDropped() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(
            request: SessionRequest(
                screen: .display(id: "display-1"),
                screenDimensions: .init(width: 320, height: 240),
                cameraId: "dev-missing-cam",
                microphoneId: "dev-mic"))
        #expect(result.ok)
        #expect(result.warnings.map(\.code).contains("camera-not-found"))
        #expect(result.effectiveRequest?.cameraId == nil)
        #expect(result.effectiveRequest?.microphoneId == "dev-mic")
        // The resolved microphone name is carried for the manifest.
        #expect(result.resolvedDeviceNames["dev-mic"] == "MacBook Pro Microphone")
    }

    @Test("Denied screen permission refuses; denied camera permission only drops the camera")
    func permissionPolicy() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let denied = PermissionAdvisor(check: { kind in
            PermissionStatus(state: kind == .screen ? .denied : .allowed)
        })
        let deniedResult = await Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume,
            permissionAdvisor: denied
        ).run(request: screenMicRequest())
        #expect(!deniedResult.ok)
        #expect(deniedResult.failureCode == .permissionDenied)

        let notAsked = PermissionAdvisor(check: { kind in
            PermissionStatus(state: kind == .screen ? .notAsked : .allowed)
        })
        let notAskedResult = await Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume,
            permissionAdvisor: notAsked
        ).run(request: screenMicRequest())
        #expect(!notAskedResult.ok)
        #expect(notAskedResult.failureCode == .permissionNotAsked)

        let cameraDenied = PermissionAdvisor(check: { kind in
            PermissionStatus(state: kind == .camera ? .denied : .allowed)
        })
        let cameraResult = await Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume,
            permissionAdvisor: cameraDenied
        ).run(
            request: SessionRequest(
                screen: .display(id: "display-1"),
                screenDimensions: .init(width: 320, height: 240),
                cameraId: "dev-facecam"))
        #expect(cameraResult.ok)
        #expect(cameraResult.warnings.map(\.code).contains("camera-off-permission"))
        #expect(cameraResult.effectiveRequest?.cameraId == nil)
    }

    @Test("A read-only output root refuses with output-not-writable")
    func unwritableRootRefusal() async {
        let root = try! tempRoot()
        defer {
            chmod(root.path, 0o700)
            try? FileManager.default.removeItem(at: root)
        }
        chmod(root.path, 0o500)
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(request: screenMicRequest())
        #expect(!result.ok)
        #expect(result.failureCode == .outputNotWritable)
    }

    @Test("A camera-only take whose camera is dropped has nothing to record")
    func nothingToRecord() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(
            request: SessionRequest(cameraId: "dev-gone"))
        #expect(!result.ok)
        #expect(result.failureCode == .nothingToRecord)
    }

    @Test("A screen request without dimensions is invalid")
    func invalidRequestRefusal() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(
            request: SessionRequest(screen: .display(id: "display-1")))
        #expect(!result.ok)
        #expect(result.failureCode == .invalidRequest)
    }

    @Test("A healthy request passes every check")
    func healthyPass() async {
        let root = try! tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let preflight = Preflight(
            catalog: StubCatalog(), outputRoot: root, volume: hugeVolume)
        let result = await preflight.run(
            request: SessionRequest(
                screen: .window(id: "window-77"),
                screenDimensions: .init(width: 640, height: 480),
                cameraId: "dev-facecam",
                microphoneId: "dev-mic",
                systemAudio: true))
        #expect(result.ok)
        #expect(result.warnings.isEmpty)
        #expect(result.effectiveRequest?.trackKinds == [.screen, .camera, .microphone, .systemAudio])
        #expect(result.checks.allSatisfy {
            if case .ok = $0.outcome { return true }
            return false
        })
    }
}

// MARK: - RecordingSession

@Suite("RecordingSession")
struct RecordingSessionTests {

    private func makeSession(
        root: URL,
        clock: FakeHostClock,
        catalog: SourceCataloging = StubCatalog(),
        volume: VolumeInfo = hugeVolume,
        opener: TrackWriterOpener? = h264WriterOpener
    ) -> RecordingSession {
        RecordingSession(
            outputRoot: root,
            catalog: catalog,
            volumeProvider: { _ in volume },
            hostNowNs: { clock.now },
            makeWriter: opener ?? { configuration, clock in
                try TrackWriter(configuration: configuration, clock: clock)
            })
    }

    @Test("Record, pause, resume, stop: complete package that verifies")
    func happyPathRecordPauseResumeStop() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(1_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        let request = screenMicRequest()

        let package = try await session.start(request)
        #expect(await session.state == .armed)
        #expect(request.trackKinds == [.screen, .microphone])

        let epoch = try await session.openGate()
        #expect(epoch == hostClock.now)
        #expect(await session.state == .recording)

        let second: Int64 = 1_000_000_000
        let frameNs: Int64 = 33_333_333
        let bufferNs = Int64(Double(1024) / 48_000 * 1e9)

        // Live media [0, 1) s: video at 30 fps, contiguous audio buffers at
        // their natural 1024-sample cadence.
        var videoHost = epoch
        while videoHost < epoch + second {
            session.appendVideo(makeVideoBuffer(hostNs: videoHost), for: .screen)
            videoHost += frameNs
        }
        var audioHost = epoch
        while audioHost < epoch + second {
            session.appendAudio(makeAudioBuffer(hostNs: audioHost), for: .microphone)
            audioHost += bufferNs
        }
        hostClock.set(epoch + second)

        // One second of wall time paused: nothing is appended in the window.
        try await session.pause()
        #expect(await session.state == .paused)

        hostClock.set(epoch + 2 * second)
        try await session.resume()
        #expect(await session.state == .recording)

        // Live media [1, 2) s on the media clock.
        videoHost = epoch + 2 * second
        while videoHost < epoch + 3 * second {
            session.appendVideo(makeVideoBuffer(hostNs: videoHost), for: .screen)
            videoHost += frameNs
        }
        audioHost = epoch + 2 * second
        while audioHost < epoch + 3 * second {
            session.appendAudio(makeAudioBuffer(hostNs: audioHost), for: .microphone)
            audioHost += bufferNs
        }
        hostClock.set(epoch + 3 * second)

        // Elapsed media time froze through the pause: 3 s wall minus 1 s.
        let midSnapshot = await session.snapshot()
        #expect(midSnapshot.state == .recording)
        #expect(midSnapshot.elapsedMediaNs == 2 * second)

        let outcome = try await session.stop()
        #expect(outcome.status == .complete)
        #expect(outcome.durationNs == 2 * second)
        #expect(outcome.tracks.count == 2)
        #expect(outcome.tracks.allSatisfy { $0.finalizeState == .finalized })
        #expect(await session.state == .complete)

        // Manifest on disk: complete, the pause recorded, tracks present.
        let manifest = try package.readManifest()
        #expect(manifest.status == .complete)
        #expect(manifest.clock?.pausesNs == [[epoch + second, epoch + 2 * second]])
        #expect(manifest.clock?.durationNs == 2 * second)
        #expect(manifest.startedHostNs == epoch)
        #expect(manifest.endedHostNs == epoch + 3 * second)
        #expect(manifest.sources?.displayId == "display-1")
        #expect(manifest.sources?.microphoneId == "dev-mic")
        #expect(manifest.tracks.count == 2)
        #expect(manifest.tracks.allSatisfy { $0.present })
        #expect(manifest.verified == nil)

        // The decode test passes on the result.
        let report = await PackageVerifier().verify(package)
        #expect(report.ok)
        #expect(report.trackChecks.count == 2)
        for check in report.trackChecks {
            #expect(check.ok)
            #expect(check.issues.isEmpty)
        }

        // The session log holds parseable state-change and warning lines.
        let logText = try String(contentsOf: package.logURL, encoding: .utf8)
        let lines = logText.split(separator: "\n").filter { !$0.isEmpty }
        #expect(lines.count >= 6)
        for line in lines {
            _ = try JSONSerialization.jsonObject(with: Data(line.utf8))
        }
        #expect(logText.contains("\"event\":\"state\""))
        #expect(logText.contains("\"to\":\"recording\""))
        #expect(logText.contains("\"to\":\"paused\""))
    }

    @Test("The manifest on disk says recording mid-session, with the epoch after the gate")
    func manifestOnDiskIsRecordingMidSession() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(5_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)

        let package = try await session.start(screenMicRequest())
        // Behind the gate: status recording, tracks declared, no epoch yet.
        var manifest = try package.readManifest()
        #expect(manifest.status == .recording)
        #expect(manifest.tracks.count == 2)
        #expect(manifest.clock == nil)

        let epoch = try await session.openGate()
        manifest = try package.readManifest()
        #expect(manifest.status == .recording)
        #expect(manifest.clock?.epochHostNs == epoch)

        _ = try await session.stop()
        manifest = try package.readManifest()
        #expect(manifest.status == .failed)  // nothing was appended
    }

    @Test("Pausing twice and resuming without a pause are rejected")
    func pauseResumeGuards() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(7_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)

        // Stop before any start is rejected too.
        await #expect(throws: SessionError.self) {
            _ = try await session.stop()
        }

        _ = try await session.start(screenMicRequest())
        _ = try await session.openGate()

        // Resume without a pause.
        await #expect(throws: SessionError.self) {
            try await session.resume()
        }
        try await session.pause()
        // Pause twice.
        await #expect(throws: SessionError.self) {
            try await session.pause()
        }
        hostClock.advance(500_000_000)
        try await session.resume()
        // Resume twice.
        await #expect(throws: SessionError.self) {
            try await session.resume()
        }
        _ = try await session.stop()
        #expect(await session.state == .failed)  // no samples were appended
    }

    @Test("A writer failing at start fails the session and keeps the package")
    func writerStartFailureKeepsPackage() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(9_000_000_000_000)
        let session = makeSession(
            root: root,
            clock: hostClock,
            opener: { configuration, clock in
                if configuration.kind == .camera {
                    throw TrackWriterError.writerFailedToStart(
                        codec: configuration.preferredVideoCodec.rawValue,
                        reason: "injected camera failure")
                }
                return try h264WriterOpener(configuration, clock)
            })

        let request = SessionRequest(
            screen: .display(id: "display-1"),
            screenDimensions: .init(width: 320, height: 240),
            cameraId: "dev-facecam",
            microphoneId: "dev-mic")

        await #expect(throws: SessionError.self) {
            _ = try await session.start(request)
        }
        #expect(await session.state == .failed)

        // The package exists, its manifest says failed, nothing was deleted.
        let snapshot = await session.snapshot()
        #expect(snapshot.state == .failed)
        let packagePath = try #require(snapshot.packagePath)
        var isDirectory: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: packagePath, isDirectory: &isDirectory))
        #expect(isDirectory.boolValue)

        let manifestURL = URL(fileURLWithPath: packagePath)
            .appendingPathComponent("manifest.json")
        let manifest = try RecordingManifest.parse(try Data(contentsOf: manifestURL))
        #expect(manifest.status == .failed)
        #expect(manifest.warnings.map(\.code).contains("writer-failed-to-start"))
    }

    @Test("A second start on the same session is refused as already active")
    func secondStartRefused() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(3_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        _ = try await session.start(screenMicRequest())
        do {
            _ = try await session.start(screenMicRequest())
            Issue.record("second start should have thrown")
        } catch let error as SessionError {
            guard case .preflightFailed(let code, _) = error else {
                Issue.record("expected preflightFailed, got \(error)")
                return
            }
            #expect(code == .alreadyActive)
        }
        _ = try await session.stop()
    }

    @Test("Preflight refusals surface through start with their code")
    func lowDiskRefusalThroughSession() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(2_000_000_000_000)
        let session = makeSession(
            root: root, clock: hostClock,
            volume: VolumeInfo(availableBytes: 100 * 1024 * 1024))
        do {
            _ = try await session.start(screenMicRequest())
            Issue.record("start should have thrown")
        } catch let error as SessionError {
            guard case .preflightFailed(let code, _) = error else {
                Issue.record("expected preflightFailed, got \(error)")
                return
            }
            #expect(code == .lowDisk)
        }
        #expect(await session.state == .failed)
        // No package was created for a refused start.
        #expect(await session.snapshot().packagePath == nil)
    }

    @Test("stopEarly finalizes footage with an ended-early warning")
    func stopEarlyKeepsFootage() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(11_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        let package = try await session.start(screenMicRequest())
        let epoch = try await session.openGate()

        let second: Int64 = 1_000_000_000
        var videoHost = epoch
        while videoHost < epoch + second {
            session.appendVideo(makeVideoBuffer(hostNs: videoHost), for: .screen)
            videoHost += 33_333_333
        }
        var audioHost = epoch
        while audioHost < epoch + second {
            session.appendAudio(makeAudioBuffer(hostNs: audioHost), for: .microphone)
            audioHost += Int64(Double(1024) / 48_000 * 1e9)
        }
        hostClock.set(epoch + second)

        let outcome = try await session.stopEarly(
            code: "stream-error", message: "the display went away")
        #expect(outcome.status == .complete)
        #expect(outcome.durationNs == second)

        let manifest = try package.readManifest()
        #expect(manifest.status == .complete)
        let codes = manifest.warnings.map(\.code)
        #expect(codes.contains("ended-early"))
        #expect(outcome.warnings.contains {
            $0.code == "ended-early" && $0.message?.contains("stream-error") == true
        })
        #expect(manifest.tracks.allSatisfy { $0.present })
    }

    @Test("recordWarning lands in the manifest and the log")
    func warningsAccumulate() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(13_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        let package = try await session.start(screenMicRequest())
        let epoch = try await session.openGate()

        hostClock.set(epoch + 1_500_000_000)
        await session.recordWarning(code: "mic-silent", message: "near digital silence")
        hostClock.set(epoch + 2_000_000_000)
        await session.recordWarning(code: "camera-lost")

        var manifest = try package.readManifest()
        #expect(manifest.warnings.map(\.code) == ["mic-silent", "camera-lost"])
        #expect(manifest.warnings.first?.atMs == 1_500)

        _ = try await session.stop()
        manifest = try package.readManifest()
        #expect(manifest.warnings.map(\.code).starts(with: ["mic-silent", "camera-lost"]))

        let logText = try String(contentsOf: package.logURL, encoding: .utf8)
        #expect(logText.contains("\"event\":\"warning\""))
        #expect(logText.contains("\"code\":\"mic-silent\""))
    }

    @Test("SessionSnapshot round-trips through JSON")
    func snapshotCodableRoundTrip() async throws {
        let snapshot = SessionSnapshot(
            state: .recording,
            recordingID: "01JA3K7Q2V9W8X6Y5Z4T3S2R1P",
            packagePath: "/tmp/rushes/example",
            epochHostNs: 123_456_789,
            elapsedMediaNs: 4_000_000_000,
            paused: false,
            warnings: [RecordingManifest.ManifestWarning(code: "camera-lost", atMs: 1512)],
            tracks: [
                TrackWriterStatus(
                    kind: .screen, framesWritten: 240, silenceFramesWritten: 0,
                    framesDropped: 3, firstMediaTimeNs: 0, lastMediaTimeNs: 4_000_000_000,
                    pendingDepth: 0, usedFallbackCodec: false, finalizeState: .idle,
                    errorDescription: nil)
            ])
        let data = try JSONEncoder().encode(snapshot)
        let decoded = try JSONDecoder().decode(SessionSnapshot.self, from: data)
        #expect(decoded == snapshot)
    }

    @Test("A live snapshot mid-recording carries state, epoch, elapsed and tracks")
    func liveSnapshot() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(17_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        _ = try await session.start(screenMicRequest())
        let epoch = try await session.openGate()

        hostClock.set(epoch + 750_000_000)
        let snapshot = await session.snapshot()
        #expect(snapshot.state == .recording)
        #expect(snapshot.epochHostNs == epoch)
        #expect(snapshot.elapsedMediaNs == 750_000_000)
        #expect(snapshot.paused == false)
        #expect(snapshot.tracks.count == 2)
        #expect(snapshot.tracks.map(\.kind) == [.screen, .microphone])
        #expect(snapshot.recordingID?.count == 26)

        hostClock.set(epoch + 1_000_000_000)
        try await session.pause()
        let pausedSnapshot = await session.snapshot()
        #expect(pausedSnapshot.paused == true)
        #expect(pausedSnapshot.state == .paused)
        // Elapsed media time froze at the pause.
        #expect(pausedSnapshot.elapsedMediaNs == 1_000_000_000)
        hostClock.set(epoch + 2_000_000_000)
        #expect((await session.snapshot()).elapsedMediaNs == 1_000_000_000)

        _ = try await session.stop()
    }

    @Test("trackWriter(for:) exposes the writer capture should forward to")
    func trackWriterAccess() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(19_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        _ = try await session.start(screenMicRequest())
        let epoch = try await session.openGate()

        let screenWriter = await session.trackWriter(for: .screen)
        #expect(screenWriter != nil)
        #expect(screenWriter?.configuration.kind == .screen)
        #expect(await session.trackWriter(for: .camera) == nil)

        screenWriter?.appendVideo(makeVideoBuffer(hostNs: epoch))
        let status = screenWriter?.status()
        #expect(status?.framesWritten == 1)

        _ = try await session.stop()
    }

    @Test("Stopping from armed (countdown cancelled) fails with the empty package kept")
    func stopFromArmed() async throws {
        let root = try tempRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let hostClock = FakeHostClock(23_000_000_000_000)
        let session = makeSession(root: root, clock: hostClock)
        let package = try await session.start(screenMicRequest())

        let outcome = try await session.stop()
        #expect(outcome.status == .failed)
        #expect(outcome.durationNs == nil)
        #expect(await session.state == .failed)

        let manifest = try package.readManifest()
        #expect(manifest.status == .failed)
        #expect(manifest.warnings.map(\.code).contains("track-empty"))
        // The package folder was kept.
        var isDirectory: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: package.folderURL.path, isDirectory: &isDirectory))
    }
}
