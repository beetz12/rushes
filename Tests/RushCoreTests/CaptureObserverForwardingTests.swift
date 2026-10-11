import AVFoundation
import CoreMedia
import CoreVideo
import Dispatch
import Foundation
import Testing
@testable import RushCore

private struct ObserverFixtureCatalog: SourceCataloging {
    func displays() async throws -> [DisplaySource] { [] }
    func windows() async throws -> [WindowSource] { [] }
    func cameras() async throws -> [CameraDevice] { [] }
    func microphones() async throws -> [MicrophoneDevice] {
        [.init(id: "fixture-mic", name: "Synthetic fixture microphone")]
    }
}
private final class ObserverFixtureClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Int64 = 1_000_000_000_000
    func now() -> Int64 { lock.withLock { value } }
    func advance(_ ns: Int64) { lock.withLock { value += ns } }
}
private final class ObserverFixtureSamples: @unchecked Sendable {
    private let lock = NSLock()
    private var samples: [(Int64?, Int64?)] = []
    func accept(_ sample: CMSampleBuffer, _ time: CMTime) {
        lock.withLock { samples.append((time.nanosecondsI64, CMSampleBufferGetPresentationTimeStamp(sample).nanosecondsI64)) }
    }
    func times() -> [Int64?] { lock.withLock { samples.map(\.0) } }
    func packetTimes() -> [Int64?] { lock.withLock { samples.map(\.1) } }
}
private struct PreviewFixtureNoDevices: CameraDeviceProviding {
    func devices() -> [AVCaptureDevice] { Issue.record("preview transform must not discover devices"); return [] }
}
private struct PreviewFixtureNoInputs: CameraInputMaking {
    func makeInput(device: AVCaptureDevice) throws -> AVCaptureInput {
        throw ControlFailure(code: "fixture", message: "no device inputs in preview test")
    }
}
private final class PreviewFixtureSession: CameraSessionDriving {
    func beginConfiguration() { Issue.record("no session configuration expected") }
    func commitConfiguration() { Issue.record("no session configuration expected") }
    var inputs: [AVCaptureInput] { [] }
    func canAddInput(_ input: AVCaptureInput) -> Bool { false }
    func addInput(_ input: AVCaptureInput) { Issue.record("no device input expected") }
    func removeInput(_ input: AVCaptureInput) { Issue.record("no device input expected") }
    func canAddOutput(_ output: AVCaptureOutput) -> Bool { false }
    func addOutput(_ output: AVCaptureOutput) { Issue.record("no session output expected") }
    func startRunning() { Issue.record("preview transform must not start a device") }
    func stopRunning() { Issue.record("preview transform must not stop a device") }
    func hostTime(fromSessionTime time: CMTime) -> CMTime { time }
    func makeClockConverter() -> SessionClockConverter? { nil }
}
private final class PreviewFixtureEncoder: PreviewFrameEncoding, @unchecked Sendable {
    let began = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var calls = 0
    private var delivered = 0
    func encode(_ pixelBuffer: CVPixelBuffer, targetWidth: Int) -> Data? {
        let first = lock.withLock { calls += 1; return calls == 1 }
        if first {
            began.signal()
            guard release.wait(timeout: .now() + 2) == .success else { Issue.record("fixture encoder timed out"); return nil }
        }
        return Data([1])
    }
    func received(_ bytes: Data) { lock.withLock { delivered += 1 } }
    func counts() -> (encoded: Int, delivered: Int) { lock.withLock { (calls, delivered) } }
}

@Suite("Capture observer forwarding without devices")
struct CaptureObserverForwardingTests {
    @Test("Enabling privacy suppresses an in-flight raw JPEG and nil transform output")
    func previewPrivacyGeneration() throws {
        let encoder = PreviewFixtureEncoder()
        let source = CameraSource(devices: PreviewFixtureNoDevices(), makeInput: PreviewFixtureNoInputs(),
                                  session: PreviewFixtureSession(), previewEncoder: encoder, onCameraLost: { _ in })
        source.previewHandler = { encoder.received($0) }
        let epoch: Int64 = 1_000_000_000_000
        func frame(_ offset: Int64) throws -> CMSampleBuffer {
            try #require(SyntheticMedia.videoBuffer(width: 32, height: 24, hostNs: epoch + offset))
        }
        defer { encoder.release.signal() }
        source.acceptFrame(try frame(0))
        try #require(encoder.began.wait(timeout: .now() + 2) == .success)
        source.setPreviewTransform { _ in nil }
        encoder.release.signal()
        source.waitForPreview()
        #expect(encoder.counts().delivered == 0)
        source.acceptFrame(try frame(40_000_000))
        source.waitForPreview()
        #expect(encoder.counts().encoded == 1)
        #expect(encoder.counts().delivered == 0)
        source.setPreviewTransform { $0 }
        source.acceptFrame(try frame(80_000_000))
        source.waitForPreview()
        #expect(encoder.counts().delivered == 1)
        #expect(!source.isRunning)
    }

    @Test("Attached microphone observer uses the writer's pause and mute clock")
    func microphoneObserver() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("observer-fixture-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clock = ObserverFixtureClock()
        let observed = ObserverFixtureSamples()
        let session = RecordingSession(outputRoot: root, catalog: ObserverFixtureCatalog(),
                                       volumeProvider: { _ in .init(availableBytes: 100 * 1024 * 1024 * 1024) },
                                       hostNowNs: { clock.now() })
        let request = SessionRequest(microphoneId: "fixture-mic", countdownSeconds: 0)
        let package = try await session.start(request)
        let rig = try await StubCaptureRigFactory().attach(.init(session: session, request: request, package: package,
                                                                 microphoneObserver: { sample, time in observed.accept(sample, time) },
                                                                 warning: { _, _ in }, streamFailure: { _ in }))
        let epoch = try await session.openGate()
        let writer = try #require(await session.trackWriter(for: .microphone))
        func append(_ offset: Int64) throws {
            let buffer = try #require(SyntheticMedia.audioBuffer(channels: 1, hostNs: epoch + offset))
            session.appendAudio(buffer, for: .microphone)
        }
        try append(20_000_000)
        writer.setMuted(true)
        try append(50_000_000)
        writer.setMuted(false)
        clock.advance(75_000_000)
        try await session.pause()
        try append(90_000_000)
        clock.advance(30_000_000)
        try await session.resume()
        try append(120_000_000)
        #expect(observed.times() == [20_000_000, 90_000_000])
        #expect(observed.packetTimes() == [20_000_000, 90_000_000])
        // The stub pump was never opened; only explicit synthetic PCM above
        // flowed, so stop does not invent wall-clock samples in this fixture.
        await rig.stop()
        clock.advance(35_000_000)
        #expect(try await session.stop().status == .complete)
    }
}
