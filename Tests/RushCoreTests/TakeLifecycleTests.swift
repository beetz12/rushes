import CoreMedia
import CoreVideo
import Foundation
import Testing
@testable import RushCore

@Suite("Take lifecycle barriers", .serialized)
struct TakeLifecycleTests {
    @Test("Discard intent marks the terminal event without hiding ordinary failed Stop", arguments: ["record.cancel", "record.discard", "record.stop"])
    func terminalDiscardIntent(command: String) async throws {
        try await withLifecycleFixture { fixture in
            let start = fixture.spawn("record.start", tag: "discard-intent-start", countdown: 1)
            try await fixture.wait { fixture.exchange.events.contains { $0.event == "countdown" } }
            #expect(await fixture.command(command)?.ok == true)
            _ = await start.value
            let terminal = try #require(fixture.exchange.events.last { $0.event == "recording-stopped" })
            let discarded = command != "record.stop"
            #expect((terminal.result?["discardRequested"]?.bool == true) == discarded)
            let path = try #require(terminal.result?["packagePath"]?.string)
            #expect(FileManager.default.fileExists(atPath: path) != discarded)
        }
    }
    @Test("Native finalization still pending cannot be advertised as idle or start a new take")
    func pendingNativeFinalizerInterlock() async throws {
        try await withLifecycleFixture { fixture in
            let token=UUID()
            let file=fixture.root.appendingPathComponent("recordings/pending-native.mov")
            PendingWriterFiles.shared.begin(token,url:file.resolvingSymlinksInPath())
            defer { PendingWriterFiles.shared.end(token) }
            #expect(await fixture.command("status")?.result?["state"]?.string == "finishing")
            #expect(await fixture.command("camera.preview.start")?.error?.code == "wrong-state")
            #expect(await fixture.command("record.start")?.error?.code == "already-active")
            PendingWriterFiles.shared.end(token)
            _=await fixture.command("record.stop")
            #expect(await fixture.command("record.start")?.ok == true)
        }
    }
#if DEBUG
    @Test("Start wait joins its own teardown while native cleanup is pending")
    func startWaitDuringTeardown() async throws {
        try await withLifecycleFixture { fixture in
            let stopBarrier=LifecycleBarrier(enabled:true)
            await fixture.factory.configure(stop:stopBarrier)
            let checkpoint=await fixture.checkpoints.arm(.startIndexed)
            let start=fixture.spawn("record.start",tag:"start-a",extra:["wait":.bool(true)])
            try await fixture.wait { await checkpoint.isWaiting }
            let stop=fixture.spawn("record.stop",tag:"stop-a")
            try await fixture.wait { await stopBarrier.isWaiting }
            await checkpoint.release()
            await fixture.settleCallbacks()
            #expect(!fixture.exchange.responses.contains { $0.id == "start-a" })
            await stopBarrier.release()
            let terminal=await stop.value,joined=await start.value
            #expect(joined?.ok == true)
            #expect(joined?.result?["id"]?.string == terminal?.result?["id"]?.string)
        }
    }

    @Test("A source failing during attach cannot start a healthy recording")
    func sourceFailureDuringAttach() async throws {
        try await withLifecycleFixture { fixture in
            let attach=LifecycleBarrier(enabled:true)
            await fixture.factory.configure(attach:attach)
            let handled=await fixture.checkpoints.arm(.streamFailureHandled)
            let start=fixture.spawn("record.start",tag:"start-a")
            try await fixture.wait { await attach.isWaiting }
            let id=await fixture.factory.recordingID(0)
            await fixture.factory.fail(0)
            try await fixture.wait { await handled.isWaiting }
            await attach.release()
            let result=await start.value
            #expect(result?.error?.code == "capture-start-failed")
            #expect(!fixture.exchange.events.contains { $0.recordingId == id && $0.event == "recording-started" })
            let shown=await fixture.command("show",extra:["id":.string(id)])
            #expect(shown?.result?["manifest"]?["status"]?.string == "failed")
            #expect(await fixture.factory.resourceRunning(0) == false)
            await handled.release()
        }
    }
    @Test("A countdown Cancel cannot discard its take after the gate has opened")
    func cancelStateReadAfterGate() async throws {
        try await withLifecycleFixture { fixture in
            let start=fixture.spawn("record.start",tag:"start-a",countdown:1)
            try await fixture.wait { fixture.exchange.events.contains { $0.event == "countdown" } }
            let checkpoint=await fixture.checkpoints.arm(.cancelStateRead)
            let cancel=fixture.spawn("record.cancel")
            try await fixture.wait { await checkpoint.isWaiting }
            let started=await start.value
            let id=try #require(started?.result?["id"]?.string)
            await checkpoint.release()
            #expect(await cancel.value?.error?.code == "wrong-state")
            #expect(await fixture.command("status")?.result?["recording"]?["recordingID"]?.string == id)
        }
    }
    @Test("A canceled state-read continuation cannot discard the next take")
    func cancelStateReadAfterReplacement() async throws {
        try await withLifecycleFixture { fixture in
            let start=fixture.spawn("record.start",tag:"start-a",countdown:1)
            try await fixture.wait { fixture.exchange.events.contains { $0.event == "countdown" } }
            let checkpoint=await fixture.checkpoints.arm(.cancelStateRead)
            let cancel=fixture.spawn("record.cancel")
            try await fixture.wait { await checkpoint.isWaiting }
            #expect(await fixture.command("record.stop")?.ok == true)
            _=await start.value
            let next=await fixture.command("record.start",tag:"start-b")
            let id=try #require(next?.result?["id"]?.string)
            await checkpoint.release()
            #expect(await cancel.value?.error?.code == "cancelled")
            #expect(await fixture.command("status")?.result?["recording"]?["recordingID"]?.string == id)
        }
    }

