import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import Testing
@testable import RushCore

@Suite("Selected native input feedback")
struct PreflightPreviewTests {
    private func pcm(_ values: [Float], channels: Int = 1) throws -> CMSampleBuffer {
        let sample = try #require(SyntheticMedia.audioBuffer(channels: channels, hostNs: 0))
        let block = try #require(CMSampleBufferGetDataBuffer(sample))
        let count = CMSampleBufferGetNumSamples(sample) * channels
        let expanded = (0..<count).map { values[$0 % values.count] }
        #expect(expanded.withUnsafeBytes {
            CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block,
                offsetIntoDestination: 0, dataLength: $0.count)
        } == noErr)
        return sample
    }

    @Test("Measured Float32 PCM includes both channels, peaks and full-scale clipping")
    func measuredPCM() throws {
        let level = try #require(MicrophoneLevels.measure(pcm([0.5, -0.25], channels: 2)))
        #expect(abs(level.rms - sqrt(0.15625)) < 1e-8)
        #expect(level.peak == 0.5 && !level.clipping && level.frames == 1024)
        #expect(try MicrophoneLevels.measure(pcm([0]))?.rms == 0)
        #expect(try MicrophoneLevels.measure(pcm([-1]))?.clipping == true)
        #expect(try MicrophoneLevels.measure(pcm([.nan])) == nil)
        #expect(try MicrophoneLevels.measure(pcm([.infinity])) == nil)
    }

    @Test("Native device resolution uses unique IDs or position-qualified catalog IDs")
    func deviceResolution() {
        let devices: [NativeMicrophoneSelection.Device] = [
            .init(uniqueID: "", name: "USB Mic"), .init(uniqueID: "", name: "USB Mic"),
            .init(uniqueID: "Raw:123", name: "Different")
        ]
        #expect(NativeMicrophoneSelection.index(for: "name-usb-mic-1", in: devices) == 1)
        #expect(NativeMicrophoneSelection.index(for: "dev-raw-123", in: devices) == 2)
        #expect(NativeMicrophoneSelection.index(for: "Raw:123", in: devices) == 2)
        #expect(NativeMicrophoneSelection.index(for: "disconnected", in: devices) == nil)
    }

    @Test("Unsupported or absent PCM is unavailable rather than silent")
    func unsupportedPCM() throws {
        let donor = try pcm([0])
        let original = try #require(CMSampleBufferGetFormatDescription(donor))
        var description = try #require(CMAudioFormatDescriptionGetStreamBasicDescription(original)).pointee
        description.mFormatFlags = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
        description.mBitsPerChannel = 16; description.mBytesPerFrame = 2; description.mBytesPerPacket = 2
        var format: CMAudioFormatDescription?
        #expect(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &description,
            layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil,
            extensions: nil, formatDescriptionOut: &format) == noErr)
        var sample: CMSampleBuffer?
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        #expect(CMSampleBufferCreate(allocator: kCFAllocatorDefault,
            dataBuffer: CMSampleBufferGetDataBuffer(donor), dataReady: true, makeDataReadyCallback: nil,
            refcon: nil, formatDescription: format, sampleCount: 1024, sampleTimingEntryCount: 1,
            sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
            sampleBufferOut: &sample) == noErr)
        #expect(MicrophoneLevels.measure(try #require(sample)) == nil)
        var empty: CMSampleBuffer?
        #expect(CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: original, sampleCount: 0,
            sampleTimingEntryCount: 0, sampleTimingArray: nil, sampleSizeEntryCount: 0,
            sampleSizeArray: nil, sampleBufferOut: &empty) == noErr)
        #expect(MicrophoneLevels.measure(try #require(empty)) == nil)
    }

    @Test("Area snapshots clamp global rectangles and subtract negative display origins")
    func geometry() throws {
        let frame = CGRect(x: -1920, y: -100, width: 1920, height: 1080)
        let plan = try ScreenPreviewGeometry.make(
            surface: .area(displayID: "left", rect: CGRect(x: -2000, y: 20, width: 1000, height: 300)),
            displayFrame: frame, windowFrame: nil, windowBundleID: nil, excluding: ["rushes"])
        #expect(plan.sourceRect == CGRect(x: 0, y: 120, width: 920, height: 300))
        #expect(plan.width == 640 && plan.height == 209)
        #expect(throws: ControlFailure.self) {
            try ScreenPreviewGeometry.make(surface: .window(id: "gone"), displayFrame: frame,
                windowFrame: nil, windowBundleID: nil, excluding: [])
        }
        #expect(throws: ControlFailure.self) {
            try ScreenPreviewGeometry.make(surface: .window(id: "ours"), displayFrame: frame,
                windowFrame: frame, windowBundleID: "rushes", excluding: ["rushes"])
        }
        #expect(throws: ControlFailure.self) {
            try ScreenPreviewImage(jpeg: Data(repeating: 1, count: 262_145), width: 640, height: 480).validated()
        }
        #expect(throws: ControlFailure.self) {
            try ScreenPreviewImage(jpeg: Data([1]), width: 641, height: 480).validated()
        }
        let generated = try NativeScreenPreview.generated(surface: .display(id: "generated"))
        #expect(generated.jpeg.count > 0 && generated.jpeg.count < 262_144)
    }

    @Test("Denied and missing inputs never acquire a microphone or screenshot")
    func deniedAndMissing() async throws {
        let driver = PreviewDriverFixture(), events = EventCollector()
        let denied = CapturePreflight(catalog: PreviewCatalog(),
            permissions: PermissionAdvisor(check: { _ in .init(state: .denied) }),
            drivers: driver.drivers, excluding: [], publish: { events.append($0) })
        await #expect(throws: ControlFailure.self) {
            try await denied.start(["selectionRevision": .int(1), "selectionToken": .string(UUID().uuidString), "mic": .string("mic-a")],
                owner: "gui", connected: { true })
        }
        let allowed = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: ["rushes"], publish: { events.append($0) })
        for (index, arguments) in [
            ["mic": JSONValue.string("missing")],
            ["window": JSONValue.string("window-ours")],
            ["window": JSONValue.string("window-gone")]
        ].enumerated() {
            var arguments = arguments; arguments["selectionRevision"] = .int(Int64(index + 1)); arguments["selectionToken"] = .string(UUID().uuidString)
            await #expect(throws: ControlFailure.self) {
                try await allowed.start(arguments, owner: "gui", connected: { true })
            }
        }
        #expect(driver.madeCount == 0)
        #expect(await driver.screen.calls == 0)
        #expect(events.all().isEmpty)
        try await denied.stopAll(); try await allowed.stopAll()
    }

    @Test("Timed-out acquisition and parked drain retain ownership and reject stale callbacks")
    func acquireAndDrainOwnership() async throws {
        let driver = PreviewDriverFixture(), events = EventCollector()
        await driver.first.parkAcquisition()
        let service = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: [], budgetNs: 50_000_000, publish: { events.append($0) })
        let oldSelection = UUID().uuidString
        let first = Task { try await service.start(["selectionRevision": .int(1), "selectionToken": .string(oldSelection), "mic": .string("mic-a")],
            owner: "gui", connected: { true }) }
        try await waitUntil { await driver.first.acquisitionWaiting }
        do { _ = try await first.value; Issue.record("Parked acquisition unexpectedly acknowledged") }
        catch let error as ControlFailure { #expect(error.payload.code == "preflight-busy") }
        #expect(!(await service.quiescent))
        await driver.first.emit(.init(rms: 0.2, peak: 0.3, clipping: false, frames: 1024))
        #expect(events.all().isEmpty)
        await driver.first.parkDrain()
        let newSelection = UUID().uuidString
        let second = Task { try await service.start(["selectionRevision": .int(2), "selectionToken": .string(newSelection), "mic": .string("mic-b")],
            owner: "gui", connected: { true }) }
        await driver.first.releaseAcquisition()
        try await waitUntil { await driver.first.drainWaiting }
        #expect(driver.madeCount == 1)
        #expect(!(await service.quiescent))
        await driver.first.releaseDrain()
        let ack = try await second.value
        #expect(ack["microphone"]?.string == "mic-b")
        let before = events.all().count
        await driver.first.emit(.init(rms: 0.8, peak: 1, clipping: true, frames: 1024))
        #expect(events.all().count == before)
        await driver.second.emit(.init(rms: 0.2, peak: 0.4, clipping: false, frames: 1024))
        #expect(events.all().last?.result?["previewToken"] == ack["previewToken"])
        _ = try await service.stop(owner: "gui", selection: oldSelection, revision: 1)
        #expect(!(await service.quiescent))
        _ = try await service.stop(owner: "gui", selection: newSelection, revision: 2)
        #expect(await service.quiescent)
        #expect(await driver.first.stopCount == 1)
        #expect(await driver.second.stopCount == 1)
    }

    @Test("A lost owner cannot revive a pending input acquisition")
    func disconnectedOwner() async throws {
        let driver = PreviewDriverFixture(), events = EventCollector()
        await driver.first.parkAcquisition()
        let service = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: [], publish: { events.append($0) })
        let pending = Task { try await service.start(["selectionRevision": .int(1), "selectionToken": .string(UUID().uuidString), "mic": .string("mic-a")],
            owner: "lost", connected: { true }) }
        try await waitUntil { await driver.first.acquisitionWaiting }
        await service.disconnected("lost")
        await driver.first.emit(.init(rms: 0.1, peak: 0.2, clipping: false, frames: 1024))
        await driver.first.releaseAcquisition()
        do { _ = try await pending.value; Issue.record("Disconnected source acknowledged") } catch {}
        try await service.stopAll()
        #expect(events.all().isEmpty)
        #expect(await service.quiescent)
        #expect(await driver.first.stopCount == 1)
    }

    @Test("Screenshots keep one native operation after timeout and discard old selection bytes")
    func screenshotOwnership() async throws {
        let driver = PreviewDriverFixture()
        await driver.screen.park()
        let service = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: [], budgetNs: 50_000_000, publish: { _ in })
        let selection = UUID().uuidString
        let ack = try await service.start(["selectionRevision": .int(1), "selectionToken": .string(selection), "display": .string("main")],
            owner: "gui", connected: { true })
        let token = try #require(ack["previewToken"]?.string)
        let first = Task { try await service.snapshot(owner: "gui", token: token) }
        try await waitUntil { await driver.screen.waiting }
        let second = Task { try await service.snapshot(owner: "gui", token: token) }
        do { _ = try await first.value; Issue.record("Parked screenshot acknowledged") } catch {}
        do { _ = try await second.value; Issue.record("Queued screenshot acknowledged") } catch {}
        #expect(await driver.screen.calls == 1)
        await service.disconnected("gui")
        await driver.screen.release()
        try await service.stopAll()
        #expect(await driver.screen.calls == 1)
        #expect(await service.quiescent)
        await #expect(throws: ControlFailure.self) { try await service.snapshot(owner: "gui", token: token) }
    }

    @Test("UI or CLI recording cannot attach until idle native drain returns; Cancel keeps ownership", arguments: [false, true])
    func controllerStartDrainsPreview(cancel: Bool) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("preflight-start-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let driver = PreviewDriverFixture(), rig = PreflightAttachCounter()
        var config = EngineControllerConfig(recordingsRoot: root.appendingPathComponent("library"),
            indexDatabaseURL: root.appendingPathComponent("index.sqlite"),
            catalog: PreviewCatalog(), captureRigs: rig)
        config.preflightDrivers = driver.drivers
        let controller = try EngineController(config: config)
        let gui = ControlExchange(connectionID: "gui"), cli = ControlExchange(connectionID: "cli")
        await controller.handle(.init(id: "preview", cmd: "capture.preflight.start", args: .object([
            "selectionRevision": .int(1), "selectionToken": .string(UUID().uuidString), "mic": .string("mic-a")
        ])), context: gui.context)
        #expect(gui.lastResponse?.ok == true)
        await driver.first.parkDrain()
        let start = Task {
            await controller.handle(.init(id: "start", cmd: "record.start", args: .object([
                "mic": .string("mic-a"), "camera": .string("none"), "countdownSeconds": .int(0)
            ])), context: cli.context)
        }
        try await waitUntil { await driver.first.drainWaiting }
        #expect(await rig.attachCount == 0)
        if cancel {
            await controller.handle(.init(id: "cancel", cmd: "record.cancel"), context: gui.context)
        }
        await driver.first.releaseDrain(); await start.value
        if cancel {
            #expect(cli.lastResponse?.error?.code == "cancelled")
            #expect(await rig.attachCount == 0)
        } else {
            #expect(cli.lastResponse?.ok == true)
            #expect(await rig.attachCount == 1)
        }
        _ = await controller.shutdown()
        // No source emitted samples: this proves acquisition ordering, not
        // playable media or physical-device behavior.
    }

    @Test("Cancel received before delayed start admission cannot revive that selection")
    func cancellationBeforeAdmission() async throws {
        let driver = PreviewDriverFixture()
        let service = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: [], publish: { _ in })
        let selection = UUID().uuidString
        _ = try await service.stop(owner: "gui", selection: selection, revision: 1)
        await #expect(throws: ControlFailure.self) {
            try await service.start(["selectionRevision": .int(1), "selectionToken": .string(selection), "mic": .string("mic-a")],
                owner: "gui", connected: { true })
        }
        #expect(driver.madeCount == 0)
        let newer = try await service.start(["selectionRevision": .int(2), "selectionToken": .string(UUID().uuidString), "mic": .string("mic-b")], owner: "gui", connected: { true })
        #expect(newer["microphone"]?.string == "mic-b")
        await #expect(throws: ControlFailure.self) {
            try await service.start(["selectionRevision": .int(1), "selectionToken": .string(selection), "mic": .string("mic-a")], owner: "gui", connected: { true })
        }
        #expect(driver.madeCount == 1)
        try await service.stopAll()
    }

    @Test("Repeated screenshot timeouts cannot accumulate operations behind one hung native call")
    func boundedScreenshotAdmission() async throws {
        let driver = PreviewDriverFixture()
        await driver.screen.park()
        let service = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: [], budgetNs: 30_000_000, publish: { _ in })
        let ack = try await service.start(["selectionRevision": .int(1), "selectionToken": .string(UUID().uuidString), "display": .string("main")],
            owner: "gui", connected: { true })
        let token = try #require(ack["previewToken"]?.string)
        let first = Task { try? await service.snapshot(owner: "gui", token: token) }
        try await waitUntil { await driver.screen.waiting }
        _ = await first.value
        let retries = (0..<20).map { _ in Task { try? await service.snapshot(owner: "gui", token: token) } }
        for retry in retries { _ = await retry.value }
        #expect(await service.pendingOperationCount <= 1)
        #expect(await driver.screen.calls == 1)
        let drains = (0..<20).map { _ in Task { try? await service.stopAll() } }
        for drain in drains { _ = await drain.value }
        #expect(await service.pendingOperationCount <= 2)
        #expect(!(await service.quiescent))
        await driver.screen.release()
        try await service.stopAll()
    }

    @Test("Rapid replacement starts retain bounded native work behind a hung acquisition")
    func boundedStartAdmission() async throws {
        let driver = PreviewDriverFixture()
        await driver.first.parkAcquisition()
        let service = CapturePreflight(catalog: PreviewCatalog(), permissions: .allAllowed,
            drivers: driver.drivers, excluding: [], budgetNs: 30_000_000, publish: { _ in })
        let first = Task { try? await service.start(["selectionRevision": .int(1),
            "selectionToken": .string(UUID().uuidString), "mic": .string("mic-a")],
            owner: "gui", connected: { true }) }
        try await waitUntil { await driver.first.acquisitionWaiting }
        _ = await first.value
        let starts = (2...22).map { revision in Task {
            try? await service.start(["selectionRevision": .int(Int64(revision)),
                "selectionToken": .string(UUID().uuidString), "mic": .string("mic-b")],
                owner: "gui", connected: { true })
        } }
        for start in starts { _ = await start.value }
        #expect(await service.pendingOperationCount <= 3)
        #expect(driver.madeCount == 1)
        await driver.first.releaseAcquisition()
        try await service.stopAll()
        #expect(await service.quiescent)
        let fresh = try await service.start(["selectionRevision": .int(23),
            "selectionToken": .string(UUID().uuidString), "mic": .string("mic-b")],
            owner: "gui", connected: { true })
        #expect(fresh["microphone"]?.string == "mic-b")
        try await service.stopAll()
    }

    @Test("A revoked screen permission prevents later snapshot acquisition")
    func permissionFreshness() async throws {
        let driver = PreviewDriverFixture(), permission = PreviewPermissionToggle()
        let service = CapturePreflight(catalog: PreviewCatalog(),
            permissions: .init(check: { _ in permission.status }), drivers: driver.drivers,
            excluding: [], publish: { _ in })
        let ack = try await service.start(["selectionRevision": .int(1), "selectionToken": .string(UUID().uuidString), "display": .string("main")],
            owner: "gui", connected: { true })
        permission.deny()
        await #expect(throws: ControlFailure.self) {
            try await service.snapshot(owner: "gui", token: try #require(ack["previewToken"]?.string))
        }
        #expect(await driver.screen.calls == 0)
        try await service.stopAll()
    }

    @Test("An expired screenshot cannot acquire after a delayed permission check")
    func expiredPermissionResponse() async throws {
        let driver = PreviewDriverFixture(), permission = PreviewPermissionGate()
        let service = CapturePreflight(catalog: PreviewCatalog(),
            permissions: .init(check: { _ in await permission.check() }), drivers: driver.drivers,
            excluding: [], budgetNs: 30_000_000, publish: { _ in })
        let ack = try await service.start(["selectionRevision": .int(1),
            "selectionToken": .string(UUID().uuidString), "display": .string("main")],
            owner: "gui", connected: { true })
        await permission.park()
        let snapshot = Task { try? await service.snapshot(owner: "gui",
            token: try #require(ack["previewToken"]?.string)) }
        try await waitUntil { await permission.waiting }
        _ = await snapshot.value
        await permission.release()
        try await waitUntil { await service.pendingOperationCount == 0 }
        #expect(await driver.screen.calls == 0)
        try await service.stopAll()
    }

    @Test("Expired completion waiters are removed while native work remains pending")
    func boundedCompletionWaiters() async throws {
        let completion = PreflightCompletion<Int>()
        let calls = (0..<100).map { _ in Task {
            try? await completion.value(deadline: .now() + .milliseconds(10))
        } }
        for call in calls { _ = await call.value }
        #expect(completion.waiterCount == 0)
        completion.resolve(.success(42))
        completion.resolve(.success(99))
        #expect(try await completion.value(deadline: .now() + .seconds(1)) == 42)
    }

    @Test("Explicit generated mode exercises native commands, JPEGs, levels and cleanup without devices")
    func generatedCommandWorkflow() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("preflight-generated-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let controller = try EngineController(config: .init(recordingsRoot: root.appendingPathComponent("library"),
            indexDatabaseURL: root.appendingPathComponent("index.sqlite"),
            catalog: DiagnosticSourceCatalog(), captureRigs: StubCaptureRigFactory(), capturePreflightMode: .generated))
        let gui = ControlExchange(connectionID: "generated")
        func command(_ name: String, _ values: [String: JSONValue] = [:]) async {
            await controller.handle(.init(id: UUID().uuidString, cmd: name, args: .object(values)), context: gui.context)
        }
        let selection = UUID().uuidString
        await command("capture.preflight.start", ["selectionToken": .string(selection),
            "selectionRevision": .int(1), "mic": .string("default"), "display": .string("main")])
        #expect(gui.lastResponse?.ok == true)
        let token = try #require(gui.lastResponse?.result?["previewToken"]?.string)
        #expect(gui.lastResponse?.result?["microphone"]?.string == "mic-diagnostic")
        await command("capture.preflight.snapshot", ["previewToken": .string(token)])
        let encoded = try #require(gui.lastResponse?.result?["jpeg"]?.string)
        let bytes = try #require(Data(base64Encoded: encoded))
        let image = try #require(CGImageSourceCreateWithData(bytes as CFData, nil))
        #expect(CGImageSourceGetCount(image) == 1 && bytes.count <= 262_144)
        #expect(gui.lastResponse?.result?["width"]?.int == 640)
        await command("camera.preview.start", ["camera": .string("default")])
        for _ in 0..<100 {
            if gui.events.contains(where: { $0.event == "camera-preview" })
                && gui.events.contains(where: { $0.result?["clipping"]?.bool == true }) { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(gui.events.contains { $0.event == "camera-preview" })
        #expect(gui.events.contains { $0.event == "microphone-level"
            && $0.result?["previewToken"]?.string == token && $0.result?["clipping"]?.bool == true })
        await command("capture.preflight.stop", ["selectionToken": .string(selection), "selectionRevision": .int(1)])
        #expect(gui.lastResponse?.result?["quiescent"]?.bool == true)
        await command("camera.preview.stop")
        let count = gui.events.count
        try await Task.sleep(for: .milliseconds(150))
        #expect(gui.events.count == count)
        await command("capture.preflight.start", ["selectionToken": .string(UUID().uuidString),
            "selectionRevision": .int(2), "window": .string("window-diagnostic")])
        let windowToken = try #require(gui.lastResponse?.result?["previewToken"]?.string)
        await command("capture.preflight.snapshot", ["previewToken": .string(windowToken)])
        #expect(gui.lastResponse?.result?["source"]?.string == "window-diagnostic")
        #expect(gui.lastResponse?.result?["width"]?.int == 320)
        _ = await controller.shutdown()
    }

    private func waitUntil(_ ready: @escaping @Sendable () async -> Bool) async throws {
        for _ in 0..<200 {
            if await ready() { return }
            try await Task.sleep(for: .milliseconds(2))
        }
        throw ControlFailure(code: "fixture-timeout")
    }
}

