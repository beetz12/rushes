import Foundation
import CoreMedia
import Testing
@testable import RushCore

@Suite("Preview lifetime tokens")
struct PreviewLifetimeTests {
    @Test("A superseded source callback is rejected before publication; its already queued wire event keeps its old token")
    func sourceAndWireEpochs() throws {
        let publication = PreviewPublication(), collector = EventCollector()
        publication.setSink { collector.append($0) }
        publication.setEnabled(true)
        publication.activate("old-source")
        publication.publish(Data([1]), token: "old-source")
        let queued = try #require(collector.all().first)
        let queuedWire = try ControlWire.line(queued)
        publication.activate("new-source")
        publication.publish(Data([2]), token: "old-source")
        publication.publish(Data([3]), token: "new-source")
        #expect(collector.all().count == 2)
        #expect(collector.all().last?.result?["previewToken"]?.string == "new-source")
        let deliveredAfterNewAck = try JSONDecoder().decode(ControlEvent.self, from: queuedWire)
        #expect(deliveredAfterNewAck.result?["previewToken"]?.string == "old-source")
        #expect(deliveredAfterNewAck.result?["jpeg"]?.string == "AQ==")
    }

    @Test("Subscription disables publication without changing the source token; old cleanup cannot invalidate a new source")
    func subscriptionAndCleanup() {
        let publication = PreviewPublication(), collector = EventCollector()
        publication.setSink { collector.append($0) }
        publication.activate("recording-camera")
        publication.publish(Data([1]), token: "recording-camera")
        #expect(collector.all().isEmpty)
        publication.setEnabled(true)
        publication.publish(Data([2]), token: "recording-camera")
        publication.setEnabled(false)
        publication.publish(Data([3]), token: "recording-camera")
        #expect(collector.all().count == 1)
        #expect(publication.currentToken == "recording-camera")
        publication.activate("next-camera")
        publication.invalidate("recording-camera")
        #expect(publication.currentToken == "next-camera")
        publication.invalidate()
        #expect(publication.currentToken == nil)
        publication.setEnabled(true)
        publication.publish(Data([4]), token: "next-camera")
        #expect(collector.all().count == 1)
    }

    @Test("Idle warm acknowledgments and JPEGs share a token, and switching cameras supersedes the old publisher")
    func idleWarmAndSwitch() async throws {
        let fixture = try TokenControllerFixture()
        defer { fixture.removeFiles() }
        await fixture.command("camera.preview.start", ["camera": .string("fixture-a")])
        let old = try #require(fixture.exchange.lastResponse?.result?["previewToken"]?.string)
        #expect(UUID(uuidString: old) != nil)
        await fixture.factory.publishWarm(0, bytes: Data([1]))
        #expect(fixture.exchange.events.last?.result?["previewToken"]?.string == old)
        await fixture.command("camera.preview.start", ["camera": .string("fixture-b")])
        let new = try #require(fixture.exchange.lastResponse?.result?["previewToken"]?.string)
        #expect(new != old)
        let count = fixture.exchange.events.count
        await fixture.factory.publishWarm(0, bytes: Data([2]))
        #expect(fixture.exchange.events.count == count)
        await fixture.factory.publishWarm(1, bytes: Data([3]))
        #expect(fixture.exchange.events.last?.result?["previewToken"]?.string == new)
        await fixture.command("camera.preview.stop")
        let closed = fixture.exchange.events.count
        await fixture.factory.publishWarm(1, bytes: Data([4]))
        #expect(fixture.exchange.events.count == closed)
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        #expect(fixture.exchange.lastResponse?.result?["previewToken"] == .null)
        _ = await fixture.controller.shutdown()
    }

    @Test("A failed warm has no usable acknowledgment or token and cannot publish its queued source callback")
    func failedWarm() async throws {
        let fixture = try TokenControllerFixture()
        defer { fixture.removeFiles() }
        await fixture.factory.failNextWarm()
        await fixture.command("camera.preview.start", ["camera": .string("fixture-a")])
        #expect(fixture.exchange.lastResponse?.ok == false)
        await fixture.factory.publishWarm(0, bytes: Data([1]))
        #expect(!fixture.exchange.events.contains { $0.event == "camera-preview" })
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        #expect(fixture.exchange.lastResponse?.result?["previewToken"] == .null)
        _ = await fixture.controller.shutdown()
    }