    @Test("Discard keeps its interlock through job and index cleanup")
    func discardCleanupInterlock() async throws {
        try await withLifecycleFixture { fixture in
            _=await fixture.command("record.start",tag:"start-a")
            let checkpoint=await fixture.checkpoints.arm(.discardStopped)
            let discard=fixture.spawn("record.discard")
            try await fixture.wait { await checkpoint.isWaiting }
            let overlapping=await fixture.command("record.start",tag:"start-b")
            #expect(overlapping?.error?.code == "already-active")
            await checkpoint.release()
            #expect(await discard.value?.ok == true)
            #expect(await fixture.command("record.start",tag:"start-c")?.ok == true)
        }
    }

    @Test("A retired maintenance snapshot cannot suppress the next mic warning")
    func maintenanceAfterReplacement() async throws {
        try await withLifecycleFixture { fixture in
            _=await fixture.command("record.start",tag:"start-a",extra:["mic":.string("fixture-mic")])
            let checkpoint=await fixture.checkpoints.arm(.maintenanceSnapshotRead,needsSilentMic:true)
            await fixture.factory.makeMicSilent(0)
            try await fixture.wait(label:"A silent snapshot held before shared mutation") { await checkpoint.isWaiting }
            _=await fixture.command("record.stop")
            let next=await fixture.command("record.start",tag:"start-b",extra:["mic":.string("fixture-mic")])
            let id=try #require(next?.result?["id"]?.string)
            await checkpoint.release()
            await fixture.settleCallbacks()
            await fixture.factory.makeMicSilent(1)
            try await fixture.wait(label:"B mic warning after A resumed") { fixture.exchange.events.contains { $0.recordingId == id && $0.code == "mic-silent" } }
            #expect(fixture.exchange.events.filter { $0.recordingId == id && $0.code == "mic-silent" }.count == 1)
        }
    }

    @Test("Start retains ownership through index and wait registration")
    func stoppedStartWaitKeepsOutcome() async throws {
        try await withLifecycleFixture { fixture in
            let checkpoint=await fixture.checkpoints.arm(.startIndexed)
            let start=fixture.spawn("record.start",tag:"start-a",extra:["wait":.bool(true),"duration":.double(10)])
            try await fixture.wait { await checkpoint.isWaiting }
            let stopped=await fixture.command("record.stop")
            let id=try #require(stopped?.result?["id"]?.string)
            let overlap=await fixture.command("record.start",tag:"start-b",extra:["duration":.double(0.1)])
            #expect(overlap?.error?.code == "already-active")
            await checkpoint.release()
            let result=await start.value
            #expect(result?.ok == true && result?.result?["id"]?.string == id)
            #expect(result?.result?["status"]?.string == stopped?.result?["status"]?.string)
        }
    }

#endif
    @Test("Stop while gate setup is suspended cannot publish a later started event")
    func stopDuringGate() async throws {
        try await withLifecycleFixture { fixture in
            let gate = LifecycleBarrier(enabled: true)
            await fixture.factory.configure(gate: gate)
            let start = fixture.spawn("record.start", tag: "start-a")
            try await fixture.wait { await gate.isWaiting }
            let stopped = await fixture.command("record.stop")
            #expect(stopped?.ok == true)
            let id = try #require(stopped?.result?["id"]?.string)
            await gate.release()
            let started = await start.value
            #expect(started?.ok == false)
            #expect(started?.error?.code == "cancelled")
            #expect(await fixture.factory.resourceRunning(0) == false)
            #expect(!fixture.exchange.events.contains { $0.event == "recording-started" && $0.recordingId == id })
            #expect(fixture.exchange.events.filter { $0.event == "recording-stopped" && $0.recordingId == id }.count == 1)
        }
    }

