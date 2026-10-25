import CoreMedia
import CoreVideo
import Darwin
import Foundation
import Testing
@testable import RushCore

@Suite("Native update hold", .serialized)
struct NativeUpdateHoldTests {
    @Test("An engine without a configured shell owner refuses update holds explicitly")
    func standaloneRefusesHold() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-update-\(UUID())")
        let controller = try EngineController(config: .init(recordingsRoot: root.appendingPathComponent("takes"), indexDatabaseURL: root.appendingPathComponent("index.sqlite")))
        let exchange = ControlExchange(connectionID: "update")
        await controller.handle(.init(id: "hold", cmd: "update.hold.acquire", args: .object(["token": .string(UUID().uuidString.lowercased())])), context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "update-owner-unavailable")
        await controller.shutdown()
        try? FileManager.default.removeItem(at: root)
    }
}

#if DEBUG
private final class UpdateOwnerFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var alive = true
    private var terminations = 0
    func setAlive(_ value: Bool) { lock.withLock { alive = value } }
    var count: Int { lock.withLock { terminations } }
    var configuration: NativeUpdateOwner {
        .init(parentPID: 42, isAlive: { self.lock.withLock { self.alive } },
              pollIntervalNs: 5_000_000, requestTermination: { self.lock.withLock { self.terminations += 1 } })
    }
}