    @Test("A warm acknowledgment returning after idle owner loss is canceled and its source never revives")
    func delayedWarmAfterOwnerLoss() async throws {
        let fixture = try TokenControllerFixture()
        defer { fixture.removeFiles() }
        await fixture.factory.parkNextWarm()
        let pending = Task { await fixture.command("camera.preview.start", ["camera": .string("fixture-a")]) }
        try await fixture.waitForWarm()
        await fixture.controller.clientDisconnected("preview-fixture")
        await fixture.factory.publishWarm(0, bytes: Data([1]))
        await fixture.factory.releaseWarm()
        await pending.value
        #expect(fixture.exchange.lastResponse?.error?.code == "cancelled")
        #expect(!fixture.exchange.events.contains { $0.event == "camera-preview" })
        _ = await fixture.controller.shutdown()
    }

    @Test("Recording subscription acknowledges the rig token without warming, stopping or shifting its clock")
    func recordingSubscription() async throws {
        let fixture = try TokenControllerFixture()
        defer { fixture.removeFiles() }
        await fixture.command("camera.preview.start", ["camera": .string("fixture-a")])
        let idleToken = try #require(fixture.exchange.lastResponse?.result?["previewToken"]?.string)
        await fixture.command("camera.preview.stop")
        await fixture.command("record.start", ["camera": .string("fixture-a"), "mic": .string("none"), "countdownSeconds": .int(0)])
        #expect(fixture.exchange.lastResponse?.ok == true)
        let warmCount = await fixture.factory.warmCount
        let closeCount = await fixture.factory.stopCount
        let epoch = await fixture.factory.gateEpoch
        #expect(epoch != nil)
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        let rigToken = try #require(fixture.exchange.lastResponse?.result?["previewToken"]?.string)
        #expect(rigToken != idleToken)
        let before = fixture.exchange.events.count
        await fixture.factory.publishWarm(0, bytes: Data([1]))
        #expect(fixture.exchange.events.count == before)
        await fixture.factory.publishRig(Data([2]))
        #expect(fixture.exchange.events.last?.result?["previewToken"]?.string == rigToken)
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(false)])
        let hidden = fixture.exchange.events.count
        await fixture.factory.publishRig(Data([3]))
        #expect(fixture.exchange.events.count == hidden)
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        #expect(fixture.exchange.lastResponse?.result?["previewToken"]?.string == rigToken)
        #expect(await fixture.factory.warmCount == warmCount)
        #expect(await fixture.factory.stopCount == closeCount)
        #expect(await fixture.factory.gateEpoch == epoch)
        _ = await fixture.controller.shutdown()
        let closed = fixture.exchange.events.count
        await fixture.factory.publishRig(Data([4]))
        #expect(fixture.exchange.events.count == closed)
    }

    @Test("Cancel during a parked recording attach invalidates that publisher before its eventual acknowledgment")
    func canceledRecordingAttach() async throws {
        let fixture = try TokenControllerFixture()
        defer { fixture.removeFiles() }
        await fixture.factory.parkNextAttach()
        let pending = Task { await fixture.command("record.start", ["camera": .string("fixture-a"), "mic": .string("none"), "countdownSeconds": .int(0)]) }
        try await fixture.waitForAttach()
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        let canceledToken = try #require(fixture.exchange.lastResponse?.result?["previewToken"]?.string)
        await fixture.command("record.cancel")
        let count = fixture.exchange.events.count
        await fixture.factory.publishRig(Data([1]))
        #expect(fixture.exchange.events.count == count)
        await fixture.factory.releaseAttach()
        await pending.value
        #expect(fixture.exchange.lastResponse?.error?.code == "cancelled")
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        #expect(fixture.exchange.lastResponse?.result?["previewToken"] != .string(canceledToken))
        _ = await fixture.controller.shutdown()
    }

    @Test("A recording without a camera has no preview token and rejects even an unexpected rig JPEG")
    func cameraAbsent() async throws {
        let fixture = try TokenControllerFixture()
        defer { fixture.removeFiles() }
        await fixture.command("record.start", ["camera": .string("none"), "mic": .string("fixture-mic"), "countdownSeconds": .int(0)])
        #expect(fixture.exchange.lastResponse?.ok == true)
        await fixture.command("camera.preview.subscribe", ["enabled": .bool(true)])
        #expect(fixture.exchange.lastResponse?.result?["previewToken"] == .null)
        let count = fixture.exchange.events.count
        await fixture.factory.publishRig(Data([1]))
        #expect(fixture.exchange.events.count == count)
        _ = await fixture.controller.shutdown()
    }
}