    @Test("A rejected countdown Cancel cannot cancel a take whose gate is already open")
    func rejectedCancelKeepsStart() async throws {
        try await withLifecycleFixture { fixture in
            let gate = LifecycleBarrier(enabled: true)
            await fixture.factory.configure(gate: gate)
            let start = fixture.spawn("record.start", tag: "start-a")
            try await fixture.wait { await gate.isWaiting }
            let cancel = await fixture.command("record.cancel")
            #expect(cancel?.error?.code == "wrong-state")
            await gate.release()
            #expect(await start.value?.ok == true)
        }
    }

    @Test("Stop during a countdown leaves the terminal event last")
    func stopDuringCountdown() async throws { try await endDuringCountdown("record.stop") }

    @Test("Cancel during a countdown leaves the terminal event last")
    func cancelDuringCountdown() async throws { try await endDuringCountdown("record.cancel") }

    private func endDuringCountdown(_ command: String) async throws {
        try await withLifecycleFixture { fixture in
            let start = fixture.spawn("record.start", tag: "start-a", countdown: 1)
            try await fixture.wait { fixture.exchange.events.contains { $0.event == "countdown" && $0.result?["remaining"]?.int == 1 } }
            let id = try #require(fixture.exchange.events.first { $0.event == "countdown" }?.recordingId)
            #expect(await fixture.command(command)?.ok == true)
            _ = await start.value
            let events = fixture.exchange.events.filter { $0.recordingId == id }
            #expect(events.last?.event == "recording-stopped")
        }
    }

    @Test("A source-failure teardown refuses a new Start until its rig has stopped")
    func failureTeardownInterlock() async throws {
        try await withLifecycleFixture { fixture in
            let stop = LifecycleBarrier(enabled: true)
            await fixture.factory.configure(stop: stop)
            let first = await fixture.command("record.start", tag: "start-a")
            #expect(first?.ok == true)
            await fixture.factory.fail(0)
            try await fixture.wait { await stop.isWaiting }
            let overlapping = await fixture.command("record.start", tag: "start-b")
            #expect(overlapping?.ok == false)
            #expect(overlapping?.error?.code == "already-active")
            await stop.release()
            try await fixture.wait { fixture.exchange.events.contains { $0.event == "recording-stopped" } }
            try await fixture.wait { await fixture.command("status")?.result?["state"]?.string == "idle" }
            let next = await fixture.command("record.start", tag: "start-c")
            #expect(next?.ok == true)
        }
    }

    @Test("A retired take's late stream failure does not stop the current take")
    func retiredStreamFailure() async throws {
        try await withLifecycleFixture { fixture in
            _ = await fixture.command("record.start", tag: "start-a")
            _ = await fixture.command("record.stop")
            let next = await fixture.command("record.start", tag: "start-b")
            let id = try #require(next?.result?["id"]?.string)
            await fixture.factory.fail(0)
            await fixture.settleCallbacks()
            let status = await fixture.command("status")
            #expect(status?.result?["recording"]?["recordingID"]?.string == id)
            #expect(!fixture.exchange.events.contains { $0.event == "recording-stopped" && $0.recordingId == id })
        }
    }

    @Test("A retired camera warning is not attributed to the current take")
    func retiredCameraWarning() async throws {
        try await withLifecycleFixture { fixture in
            _ = await fixture.command("record.start", tag: "start-a")
            _ = await fixture.command("record.stop")
            let next = await fixture.command("record.start", tag: "start-b")
            let id = try #require(next?.result?["id"]?.string)
            await fixture.factory.warn(0, code: "camera-lost")
            await fixture.settleCallbacks()
            #expect(!fixture.exchange.events.contains { $0.event == "warning" && $0.recordingId == id && $0.code == "camera-lost" })
            let stopped = await fixture.command("record.stop")
            #expect(stopped?.ok == true)
            let warnings = stopped?.result?["warnings"]?.array ?? []
            #expect(!warnings.contains { $0["code"]?.string == "camera-lost" })
        }
    }

    @Test("A pause suspended in capture clock adoption cannot follow the terminal event")
    func pauseDuringStop() async throws { try await transitionDuringStop("record.pause") }

    @Test("A resume suspended in capture clock adoption cannot follow the terminal event")
    func resumeDuringStop() async throws { try await transitionDuringStop("record.resume") }