private actor UpdateBarrier {
    private var enabled = false
    private var continuation: CheckedContinuation<Void, Never>?
    var waiting: Bool { continuation != nil }
    func arm() { enabled = true }
    func wait() async {
        guard enabled else { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { enabled = false; continuation?.resume(); continuation = nil }
}

private actor UpdateRig: CaptureRig {
    let stopBarrier: UpdateBarrier
    init(_ stop: UpdateBarrier) { stopBarrier = stop }
    func gateOpened(epochHostNs: Int64) async {}
    func stop() async { await stopBarrier.wait() }
}

private actor UpdateFactory: CaptureRigFactory {
    let attachBarrier = UpdateBarrier()
    let stopBarrier = UpdateBarrier()
    let warmBarrier = UpdateBarrier()
    let previewStopBarrier = UpdateBarrier()
    func attach(_ context: CaptureContext) async throws -> any CaptureRig {
        await attachBarrier.wait()
        return UpdateRig(stopBarrier)
    }
    func warmCamera(cameraID: String?, preview: @escaping @Sendable (Data) -> Void,
                    warning: @escaping @Sendable (String, String?) -> Void) async throws -> JSONValue {
        await warmBarrier.wait()
        return .object(["running": .bool(true)])
    }
    func stopPreview() async { await previewStopBarrier.wait() }
    func releaseAll() async {
        await attachBarrier.release(); await stopBarrier.release()
        await warmBarrier.release(); await previewStopBarrier.release()
    }
}

private struct UpdateCatalog: SourceCataloging {
    let displayBarrier: UpdateBarrier
    func displays() async throws -> [DisplaySource] {
        await displayBarrier.wait()
        return [.init(id: "screen", name: "Generated", widthPoints: 640, heightPoints: 480, isMain: true)]
    }
    func windows() async throws -> [WindowSource] { [] }
    func cameras() async throws -> [CameraDevice] { [.init(id: "camera", name: "Generated")] }
    func microphones() async throws -> [MicrophoneDevice] { [] }
}

private actor UpdateCheckpoints {
    private var point: ControllerCheckpoint?
    let barrier = UpdateBarrier()
    private(set) var startEntries = 0
    func arm(_ point: ControllerCheckpoint) async { self.point = point; await barrier.arm() }
    func observe(_ point: ControllerCheckpoint) async {
        if point == .startCaptureMarked { startEntries += 1 }
        guard point == self.point else { return }
        self.point = nil
        await barrier.wait()
    }
}

private final class UpdateFixture: @unchecked Sendable {
    let root: URL
    let factory = UpdateFactory()
    let owner = UpdateOwnerFixture()
    let checkpoints = UpdateCheckpoints()
    let displayBarrier = UpdateBarrier()
    let controller: EngineController
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-update-\(UUID())")
        var config = EngineControllerConfig(recordingsRoot: root.appendingPathComponent("takes"),
            indexDatabaseURL: root.appendingPathComponent("index.sqlite"), catalog: UpdateCatalog(displayBarrier: displayBarrier),
            updateOwner: owner.configuration,
            makeWriter: { configuration, clock in try TrackWriter(configuration: configuration, clock: clock, factory: UpdateWriterFactory()) },
            captureRigs: factory, capturePreflightMode: .generated)
        let checkpoints = checkpoints
        config.lifecycleCheckpoint = { point, _, _ in await checkpoints.observe(point) }
        controller = try EngineController(config: config)
    }
    func command(_ cmd: String, token: String? = nil, connected: @escaping @Sendable () -> Bool = { true },
                 connection: String = "gui", args: [String: JSONValue] = [:]) async -> ControlResponse? {
        let exchange = ControlExchangeBox(), id = UUID().uuidString
        var params = args
        if cmd == "record.start" { params["camera"] = .string("camera"); params["mic"] = .string("none") }
        if let token { params["token"] = .string(token) }
        let context = ControlCommandContext(reply: { exchange.append($0) }, broadcast: { exchange.append($0) },
            connectionID: connection, isConnected: connected)
        await controller.handle(.init(id: id, cmd: cmd, args: .object(params)), context: context)
        return exchange.allResponses().last
    }
    func acquire(_ token: String = UUID().uuidString.lowercased()) async -> ControlResponse? {
        await command("update.hold.acquire", token: token)
    }
    func wait(_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<500 { if await condition() { return }; try await Task.sleep(for: .milliseconds(5)) }
        throw ControlFailure(code: "fixture-timeout")
    }
    func close() async {
        await checkpoints.barrier.release(); await displayBarrier.release(); await factory.releaseAll()
        await controller.shutdown()
        try? FileManager.default.removeItem(at: root)
    }
}

private func withUpdateFixture(_ body: (UpdateFixture) async throws -> Void) async throws {
    let fixture = try UpdateFixture()
    do { try await body(fixture) } catch { await fixture.close(); throw error }
    await fixture.close()
}

extension NativeUpdateHoldTests {
    @Test("Held token is idempotent, survives disconnect, and only matching reconnect can release")
    func tokenOwnership() async throws {
        try await withUpdateFixture { fixture in
            let token = UUID().uuidString.lowercased()
            let held = await fixture.acquire(token)
            #expect(held?.ok == true && held?.result?["held"]?.bool == true)
            #expect(held?.result?["pid"]?.int == Int64(getpid()))
            #expect(await fixture.acquire(token)?.ok == true)
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            await fixture.controller.clientDisconnected("gui")
            #expect(await fixture.command("update.hold.release", token: token, connected: { false })?.error?.code == "connection-closed")
            #expect(await fixture.command("record.start")?.error?.code == "update-held")
            #expect(await fixture.command("update.hold.release", token: UUID().uuidString.lowercased(), connection: "reconnect")?.error?.code == "update-token-mismatch")
            #expect(await fixture.command("update.hold.release", token: token, connection: "reconnect")?.result?["held"]?.bool == false)
            #expect(await fixture.command("update.hold.release", token: token)?.ok == true)
            #expect(await fixture.command("record.start")?.ok == true)
        }
    }

    @Test("Malformed tokens and disconnected acquires cannot reserve idle")
    func disconnectedAndInvalid() async throws {
        try await withUpdateFixture { fixture in
            for token in ["bad", "ABCDEF01-2345-6789-ABCD-EF0123456789", ""] {
                #expect(await fixture.acquire(token)?.error?.code == "invalid-params")
            }
            #expect(await fixture.command("update.hold.acquire", token: UUID().uuidString.lowercased(), connected: { false })?.error?.code == "connection-closed")
            #expect(await fixture.acquire()?.ok == true)
        }
    }

    @Test("A held update refuses capture before extended capture-state work and refuses previews")
    func earlyStartBarrier() async throws {
        try await withUpdateFixture { fixture in
            #expect(await fixture.acquire()?.ok == true)
            #expect(await fixture.command("record.start")?.error?.code == "update-held")
            #expect(await fixture.checkpoints.startEntries == 0)
            #expect(await fixture.command("camera.preview.start")?.error?.code == "wrong-state")
            #expect(await fixture.command("capture.preflight.start", args: ["display": .string("screen"), "selectionToken": .string(UUID().uuidString), "selectionRevision": .int(1)])?.error?.code == "wrong-state")
        }
    }

    @Test("A start suspended after extended capture-state work cannot cross a newly acquired hold")
    func lateStartBarrier() async throws {
        try await withUpdateFixture { fixture in
            await fixture.checkpoints.arm(.startCaptureMarked)
            let start = Task { await fixture.command("record.start") }
            try await fixture.wait { await fixture.checkpoints.barrier.waiting }
            #expect(await fixture.acquire()?.ok == true)
            await fixture.checkpoints.barrier.release()
            #expect(await start.value?.error?.code == "update-held")
        }
    }

    @Test("Active, attaching, finishing, and pending native writers refuse holds", arguments: ["active", "attaching", "finishing", "pending"])
    func busyCapture(_ mode: String) async throws {
        try await withUpdateFixture { fixture in
            if mode == "pending" {
                let token = UUID(), path = fixture.root.appendingPathComponent("takes/pending.mov").resolvingSymlinksInPath()
                PendingWriterFiles.shared.begin(token, url: path)
                #expect(await fixture.acquire()?.error?.code == "update-busy")
                PendingWriterFiles.shared.end(token)
            } else if mode == "attaching" {
                await fixture.factory.attachBarrier.arm()
                let start = Task { await fixture.command("record.start") }
                try await fixture.wait { await fixture.factory.attachBarrier.waiting }
                #expect(await fixture.acquire()?.error?.code == "update-busy")
                await fixture.factory.attachBarrier.release()
                #expect(await start.value?.ok == true)
            } else {
                #expect(await fixture.command("record.start")?.ok == true)
                if mode == "active" { #expect(await fixture.acquire()?.error?.code == "update-busy") }
                else {
                    await fixture.factory.stopBarrier.arm()
                    let stop = Task { await fixture.command("record.stop") }
                    try await fixture.wait { await fixture.factory.stopBarrier.waiting }
                    #expect(await fixture.acquire()?.error?.code == "update-busy")
                    await fixture.factory.stopBarrier.release()
                    _ = await stop.value
                }
            }
        }
    }

    @Test("Warm preview acquisition and preview cleanup refuse holds")
    func previewBusy() async throws {
        try await withUpdateFixture { fixture in
            await fixture.factory.warmBarrier.arm()
            let warm = Task { await fixture.command("camera.preview.start") }
            try await fixture.wait { await fixture.factory.warmBarrier.waiting }
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            await fixture.factory.warmBarrier.release()
            #expect(await warm.value?.ok == true)
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            await fixture.factory.previewStopBarrier.arm()
            let stop = Task { await fixture.command("camera.preview.stop") }
            try await fixture.wait { await fixture.factory.previewStopBarrier.waiting }
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            await fixture.factory.previewStopBarrier.release()
            _ = await stop.value
            #expect(await fixture.acquire()?.ok == true)
        }
    }

    @Test("Queued preflight acquisition and live preflight inputs refuse holds")
    func preflightBusy() async throws {
        try await withUpdateFixture { fixture in
            let selection = UUID().uuidString
            await fixture.displayBarrier.arm()
            let start = Task { await fixture.command("capture.preflight.start", args: ["display": .string("screen"), "selectionToken": .string(selection), "selectionRevision": .int(1)]) }
            try await fixture.wait { await fixture.displayBarrier.waiting }
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            await fixture.displayBarrier.release()
            #expect(await start.value?.ok == true)
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            #expect(await fixture.command("capture.preflight.stop", args: ["selectionToken": .string(selection), "selectionRevision": .int(2)])?.ok == true)
            #expect(await fixture.acquire()?.ok == true)
        }
    }

    @Test("Held owner loss requests one graceful same-engine termination and retains the barrier")
    func heldOwnerLoss() async throws {
        try await withUpdateFixture { fixture in
            let token = UUID().uuidString.lowercased()
            #expect(await fixture.acquire(token)?.ok == true)
            fixture.owner.setAlive(false)
            try await fixture.wait { fixture.owner.count == 1 }
            await fixture.controller.checkUpdateOwner()
            #expect(fixture.owner.count == 1)
            #expect(await fixture.command("record.start")?.error?.code == "update-held")
            #expect(await fixture.command("update.hold.release", token: token)?.error?.code == "update-busy")
        }
    }

    @Test("Owner loss during idle reservation retains its barrier until termination")
    func reservedOwnerLoss() async throws {
        try await withUpdateFixture { fixture in
            await fixture.checkpoints.arm(.updateIdleChecked)
            let token = UUID().uuidString.lowercased()
            let acquire = Task { await fixture.acquire(token) }
            try await fixture.wait { await fixture.checkpoints.barrier.waiting }
            fixture.owner.setAlive(false)
            try await fixture.wait { fixture.owner.count == 1 }
            #expect(await fixture.command("update.hold.release", token: token)?.error?.code == "update-busy")
            await fixture.checkpoints.barrier.release()
            #expect(await acquire.value?.ok == false)
            #expect(await fixture.command("record.start")?.error?.code == "update-held")
            #expect(fixture.owner.count == 1)
        }
    }

    @Test("Owner loss without a hold preserves a running take")
    func unheldOwnerLoss() async throws {
        try await withUpdateFixture { fixture in
            #expect(await fixture.command("record.start")?.ok == true)
            fixture.owner.setAlive(false)
            await fixture.controller.clientDisconnected("gui")
            await fixture.controller.checkUpdateOwner()
            #expect(fixture.owner.count == 0)
            #expect(await fixture.command("status")?.result?["state"]?.string == "recording")
            #expect(await fixture.acquire()?.error?.code == "update-owner-unavailable")
            #expect(await fixture.command("record.stop")?.ok == true)
        }
    }

    @Test("Shutdown blocks new startup before its first asynchronous cleanup")
    func shutdownBarrier() async throws {
        try await withUpdateFixture { fixture in
            await fixture.checkpoints.arm(.shutdownBarrier)
            let shutdown = Task { await fixture.controller.shutdown() }
            try await fixture.wait { await fixture.checkpoints.barrier.waiting }
            #expect(await fixture.command("record.start")?.error?.code == "engine-stopping")
            #expect(await fixture.command("camera.preview.start")?.error?.code == "wrong-state")
            #expect(await fixture.acquire()?.error?.code == "update-busy")
            await fixture.checkpoints.barrier.release()
            _ = await shutdown.value
        }
    }

    @Test("Disconnect while quiescence is awaited cannot reserve a late hold")
    func lateDisconnectedAcquire() async throws {
        try await withUpdateFixture { fixture in
            let connected = UpdateOwnerFixture()
            await fixture.checkpoints.arm(.updateIdleChecked)
            let token = UUID().uuidString.lowercased()
            let acquire = Task { await fixture.command("update.hold.acquire", token: token, connected: { connected.configuration.isAlive() }) }
            try await fixture.wait { await fixture.checkpoints.barrier.waiting }
            connected.setAlive(false)
            await fixture.checkpoints.barrier.release()
            #expect(await acquire.value?.ok == false)
            #expect(await fixture.acquire()?.ok == true)
        }
    }

    @Test("Parent liveness rejects reparenting and reused or dead PIDs")
    func parentIdentity() {
        #expect(NativeUpdateOwner.parentIsAlive(42, currentParent: 42, exists: { $0 == 42 }))
        #expect(!NativeUpdateOwner.parentIsAlive(42, currentParent: 1, exists: { _ in true }))
        #expect(!NativeUpdateOwner.parentIsAlive(42, currentParent: 42, exists: { _ in false }))
        #expect(!NativeUpdateOwner.parentIsAlive(1, currentParent: 1, exists: { _ in true }))
    }
}

private struct UpdateWriterFactory: TrackFileWritingFactory {
    func makeWriter(configuration: TrackWriterConfiguration, codec: VideoCodec) throws -> any TrackFileWriting {
        try Data().write(to: configuration.outputURL)
        return UpdateWriter(configuration.outputURL)
    }
}

private final class UpdateWriter: TrackFileWriting {
    let outputURL: URL
    private var state: FileWritingState = .idle
    init(_ url: URL) { outputURL = url }
    var currentState: FileWritingState { state }
    var failureDescription: String? { nil }
    var isReadyForMoreMediaData: Bool { true }
    func startWriting() -> Bool { state = .writing; return true }
    func startSession() {}
    func appendVideoFrame(_ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool { true }
    func appendAudioSamples(_ sampleBuffer: CMSampleBuffer) -> Bool { true }
    func markInputFinished() {}
    func finishWriting(completion: @escaping @Sendable () -> Void) { state = .completed; completion() }
    func cancelWriting() { state = .failed }
}

#endif