private struct PreviewCatalog: SourceCataloging {
    func displays() async throws -> [DisplaySource] {
        [.init(id: "display-test", name: "Generated", widthPoints: 640, heightPoints: 480, isMain: true)]
    }
    func windows() async throws -> [WindowSource] {
        [.init(id: "window-test", title: "Generated", owningApplication: "example", displayID: "display-test"),
         .init(id: "window-ours", title: "Rushes", owningApplication: "rushes", displayID: "display-test")]
    }
    func cameras() async throws -> [CameraDevice] { [] }
    func microphones() async throws -> [MicrophoneDevice] {
        [.init(id: "mic-a", name: "A"), .init(id: "mic-b", name: "B")]
    }
}

private final class PreviewDriverFixture: @unchecked Sendable {
    let first = PreviewMicrophoneFixture(), second = PreviewMicrophoneFixture()
    let screen = PreviewScreenFixture()
    private let lock = NSLock()
    private var made = 0
    var madeCount: Int { lock.withLock { made } }
    var drivers: CapturePreflightDrivers {
        .init(microphone: { [self] in
            lock.withLock { made += 1; return made == 1 ? first : second }
        }, snapshot: { [self] surface, _ in try await screen.snapshot(surface) })
    }
}

private actor PreviewMicrophoneFixture: MicrophonePreviewing {
    private var parkedStart = false, parkedStop = false
    private var startRelease: CheckedContinuation<Void, Never>?, stopRelease: CheckedContinuation<Void, Never>?
    private var receive: (@Sendable (MicrophoneLevels?) -> Void)?
    private(set) var stopCount = 0
    var acquisitionWaiting: Bool { startRelease != nil }
    var drainWaiting: Bool { stopRelease != nil }
    func parkAcquisition() { parkedStart = true }
    func parkDrain() { parkedStop = true }
    func releaseAcquisition() { startRelease?.resume(); startRelease = nil }
    func releaseDrain() { stopRelease?.resume(); stopRelease = nil }
    func start(deviceID: String, receive: @escaping @Sendable (MicrophoneLevels?) -> Void) async throws {
        self.receive = receive
        if parkedStart { parkedStart = false; await withCheckedContinuation { startRelease = $0 } }
    }
    func emit(_ value: MicrophoneLevels) { receive?(value) }
    func stop() async {
        stopCount += 1
        if parkedStop { parkedStop = false; await withCheckedContinuation { stopRelease = $0 } }
    }
}