    private func transitionDuringStop(_ command: String) async throws {
        try await withLifecycleFixture { fixture in
            let adopt = LifecycleBarrier()
            await fixture.factory.configure(adopt: adopt)
            let started = await fixture.command("record.start", tag: "start-a")
            let id = try #require(started?.result?["id"]?.string)
            if command == "record.resume" { _ = await fixture.command("record.pause") }
            await adopt.enable()
            let transition = fixture.spawn(command)
            try await fixture.wait { await adopt.isWaiting }
            let stopped = await fixture.command("record.stop")
            #expect(stopped?.ok == true)
            await adopt.release()
            let result = await transition.value
            #expect(result?.ok == false)
            let relevant = fixture.exchange.events.filter { $0.recordingId == id }
            let terminal = try #require(relevant.lastIndex { $0.event == "recording-stopped" })
            #expect(!relevant.dropFirst(terminal + 1).contains { $0.event == "state-changed" || $0.event == "recording-started" })
        }
    }
}

private actor LifecycleBarrier {
    private var enabled: Bool
    private var continuation: CheckedContinuation<Void, Never>?
    var isWaiting: Bool { continuation != nil }
    init(enabled: Bool = false) { self.enabled = enabled }
    func enable() { enabled = true }
    func wait() async {
        guard enabled else { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { enabled = false; continuation?.resume(); continuation = nil }
}

#if DEBUG
private actor LifecycleCheckpoints {
    private var checkpoint: ControllerCheckpoint?
    private var barrier: LifecycleBarrier?
    private var needsSilentMic=false
    func arm(_ checkpoint:ControllerCheckpoint,needsSilentMic:Bool=false) -> LifecycleBarrier {
        self.checkpoint=checkpoint;self.needsSilentMic=needsSilentMic
        let barrier=LifecycleBarrier(enabled:true);self.barrier=barrier;return barrier
    }
    func observe(_ checkpoint:ControllerCheckpoint,_ id:String,_ snapshot:SessionSnapshot?) async {
        guard checkpoint == self.checkpoint else { return }
        if needsSilentMic,snapshot?.tracks.contains(where:{$0.kind == .microphone && $0.microphoneSilent == true}) != true { return }
        self.checkpoint=nil
        await barrier?.wait()
    }
    func releaseAll() async { await barrier?.release() }
}
#endif

private actor LifecycleRig: CaptureRig {
    let gate: LifecycleBarrier
    let stopBarrier: LifecycleBarrier
    let adopt: LifecycleBarrier
    private(set) var resourceRunning = false
    init(gate: LifecycleBarrier, stop: LifecycleBarrier, adopt: LifecycleBarrier) {
        self.gate = gate; stopBarrier = stop; self.adopt = adopt
    }
    func gateOpened(epochHostNs: Int64) async { await gate.wait(); resourceRunning = true }
    func stop() async { await stopBarrier.wait(); resourceRunning = false }
    func adoptClock(_ clock: SessionClock) async { await adopt.wait() }
    func releaseAll() async { await gate.release(); await stopBarrier.release(); await adopt.release() }
}

private actor LifecycleFactory: CaptureRigFactory {
    private var nextGate = LifecycleBarrier()
    private var nextStop = LifecycleBarrier()
    private var nextAdopt = LifecycleBarrier()
    private var nextAttach = LifecycleBarrier()
    private var attachGates:[LifecycleBarrier]=[]
    private var rigs: [LifecycleRig] = []
    private var contexts: [CaptureContext] = []
    func configure(gate: LifecycleBarrier? = nil, stop: LifecycleBarrier? = nil, adopt: LifecycleBarrier? = nil,attach:LifecycleBarrier?=nil) {
        if let gate { nextGate = gate }; if let stop { nextStop = stop }; if let adopt { nextAdopt = adopt }
        if let attach { nextAttach = attach }
    }
    func attach(_ context: CaptureContext) async throws -> any CaptureRig {
        let rig = LifecycleRig(gate: nextGate, stop: nextStop, adopt: nextAdopt)
        nextGate = LifecycleBarrier(); nextStop = LifecycleBarrier(); nextAdopt = LifecycleBarrier()
        let attach=nextAttach;nextAttach=LifecycleBarrier();attachGates.append(attach)
        rigs.append(rig); contexts.append(context)
        await attach.wait()
        return rig
    }
    func resourceRunning(_ index: Int) async -> Bool { await rigs[index].resourceRunning }
    func recordingID(_ index:Int) -> String { contexts[index].package.id }
    func fail(_ index: Int) { contexts[index].streamFailure("fixture source lost") }
    func warn(_ index: Int, code: String) { contexts[index].warning(code, "retired fixture callback") }
    func makeMicSilent(_ index:Int) async {
        let session=contexts[index].session
        guard let epoch=await session.currentClock()?.epochNs,let writer=await session.trackWriter(for:.microphone) else { return }
        for time in [epoch,epoch+3_100_000_000] {
            if let audio=SyntheticMedia.audioBuffer(channels:1,hostNs:time) { writer.appendAudio(audio) }
        }
    }
    func releaseAll() async { for attach in attachGates { await attach.release() }; for rig in rigs { await rig.releaseAll() } }
}

private struct LifecycleCatalog: SourceCataloging {
    func displays() async throws -> [DisplaySource] { [.init(id: "display-1", name: "Generated screen", widthPoints: 640, heightPoints: 480, isMain: true)] }
    func windows() async throws -> [WindowSource] { [] }
    func cameras() async throws -> [CameraDevice] { [.init(id: "fixture-camera", name: "Generated camera")] }
    func microphones() async throws -> [MicrophoneDevice] { [.init(id:"fixture-mic",name:"Generated microphone")] }
}

private final class LifecycleFixture: @unchecked Sendable {
    let root: URL
    let factory = LifecycleFactory()
    let exchange = ControlExchange(connectionID: "lifecycle-fixture")
#if DEBUG
    let checkpoints=LifecycleCheckpoints()
#endif
    let controller: EngineController
    private let lock = NSLock()
    private var tasks: [Task<ControlResponse?, Never>] = []
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-lifecycle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var config=EngineControllerConfig(recordingsRoot: root.appendingPathComponent("recordings"), indexDatabaseURL: root.appendingPathComponent("index.sqlite"), catalog: LifecycleCatalog(), makeWriter: { configuration, clock in
            try TrackWriter(configuration: configuration, clock: clock, factory: LifecycleWriterFactory())
        }, captureRigs: factory)
#if DEBUG
        let checkpoints=self.checkpoints
        config.lifecycleCheckpoint={ point,id,snapshot in await checkpoints.observe(point,id,snapshot) }
#endif
        controller = try EngineController(config:config)
    }
    func command(_ command: String, tag: String = UUID().uuidString, countdown: Int = 0,extra:[String:JSONValue]=[:]) async -> ControlResponse? {
        var args: [String: JSONValue] = command == "record.start" ? ["camera": .string("fixture-camera"), "mic": .string("none"), "countdownSeconds": .int(Int64(countdown))] : [:]
        args.merge(extra) { _,new in new }
        await controller.handle(.init(id: tag, cmd: command, args: .object(args)), context: exchange.context)
        return exchange.responses.last { $0.id == tag }
    }
    func spawn(_ command: String, tag: String = UUID().uuidString, countdown: Int = 0,extra:[String:JSONValue]=[:]) -> Task<ControlResponse?, Never> {
        let task = Task { await self.command(command, tag: tag, countdown: countdown,extra:extra) }
        lock.withLock { tasks.append(task) }; return task
    }
    func wait(label:String="",_ condition: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<500 { if await condition() { return }; try await Task.sleep(for: .milliseconds(5)) }
        throw ControlFailure(code: "fixture-timeout", message: label.isEmpty ? "Lifecycle barrier was not reached" : label)
    }
    func settleCallbacks() async {
        // The producer is confirmed synchronously above. Allow its intentionally
        // unacknowledged native callback to enter the controller actor queue.
        for _ in 0..<20 { await Task.yield(); try? await Task.sleep(for: .milliseconds(5)) }
    }
    private func trackedTasks() -> [Task<ControlResponse?, Never>] { lock.withLock { tasks } }
    func close() async {
#if DEBUG
        await checkpoints.releaseAll()
#endif
        await factory.releaseAll()
        _ = await controller.shutdown()
        for task in trackedTasks() { _ = await task.value }
        try? FileManager.default.removeItem(at: root)
    }
}
private func withLifecycleFixture(_ body: (LifecycleFixture) async throws -> Void) async throws {
    let fixture = try LifecycleFixture()
    do { try await body(fixture) } catch { await fixture.close(); throw error }
    await fixture.close()
}

private struct LifecycleWriterFactory: TrackFileWritingFactory {
    func makeWriter(configuration: TrackWriterConfiguration, codec: VideoCodec) throws -> any TrackFileWriting {
        try Data().write(to: configuration.outputURL); return LifecycleWriter(configuration.outputURL)
    }
}
// These barriers test controller ordering, not media validity or hardware.
private final class LifecycleWriter: TrackFileWriting {
    let outputURL: URL
    private var state: FileWritingState = .idle
    init(_ outputURL: URL) { self.outputURL = outputURL }
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