private struct TokenFixtureCatalog: SourceCataloging {
    func displays() async throws -> [DisplaySource] { [] }
    func windows() async throws -> [WindowSource] { [] }
    func cameras() async throws -> [CameraDevice] {
        [.init(id: "fixture-a", name: "Generated A"), .init(id: "fixture-b", name: "Generated B")]
    }
    func microphones() async throws -> [MicrophoneDevice] { [.init(id: "fixture-mic", name: "Generated mic")] }
}
private actor TokenFixtureFactory: CaptureRigFactory, CaptureRig {
    private var warms: [@Sendable (Data) -> Void] = []
    private var rigPublisher: (@Sendable (Data) -> Void)?
    private var failWarm = false
    private var parkWarm = false, parkAttach = false
    private var warmRelease: CheckedContinuation<Void, Never>?
    private var attachRelease: CheckedContinuation<Void, Never>?
    private(set) var stopCount = 0
    private(set) var gateEpoch: Int64?
    var warmCount: Int { warms.count }
    var attachWaiting: Bool { attachRelease != nil }
    func failNextWarm() { failWarm = true }
    func parkNextWarm() { parkWarm = true }
    func parkNextAttach() { parkAttach = true }
    func releaseWarm() { warmRelease?.resume(); warmRelease = nil }
    func releaseAttach() { attachRelease?.resume(); attachRelease = nil }
    func warmCamera(cameraID: String?, preview: @escaping @Sendable (Data) -> Void, warning: @escaping @Sendable (String, String?) -> Void) async throws -> JSONValue {
        warms.append(preview)
        if parkWarm { parkWarm = false; await withCheckedContinuation { warmRelease = $0 } }
        if failWarm { failWarm = false; throw ControlFailure(code: "fixture-warm-failed", message: "Synthetic warm failed") }
        return .object(["running": .bool(true), "camera": .string(cameraID)])
    }
    func attach(_ context: CaptureContext) async throws -> any CaptureRig {
        rigPublisher = context.preview
        if parkAttach { parkAttach = false; await withCheckedContinuation { attachRelease = $0 } }
        return self
    }
    func publishWarm(_ index: Int, bytes: Data) { warms[index](bytes) }
    func publishRig(_ bytes: Data) { rigPublisher?(bytes) }
    func stopPreview() async { stopCount += 1 }
    func gateOpened(epochHostNs: Int64) async { gateEpoch = epochHostNs }
    func stop() async {}
}
private struct TokenControllerFixture {
    let root: URL
    let controller: EngineController
    let factory = TokenFixtureFactory()
    let exchange = ControlExchange(connectionID: "preview-fixture")
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-preview-tokens-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        controller = try EngineController(config: .init(recordingsRoot: root.appendingPathComponent("library"), indexDatabaseURL: root.appendingPathComponent("index.sqlite"), catalog: TokenFixtureCatalog(), makeWriter: { config, clock in
            try TrackWriter(configuration: config, clock: clock, factory: TokenStateWriterFactory())
        }, captureRigs: factory))
    }
    func command(_ name: String, _ fields: [String: JSONValue] = [:]) async {
        await controller.handle(.init(id: UUID().uuidString, cmd: name, args: .object(fields)), context: exchange.context)
    }
    func waitForWarm() async throws {
        for _ in 0..<200 {
            if await factory.warmCount > 0 { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw ControlFailure(code: "fixture-timeout", message: "Synthetic warm did not park")
    }
    func waitForAttach() async throws {
        for _ in 0..<200 {
            if await factory.attachWaiting { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw ControlFailure(code: "fixture-timeout", message: "Synthetic attach did not park")
    }
    func removeFiles() { try? FileManager.default.removeItem(at: root) }
}
// A state-only backend creates no AVAssetWriter, media frames or hardware encoder.
private struct TokenStateWriterFactory: TrackFileWritingFactory {
    func makeWriter(configuration: TrackWriterConfiguration, codec: VideoCodec) throws -> any TrackFileWriting {
        try Data().write(to: configuration.outputURL)
        return TokenStateWriter(outputURL: configuration.outputURL)
    }
}
private final class TokenStateWriter: TrackFileWriting {
    let outputURL: URL
    private var phase: FileWritingState = .idle
    init(outputURL: URL) { self.outputURL = outputURL }
    var currentState: FileWritingState { phase }
    var failureDescription: String? { nil }
    var isReadyForMoreMediaData: Bool { true }
    func startWriting() -> Bool { phase = .writing; return true }
    func startSession() {}
    func appendVideoFrame(_ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool { true }
    func appendAudioSamples(_ sampleBuffer: CMSampleBuffer) -> Bool { true }
    func markInputFinished() {}
    func finishWriting(completion: @escaping @Sendable () -> Void) { phase = .completed; completion() }
    func cancelWriting() { phase = .failed }
}