private actor PreviewScreenFixture {
    private var parked = false
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var calls = 0
    var waiting: Bool { continuation != nil }
    func park() { parked = true }
    func release() { continuation?.resume(); continuation = nil }
    func snapshot(_ surface: ScreenSurface) async throws -> ScreenPreviewImage {
        calls += 1
        if parked { parked = false; await withCheckedContinuation { continuation = $0 } }
        return try NativeScreenPreview.generated(surface: surface)
    }
}

private actor PreflightAttachCounter: CaptureRigFactory, CaptureRig {
    private(set) var attachCount = 0
    func attach(_ context: CaptureContext) async throws -> any CaptureRig { attachCount += 1; return self }
    func gateOpened(epochHostNs: Int64) async {}
    func stop() async {}
}

private final class PreviewPermissionToggle: @unchecked Sendable {
    private let lock = NSLock()
    private var allowed = true
    var status: PermissionStatus { lock.withLock { .init(state: allowed ? .allowed : .denied) } }
    func deny() { lock.withLock { allowed = false } }
}

private actor PreviewPermissionGate {
    private var parked = false
    private var continuation: CheckedContinuation<Void, Never>?
    var waiting: Bool { continuation != nil }
    func park() { parked = true }
    func release() { continuation?.resume(); continuation = nil }
    func check() async -> PermissionStatus {
        if parked { parked = false; await withCheckedContinuation { continuation = $0 } }
        return .init(state: .allowed)
    }
}
