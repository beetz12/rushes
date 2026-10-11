import AVFoundation
import Darwin
import Foundation
import Testing

@testable import RushCore

// MARK: - Shared fixtures

/// A catalog with fixed contents so the controller never touches live
/// device discovery (same shape as the session suite's stub).
private struct StubCatalog: SourceCataloging {
    func displays() async throws -> [DisplaySource] {
        [DisplaySource(
            id: "display-1", name: "Built-in",
            widthPoints: 640, heightPoints: 480, isMain: true)]
    }
    func windows() async throws -> [WindowSource] { [] }
    func cameras() async throws -> [CameraDevice] {
        [CameraDevice(id: "dev-facecam", name: "FaceTime HD Camera")]
    }
    func microphones() async throws -> [MicrophoneDevice] {
        [MicrophoneDevice(id: "dev-mic", name: "MacBook Pro Microphone")]
    }
}

private func tempDirectory(_ label: String) throws -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("control-\(label)-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// A socket path under 104 characters (the sockaddr_un limit): the system
/// temp folder's path is already long, so sockets get a short /tmp name.
private func shortTempSocket(_ label: String) -> URL {
    let suffix = UUID().uuidString.prefix(8)
    return URL(fileURLWithPath: "/tmp/rctl-\(label)-\(suffix)/control.sock")
}

/// Writers built with H.264 preferred for video, so the suite runs headless
/// without depending on a hardware HEVC encoder (same technique as the
/// session suite).
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

/// Collects replies and events the controller emits through a command
/// context; thread-safe because handlers run off the actor.
final class ControlExchange: @unchecked Sendable {
    let context: ControlCommandContext
    private let box = ControlExchangeBox()

    init(connectionID: String? = nil) {
        let box = box
        self.context = ControlCommandContext(
            reply: { response in box.append(response) },
            broadcast: { event in box.append(event) }, connectionID: connectionID)
    }

    var responses: [ControlResponse] {
        box.allResponses()
    }

    var events: [ControlEvent] {
        box.allEvents()
    }

    var lastResponse: ControlResponse? {
        responses.last
    }

    /// Waits until an event of `kind` arrives, up to `timeout` seconds.
    func event(_ kind: ControlEventKind, timeout: TimeInterval = 10) -> ControlEvent? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let found = events.first(where: { $0.event == kind.rawValue }) {
                return found
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return events.first { $0.event == kind.rawValue }
    }
}

/// Locked storage behind `ControlExchange`; the exchange keeps one box so
/// both closures append through the same lock.
final class ControlExchangeBox: @unchecked Sendable {
    private let lock = NSLock()
    private var responses: [ControlResponse] = []
    private var events: [ControlEvent] = []

    func append(_ response: ControlResponse) {
        lock.lock()
        responses.append(response)
        lock.unlock()
    }

    func append(_ event: ControlEvent) {
        lock.lock()
        events.append(event)
        lock.unlock()
    }

    func allResponses() -> [ControlResponse] {
        lock.lock()
        defer { lock.unlock() }
        return responses
    }

    func allEvents() -> [ControlEvent] {
        lock.lock()
        defer { lock.unlock() }
        return events
    }
}

/// Thread-safe event collector for client-side callbacks.
final class EventCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [ControlEvent] = []
    func append(_ event: ControlEvent) {
        lock.lock()
        items.append(event)
        lock.unlock()
    }
    func all() -> [ControlEvent] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }
}

// MARK: - ControlTypes

@Suite("Control wire types")
struct ControlTypesTests {

    @Test("Requests and responses round-trip with the plan's wire shape")
    func roundTrip() throws {
        let request = ControlRequest(
            id: "7", cmd: "record.start",
            args: .object([
                "display": .string("main"),
                "systemAudio": .bool(true),
                "countdownSeconds": .int(3),
            ]))
        let requestData = try ControlWire.encoder.encode(request)
        let decodedRequest = try ControlWire.decoder.decode(
            ControlRequest.self, from: requestData)
        #expect(decodedRequest == request)

        let response = ControlResponse.success(
            id: "7",
            result: .object(["id": .string("01JA3K"), "state": .string("recording")]))
        let responseData = try ControlWire.encoder.encode(response)
        let text = String(data: responseData, encoding: .utf8) ?? ""
        #expect(text.contains("\"id\":\"7\""))
        #expect(text.contains("\"ok\":true"))
        let decoded = try ControlWire.decoder.decode(
            ControlResponse.self, from: responseData)
        #expect(decoded == response)
    }

    @Test("Error payloads flatten their details into the error object")
    func errorFlattening() throws {
        let response = ControlResponse.failure(
            id: "9",
            code: "permission-denied",
            message: "screen recording permission was denied",
            details: [
                "permission": .string("screen"),
                "settings": .string("x-apple.systempreferences:com.apple.preference.security"),
            ])
        let data = try ControlWire.encoder.encode(response)
        let text = String(data: data, encoding: .utf8) ?? ""
        #expect(text.contains("\"permission\":\"screen\""))
        #expect(text.contains("\"code\":\"permission-denied\""))

        // And it decodes back with the details intact.
        let decoded = try ControlWire.decoder.decode(ControlResponse.self, from: data)
        #expect(decoded.error?.details["permission"] == .string("screen"))
        #expect(decoded.error?.code == "permission-denied")
    }

    @Test("Events round-trip and JSONValue preserves structure")
    func eventsAndJSONValue() throws {
        let event = ControlEvent(
            kind: .recordingStarted,
            id: "cli-1",
            recordingId: "01JA3K7Q2V9W8X6Y5Z4T3S2R1P",
            t: 0)
        let data = try ControlWire.encoder.encode(event)
        let decoded = try ControlWire.decoder.decode(ControlEvent.self, from: data)
        #expect(decoded == event)

        let nested: JSONValue = .object([
            "list": .array([.int(1), .int(2)]),
            "name": .string("rushes"),
            "flag": .bool(false),
            "empty": .null,
        ])
        let roundTrip = try JSONValue(encoding: nested)
        #expect(roundTrip == nested)
        #expect(nested["name"]?.string == "rushes")
        #expect(nested["list"]?.array?.count == 2)
        // An int-typed JSON number reads as both int and double.
        #expect(JSONValue.int(2).double == 2)
    }

    @Test("The stable exit-code table maps every documented error class")
    func exitCodeTable() {
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.unknownCommand) == .usage)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.invalidParams) == .usage)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.usage) == .usage)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.permissionDenied) == .permission)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.permissionNotAsked) == .permission)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.engineUnreachable) == .unreachable)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.notFound) == .notFound)
        #expect(ControlExitCode.exitCode(forErrorCode: ControlErrorCode.alreadyActive) == .runtime)
        #expect(ControlExitCode.exitCode(forErrorCode: PreflightFailureCode.lowDisk.rawValue) == .runtime)
        // A future engine's unknown code is a runtime error, never success.
        #expect(ControlExitCode.exitCode(forErrorCode: "from-the-future") == .runtime)
    }
}

// MARK: - Peer credential rule

@Suite("Control peer credentials")
struct ControlPeerTests {

    @Test("The same-user rule accepts a match and refuses a mismatch")
    func rule() {
        let selfUID = UInt32(getuid())
        #expect(PeerCredentialCheck.peerUID(selfUID, matchesExpected: selfUID))
        #expect(!PeerCredentialCheck.peerUID(selfUID, matchesExpected: selfUID + 1))
        #expect(!PeerCredentialCheck.peerUID(selfUID, matchesExpected: selfUID == 0 ? 1 : 0))
    }
}

// MARK: - ControlServer

/// A scripted handler: replies with a fixed result and broadcasts events
/// when asked to.
private struct EchoHandler: ControlHandling {
    func handle(_ request: ControlRequest, context: ControlCommandContext) async {
        if request.cmd == "broadcast.test" {
            context.broadcast(ControlEvent(
                kind: .warning, id: request.id, code: "synthetic", message: nil))
            context.reply(ControlResponse.success(
                id: request.id, result: .object(["echo": .string(request.cmd)])))
            return
        }
        context.reply(ControlResponse.success(
            id: request.id,
            result: .object([
                "echo": .string(request.cmd),
                "args": request.args ?? .null,
            ])))
    }
}

@Suite("ControlServer")
struct ControlServerTests {

    @Test("Folder is 0700, requests answer, malformed lines error, events broadcast, stop cleans up")
    func serverLifecycle() async throws {
        let socketPath = shortTempSocket("srv")
        let scratch = socketPath.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let server = ControlServer(socketPath: socketPath, handler: EchoHandler())
        try server.start()
        defer { server.stop() }

        // The socket's folder was created mode 0700.
        let folder = socketPath.deletingLastPathComponent()
        #expect(folder.path.count < 104)
        let attributes = try FileManager.default.attributesOfItem(atPath: folder.path)
        let permissions = (attributes[.posixPermissions] as? NSNumber)?.int16Value ?? 0
        #expect(permissions == 0o700)

        // Request/response round trip on the real socket.
        let client = try ControlClient.connect(to: socketPath)
        defer { client.close() }
        let request = ControlRequest(
            id: "t1", cmd: "ping",
            args: .object(["n": .int(1)]))
        let (response, events) = try client.roundTrip(request, timeout: 5)
        #expect(response.ok)
        #expect(response.id == "t1")
        #expect(events.isEmpty)
        #expect(response.result?["echo"]?.string == "ping")

        // A second request on the same connection.
        let (second, _) = try client.roundTrip(
            ControlRequest(id: "t2", cmd: "echo"), timeout: 5)
        #expect(second.ok)

        // Broadcasts reach every connected client, tagged with the
        // originating request id.
        let listener = try ControlClient.connect(to: socketPath)
        defer { listener.close() }
        let heard = EventCollector()
        let (broadcastResponse, broadcastEvents) = try client.roundTrip(
            ControlRequest(id: "t3", cmd: "broadcast.test"),
            timeout: 5,
            onEvent: { heard.append($0) })
        #expect(broadcastResponse.ok)
        #expect(broadcastEvents.count == 1)
        #expect(heard.all().count == 1)
        #expect(broadcastEvents.first?.code == "synthetic")
        #expect(broadcastEvents.first?.id == "t3")
        // The other client heard the same line.
        let heardLine = try listener.readLine(timeout: 5)
        let heardEvent = try ControlWire.decoder.decode(
            ControlEvent.self, from: heardLine ?? Data())
        #expect(heardEvent.code == "synthetic")

        // A malformed line gets a JSON error, not a hang or a crash.
        try client.sendLine(Data("this is not json\n".utf8))
        if let line = try client.readLine(timeout: 5) {
            let failure = try ControlWire.decoder.decode(
                ControlResponse.self, from: line)
            #expect(!failure.ok)
            #expect(failure.error?.code == ControlErrorCode.invalidParams)
        } else {
            Issue.record("malformed line produced no reply")
        }

        // Stop removes the socket file; a second start can bind again.
        server.stop()
        #expect(!FileManager.default.fileExists(atPath: socketPath.path))
        let reborn = ControlServer(socketPath: socketPath, handler: EchoHandler())
        try reborn.start()
        reborn.stop()
    }

    @Test("A live socket at the path refuses a second server")
    func refusesSecondServer() async throws {
        let socketPath = shortTempSocket("busy")
        let scratch = socketPath.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let server = ControlServer(socketPath: socketPath, handler: EchoHandler())
        try server.start()
        defer { server.stop() }

        let rival = ControlServer(socketPath: socketPath, handler: EchoHandler())
        do {
            try rival.start()
            Issue.record("a second server should not bind a live socket")
        } catch let error as ControlServerError {
            guard case .alreadyRunning = error else {
                Issue.record("unexpected error \(error)")
                return
            }
        }
    }
}

// MARK: - EngineController

@Suite("EngineController")
struct EngineControllerTests {

    private func makeController(
        root: URL, indexURL: URL
    ) throws -> EngineController {
        try EngineController(config: EngineControllerConfig(
            recordingsRoot: root,
            indexDatabaseURL: indexURL,
            catalog: StubCatalog(),
            volumeProvider: { _ in VolumeInfo(availableBytes: 100 * 1024 * 1024 * 1024) },
            makeWriter: h264WriterOpener,
            captureRigs: StubCaptureRigFactory()))
    }

    private func startRequest(
        display: String = "display-1",
        duration: Double? = nil,
        title: String? = "Control test"
    ) -> ControlRequest {
        var args: [String: JSONValue] = [
            "display": .string(display),
            "mic": .string("dev-mic"),
        ]
        if let duration { args["duration"] = .double(duration) }
        if let title { args["title"] = .string(title) }
        return ControlRequest(id: "start-\(UUID().uuidString.prefix(6))", cmd: "record.start", args: .object(args))
    }

    @Test("Guide describes every command, event and exit code")
    func guideDescribesCommands() throws {
        let guide = ControlGuide.make(version: "test", socketPath: "/tmp/x.sock")
        let names = guide.commands.map(\.name)
        for expected in [
            "ping", "version", "guide", "status", "targets",
            "record.start", "record.stop", "record.pause", "record.resume",
            "list", "show", "verify", "selftest.sync", "analyze.clap",
            "export", "share.assets", "transcribe", "captions.export", "meta.generate",
            "mcp.enable", "mcp.disable", "mcp.status", "url.open", "library.refresh",
        ] {
            #expect(names.contains(expected), "guide is missing \(expected)")
        }
        #expect(guide.events.map(\.event).contains("recording-started"))
        #expect(guide.exitCodes.map(\.code).sorted() == [0, 1, 2, 3, 4, 5])
        // The guide itself round-trips.
        let data = try ControlWire.encoder.encode(guide)
        #expect(try ControlWire.decoder.decode(ControlGuide.self, from: data) == guide)
    }

    @Test("Engine exposes routed MCP and validates URL routes before state changes")
    func routedAutomation() async throws {
        let scratch = try tempDirectory("routed-automation")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(root: scratch.appendingPathComponent("root"), indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()
        await controller.handle(.init(id: "enable", cmd: "mcp.enable"), context: exchange.context)
        let enabled = try #require(exchange.lastResponse)
        #expect(enabled.ok && enabled.result?["enabled"]?.bool == true)
        let urlText = try #require(enabled.result?["url"]?.string)
        let url = try #require(URL(string: urlText))
        let token = try #require(enabled.result?["token"]?.string)
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 5
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.httpBody = try ControlWire.encoder.encode(JSONValue.object(["jsonrpc": .string("2.0"), "id": .int(1), "method": .string("tools/call"),
            "params": .object(["name": .string("status"), "arguments": .object([:])])]))
        let (body, response) = try await URLSession.shared.data(for: request)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        let result = try JSONDecoder().decode(JSONValue.self, from: body)
        #expect(result["result"]?["isError"]?.bool == false)
        #expect(result["result"]?["content"]?.array?.first?["text"]?.string?.contains("idle") == true)
        await controller.handle(.init(id: "url", cmd: "url.open", args: .object(["url": .string("rushes://record?unknown=1")])), context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "invalid-url")
        await controller.handle(.init(id: "status", cmd: "status"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["state"]?.string == "idle")
        await controller.handle(.init(id: "disable", cmd: "mcp.disable"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["enabled"]?.bool == false)
        _ = await controller.shutdown()
    }
    @Test("Ping, version, status idle and targets answer")
    func readOnlyCommands() async throws {
        let scratch = try tempDirectory("readonly")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(
            ControlRequest(id: "a", cmd: "ping"), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        #expect(exchange.lastResponse?.result?["pong"]?.bool == true)

        await controller.handle(
            ControlRequest(id: "b", cmd: "version"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["protocol"]?.string == "1")

        await controller.handle(
            ControlRequest(id: "c", cmd: "status"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["state"]?.string == "idle")

        await controller.handle(
            ControlRequest(id: "d", cmd: "targets"), context: exchange.context)
        let displays = exchange.lastResponse?.result?["displays"]?.array
        #expect(displays?.count == 1)
        #expect(displays?.first?["id"]?.string == "display-1")
    }

    @Test("Record start creates the package and the event; stop completes and verifies")
    func recordStartStop() async throws {
        let scratch = try tempDirectory("take")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root", isDirectory: true)
        let controller = try makeController(
            root: root, indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(startRequest(), context: exchange.context)
        let started = exchange.lastResponse
        #expect(started?.ok == true)
        let recordingID = try #require(started?.result?["id"]?.string)
        #expect(recordingID.count == 26)
        let packagePath = try #require(started?.result?["packagePath"]?.string)
        #expect(FileManager.default.fileExists(atPath: packagePath))

        // Mid-recording: the manifest says recording, the event fired.
        let package = try RecordingPackage.open(folderURL: URL(fileURLWithPath: packagePath))
        let midManifest = try package.readManifest()
        #expect(midManifest.status == .recording)
        let startedEvent = exchange.event(.recordingStarted, timeout: 5)
        #expect(startedEvent?.recordingId == recordingID)
        #expect(startedEvent?.t == 0)

        // Status reports the live recording.
        await controller.handle(
            ControlRequest(id: "s", cmd: "status"), context: exchange.context)
        let statusResult = exchange.lastResponse?.result
        #expect(statusResult?["state"]?.string == "recording")

        // Let the stub pump write real samples before stopping.
        try await Task.sleep(nanoseconds: 700_000_000)

        // A second start while active is refused with already-active.
        await controller.handle(startRequest(), context: exchange.context)
        let refused = exchange.lastResponse
        #expect(refused?.ok == false)
        #expect(refused?.error?.code == ControlErrorCode.alreadyActive)

        // Stop: complete, package indexable, verifier green.
        await controller.handle(
            ControlRequest(id: "stop1", cmd: "record.stop"), context: exchange.context)
        let stopped = exchange.lastResponse
        #expect(stopped?.ok == true)
        #expect(stopped?.result?["status"]?.string == "complete")
        let stoppedEvent = exchange.event(.recordingStopped, timeout: 5)
        #expect(stoppedEvent?.recordingId == recordingID)

        let stoppedPackage = try #require(
            RecordingPackage.resolve(root: root, id: recordingID))
        let report = await PackageVerifier().verify(stoppedPackage)
        #expect(report.ok, "verify failed: \(report)")
        for check in report.trackChecks {
            #expect(check.ok, "\(check.file): \(check.issues)")
        }
        let manifest = try stoppedPackage.readManifest()
        #expect(manifest.status == .complete)
        // The stub rig wrote the input timeline.
        #expect(FileManager.default.fileExists(atPath: stoppedPackage.inputURL.path))
    }

    @Test("GUI loss closes idle prewarm; active camera survives GUI loss only until normal Stop")
    func cameraOwnerDisconnect() async throws {
        let scratch = try tempDirectory("preview-owner")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let factory = PreviewLifecycleFactory()
        let controller = try EngineController(config: .init(recordingsRoot: scratch.appendingPathComponent("root"), indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"), catalog: StubCatalog(), makeWriter: h264WriterOpener, captureRigs: factory))
        let exchange = ControlExchange(connectionID: "gui")
        let preview = ControlRequest(id: "warm", cmd: "camera.preview.start", args: .object(["camera": .string("default")]))
        await controller.handle(preview, context: exchange.context)
        await controller.clientDisconnected("gui")
        #expect(await factory.closes == 1)
        await controller.handle(preview, context: exchange.context)
        await controller.handle(startRequest(), context: exchange.context)
        try await Task.sleep(nanoseconds: 200_000_000)
        await controller.clientDisconnected("gui")
        #expect(await factory.closes == 1)
        await controller.handle(ControlRequest(id: "stop-after-gui-loss", cmd: "record.stop"), context: exchange.context)
        #expect(await factory.closes == 2)
    }

    @Test("A GUI can subscribe to an active CLI camera without warming or stopping devices")
    func latePreviewSubscription() async throws {
        let scratch = try tempDirectory("late-preview")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let factory = PreviewRoutingFactory()
        let controller = try EngineController(config: .init(recordingsRoot: scratch.appendingPathComponent("root"), indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"), catalog: StubCatalog(), makeWriter: h264WriterOpener, captureRigs: factory))
        let exchange = ControlExchange()
        await controller.handle(startRequest(), context: exchange.context)
        await factory.publish(Data([1,2,3]))
        #expect(!exchange.events.contains { $0.event == "camera-preview" })
        await controller.handle(ControlRequest(id: "subscribe", cmd: "camera.preview.subscribe", args: .object(["enabled": .bool(true)])), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        await factory.publish(Data([1,2,3]))
        #expect(exchange.events.last?.result?["jpeg"]?.string == "AQID")
        #expect(await factory.closes == 0)
        await controller.handle(ControlRequest(id: "unsubscribe", cmd: "camera.preview.subscribe", args: .object(["enabled": .bool(false)])), context: exchange.context)
        let previews = exchange.events.filter { $0.event == "camera-preview" }.count
        await factory.publish(Data([4,5,6]))
        #expect(exchange.events.filter { $0.event == "camera-preview" }.count == previews)
        #expect(await factory.closes == 0)
        await controller.handle(ControlRequest(id: "subscribe-again", cmd: "camera.preview.subscribe", args: .object(["enabled": .bool(true)])), context: exchange.context)
        await controller.handle(ControlRequest(id: "stop", cmd: "record.stop"), context: exchange.context)
        #expect(await factory.closes == 1)
    }

    @Test("Screen request history is scoped to app identity, separate from bare engine QA")
    func permissionMarkerIdentity() {
        let first = SystemPermissions.markerKey(bundleID: "ai.rushes.app", executablePath: "/tmp/one/engine")
        let relocated = SystemPermissions.markerKey(bundleID: "ai.rushes.app", executablePath: "/Applications/Rushes.app/engine")
        let otherApp = SystemPermissions.markerKey(bundleID: "another.app", executablePath: "/tmp/one/engine")
        let bare = SystemPermissions.markerKey(bundleID: nil, executablePath: "/tmp/one/engine")
        #expect(first == relocated)
        #expect(first != otherApp)
        #expect(first != bare)
    }

    @Test("Unasked screen permission never calls the shareable-content catalog")
    func noImplicitScreenPrompt() async throws {
        let scratch = try tempDirectory("permission-catalog")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let catalog = PromptGuardCatalog()
        let advisor = PermissionAdvisor { kind in .init(state: kind == .screen ? .notAsked : .allowed) }
        let controller = try EngineController(config: .init(recordingsRoot: scratch.appendingPathComponent("root"), indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"), catalog: catalog, permissionAdvisor: advisor, makeWriter: h264WriterOpener, captureRigs: StubCaptureRigFactory()))
        let exchange = ControlExchange()
        await controller.handle(ControlRequest(id: "targets", cmd: "targets"), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        #expect(exchange.lastResponse?.result?["displays"]?.array?.isEmpty == true)
        #expect(exchange.lastResponse?.result?["permissions"]?["screen"]?.string == "not-determined")
        await controller.handle(startRequest(), context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "permission-not-asked")
        #expect(await catalog.screenCalls == 0)
        await controller.handle(ControlRequest(id: "mic-only", cmd: "record.start", args: .object(["mic": .string("default")])), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        #expect(await catalog.screenCalls == 0)
        await controller.handle(ControlRequest(id: "stop", cmd: "record.stop"), context: exchange.context)
    }

    @Test("Camera stays warm only for explicit preview; ordinary CLI takes release it")
    func cameraReleasePolicy() async throws {
        let scratch = try tempDirectory("camera-release")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let factory = PreviewLifecycleFactory()
        let controller = try EngineController(config: .init(recordingsRoot: scratch.appendingPathComponent("root"), indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"), catalog: StubCatalog(), makeWriter: h264WriterOpener, captureRigs: factory))
        let exchange = ControlExchange()
        await controller.handle(startRequest(), context: exchange.context)
        try await Task.sleep(nanoseconds: 200_000_000)
        await controller.handle(ControlRequest(id: "stop-ordinary", cmd: "record.stop"), context: exchange.context)
        #expect(await factory.closes == 1)
        await controller.handle(ControlRequest(id: "preview", cmd: "camera.preview.start", args: .object(["camera": .string("default")])), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        await controller.handle(startRequest(), context: exchange.context)
        try await Task.sleep(nanoseconds: 200_000_000)
        await controller.handle(ControlRequest(id: "stop-with-preview", cmd: "record.stop"), context: exchange.context)
        #expect(await factory.closes == 1)
        await controller.handle(ControlRequest(id: "close-preview", cmd: "camera.preview.stop"), context: exchange.context)
        #expect(await factory.closes == 2)
    }

    @Test("Countdown cancellation removes only its own new package and concurrent start refuses")
    func cancelCountdown() async throws {
        let scratch = try tempDirectory("cancel")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root")
        let controller = try makeController(root: root, indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()
        let task = Task { await controller.handle(ControlRequest(id: "countdown", cmd: "record.start", args: .object(["display": .string("main"), "countdownSeconds": .int(1)])), context: exchange.context) }
        try await Task.sleep(nanoseconds: 250_000_000)
        await controller.handle(startRequest(), context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "already-active")
        await controller.handle(ControlRequest(id: "cancel", cmd: "record.cancel"), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        await task.value
        #expect(exchange.responses.first(where: { $0.id == "countdown" })?.error?.code == "cancelled")
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
    }

    @Test("Mute and bubble metadata persist; restart creates a fresh take and discard removes it")
    func recordingControls() async throws {
        let scratch = try tempDirectory("controls")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root")
        let controller = try makeController(root: root, indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()
        await controller.handle(startRequest(), context: exchange.context)
        let first = try #require(exchange.lastResponse?.result?["id"]?.string)
        await controller.handle(ControlRequest(id: "mute", cmd: "record.mute", args: .object(["track": .string("microphone"), "muted": .bool(true)])), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        await controller.handle(ControlRequest(id: "bubble", cmd: "record.bubble", args: .object(["center": .array([.double(0.1), .double(0.2)]), "size": .int(160), "sizeFraction": .double(0.125)])), context: exchange.context)
        let package = try #require(RecordingPackage.resolve(root: root, id: first))
        #expect(try package.readManifest().bubble?.center == [0.1,0.2])
        #expect(try package.readManifest().bubble?.sizeFraction == 0.125)
        for value in [JSONValue.double(0), .double(1.1), .double(-0.5), .null, .string("bad")] {
            await controller.handle(ControlRequest(id: "bad-fraction", cmd: "record.bubble", args: .object(["center": .array([.double(0.1), .double(0.2)]), "sizeFraction": value])), context: exchange.context)
            #expect(exchange.lastResponse?.error?.code == "invalid-params")
        }
        try await Task.sleep(nanoseconds: 250_000_000)
        await controller.handle(ControlRequest(id: "restart", cmd: "record.restart"), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        let second = try #require(exchange.lastResponse?.result?["id"]?.string)
        #expect(first != second)
        #expect((try? package.readManifest().id) != first)
        await controller.handle(ControlRequest(id: "discard", cmd: "record.discard"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["discarded"]?.bool == true)
        #expect(RecordingPackage.resolve(root: root, id: second) == nil)
    }

    @Test("Stop by a wrong id is not-found; stop with nothing active is not-recording")
    func stopGuards() async throws {
        let scratch = try tempDirectory("stopguards")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(
            ControlRequest(id: "1", cmd: "record.stop", args: .object(["id": .string("01JANOTREAL0000000000000000")])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == ControlErrorCode.notRecording)

        await controller.handle(startRequest(), context: exchange.context)
        try await Task.sleep(nanoseconds: 500_000_000)
        await controller.handle(
            ControlRequest(id: "2", cmd: "record.stop", args: .object(["id": .string("01JANOTREAL0000000000000000")])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == ControlErrorCode.notFound)

        // Clean up the active take.
        await controller.handle(
            ControlRequest(id: "3", cmd: "record.stop"), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
    }

    @Test("Pause and resume emit state events and land in the manifest clock")
    func pauseResume() async throws {
        let scratch = try tempDirectory("pause")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root", isDirectory: true)
        let controller = try makeController(
            root: root, indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(startRequest(), context: exchange.context)
        let recordingID = try #require(exchange.lastResponse?.result?["id"]?.string)

        // Pause and resume without a stop is not-recording first.
        await controller.handle(
            ControlRequest(id: "p0", cmd: "record.pause"), context: exchange.context)
        // (A recording IS active here, so this one succeeds; the guard case
        // lives in stopGuards.)
        #expect(exchange.lastResponse?.ok == true)

        await controller.handle(
            ControlRequest(id: "r", cmd: "record.resume"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["state"]?.string == "recording")

        let stateEvents = exchange.events.filter { $0.event == ControlEventKind.stateChanged.rawValue }
        #expect(stateEvents.map(\.state) == ["armed", "paused", "recording"])
        #expect(stateEvents.allSatisfy { $0.recordingId == recordingID })

        await controller.handle(
            ControlRequest(id: "s", cmd: "record.stop"), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)

        let package = try #require(RecordingPackage.resolve(root: root, id: recordingID))
        let manifest = try package.readManifest()
        #expect(manifest.clock?.pausesNs.isEmpty == false)
    }

    @Test("Duration auto-stops the take")
    func durationStop() async throws {
        let scratch = try tempDirectory("duration")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(
            startRequest(duration: 1.0), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        let stopped = exchange.event(.recordingStopped, timeout: 10)
        #expect(stopped != nil)
        #expect(stopped?.result?["status"]?.string == "complete")
        // Nothing is active any more.
        await controller.handle(
            ControlRequest(id: "after", cmd: "status"), context: exchange.context)
        #expect(exchange.lastResponse?.result?["state"]?.string == "idle")
    }

    @Test("Wait mode: the response arrives only after the stop")
    func waitMode() async throws {
        let scratch = try tempDirectory("wait")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        var args: [String: JSONValue] = [
            "display": .string("display-1"),
            "duration": .double(1.0),
            "wait": .bool(true),
        ]
        let request = ControlRequest(id: "w1", cmd: "record.start", args: .object(args))
        args.removeValue(forKey: "wait")
        await controller.handle(request, context: exchange.context)

        // The single response for w1 is the stop outcome, and the events
        // streamed before it.
        let waitResponse = try #require(exchange.responses.first { $0.id == "w1" })
        #expect(waitResponse.ok)
        #expect(waitResponse.result?["status"]?.string == "complete")
        let startedEvent = exchange.event(.recordingStarted, timeout: 5)
        #expect(startedEvent?.id == "w1")
        let stoppedEvent = exchange.event(.recordingStopped, timeout: 5)
        #expect(stoppedEvent?.id == "w1")
    }

    @Test("List reads the index; show returns manifest and absolute paths; verify reports")
    func listShowVerify() async throws {
        let scratch = try tempDirectory("listshow")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root", isDirectory: true)
        let controller = try makeController(
            root: root, indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        // A first take, stopped by its duration timer so it holds samples.
        await controller.handle(
            startRequest(duration: 0.8, title: "first"), context: exchange.context)
        let firstID = try #require(exchange.lastResponse?.result?["id"]?.string)
        let firstStop = exchange.event(.recordingStopped, timeout: 10)
        #expect(firstStop?.result?["status"]?.string == "complete")

        // list: the index row exists.
        await controller.handle(
            ControlRequest(id: "l", cmd: "list"), context: exchange.context)
        let listed = exchange.lastResponse?.result?["recordings"]?.array
        #expect(listed?.contains { $0["id"]?.string == firstID } == true)
        #expect(listed?.first?["status"]?.string == "complete")

        // show: manifest plus absolute track paths.
        await controller.handle(
            ControlRequest(id: "sh", cmd: "show", args: .object(["id": .string(firstID)])),
            context: exchange.context)
        let shown = exchange.lastResponse?.result
        #expect(shown?["manifest"]?["id"]?.string == firstID)
        let tracks = shown?["tracks"]?.array ?? []
        #expect(!tracks.isEmpty)
        let canonicalRoot = RecordingPackage.canonicalRoot(root)
        for track in tracks {
            let path = track["path"]?.string ?? ""
            #expect(
                path.hasPrefix(canonicalRoot.path),
                "\(path) is not under \(canonicalRoot.path)")
        }

        // verify on the good package.
        await controller.handle(
            ControlRequest(id: "v1", cmd: "verify", args: .object(["id": .string(firstID)])),
            context: exchange.context)
        #expect(exchange.lastResponse?.result?["ok"]?.bool == true)

        // Break the package: remove a track file; verify must go red.
        let package = try #require(RecordingPackage.resolve(root: root, id: firstID))
        try FileManager.default.removeItem(at: package.trackURL(for: .microphone))
        await controller.handle(
            ControlRequest(id: "v2", cmd: "verify", args: .object(["id": .string(firstID)])),
            context: exchange.context)
        #expect(exchange.lastResponse?.result?["ok"]?.bool == false)

        // An unknown id is not-found (CLI exit 5).
        await controller.handle(
            ControlRequest(id: "v3", cmd: "verify", args: .object(["id": .string("01JANOTREAL0000000000000000")])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == ControlErrorCode.notFound)
    }

    @Test("Unknown commands and invalid params are usage errors")
    func usageErrors() async throws {
        let scratch = try tempDirectory("usage")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(
            ControlRequest(id: "u1", cmd: "frobnicate"), context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == ControlErrorCode.unknownCommand)
        #expect(
            ControlExitCode.exitCode(
                forErrorCode: exchange.lastResponse?.error?.code ?? "")
                == .usage)

        // Nothing to record: no screen target and no inputs.
        await controller.handle(
            ControlRequest(id: "u2", cmd: "record.start", args: .object([:])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == ControlErrorCode.invalidParams)

        // An unknown display id.
        await controller.handle(
            ControlRequest(
                id: "u3", cmd: "record.start",
                args: .object(["display": .string("display-99")])),
            context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == "unknown-source")

        // show without an id.
        await controller.handle(
            ControlRequest(id: "u4", cmd: "show"), context: exchange.context)
        #expect(exchange.lastResponse?.error?.code == ControlErrorCode.invalidParams)
    }

    @Test("A full four-track take completes and verifies through the stub rig")
    func fourTrackTake() async throws {
        let scratch = try tempDirectory("fourtrack")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("root", isDirectory: true)
        let controller = try makeController(
            root: root, indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        let request = ControlRequest(
            id: "full", cmd: "record.start",
            args: .object([
                "display": .string("display-1"),
                "camera": .string("dev-facecam"),
                "mic": .string("dev-mic"),
                "systemAudio": .bool(true),
                "duration": .double(1.5),
                "wait": .bool(true),
            ]))
        await controller.handle(request, context: exchange.context)
        let response = try #require(exchange.responses.first { $0.id == "full" })
        #expect(response.ok)
        #expect(response.result?["status"]?.string == "complete")
        let recordingID = try #require(response.result?["id"]?.string)

        let package = try #require(RecordingPackage.resolve(root: root, id: recordingID))
        let manifest = try package.readManifest()
        let roles = manifest.tracks.map { RecordingManifest.RecordingTrack.roleString(for: $0.kind) }
        #expect(roles == ["screen", "camera", "mic", "system"])
        #expect(manifest.tracks.allSatisfy { $0.present })

        let report = await PackageVerifier().verify(package)
        #expect(report.ok, "verify failed: \(report)")
    }

    @Test("Shutdown stops an active recording")
    func shutdownStopsTake() async throws {
        let scratch = try tempDirectory("shutdown")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try makeController(
            root: scratch.appendingPathComponent("root", isDirectory: true),
            indexURL: scratch.appendingPathComponent("index.sqlite"))
        let exchange = ControlExchange()

        await controller.handle(startRequest(), context: exchange.context)
        #expect(exchange.lastResponse?.ok == true)
        try await Task.sleep(nanoseconds: 500_000_000)
        let outcome = await controller.shutdown()
        #expect(outcome != nil)
        #expect(exchange.event(.recordingStopped, timeout: 5) != nil)
    }
}


@Suite("Socket descriptor lifetime")
struct SocketDescriptorLifetimeTests {
    @Test("A second close cannot close an unrelated reused descriptor")
    func reusedDescriptor() throws {
        var pair: [Int32] = [-1,-1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
        // Reserve a high descriptor range for this test. fcntl allocates a
        // free slot; dup2 could close another parallel test's newly opened file.
        let original = fcntl(pair[0], F_DUPFD, 512)
        #expect(original >= 512)
        Darwin.close(pair[0])
        defer { Darwin.close(pair[1]) }
        let socketIO = SocketLineIO(fd: original)
        socketIO.close()
        let file = Darwin.open("/dev/null", O_RDONLY)
        #expect(file >= 0)
        let reused = fcntl(file, F_DUPFD, 512)
        Darwin.close(file)
        #expect(reused == original)
        defer { Darwin.close(reused) }
        socketIO.close()
        #expect(fcntl(reused, F_GETFD) >= 0)
        #expect(!socketIO.writeFully(Data([1])))
    }

    @Test("Closing a blocked reader wakes it before releasing its descriptor")
    func blockedRead() async throws {
        var pair: [Int32] = [-1,-1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &pair) == 0)
        defer { Darwin.close(pair[1]) }
        let socketIO = SocketLineIO(fd: pair[0])
        let reader = Task.detached { socketIO.readLine() }
        try await Task.sleep(nanoseconds: 20_000_000)
        socketIO.close()
        #expect(await reader.value == nil)
        socketIO.close()
    }
}

private actor PreviewLifecycleFactory: CaptureRigFactory {
    private(set) var closes = 0
    func attach(_ context: CaptureContext) async throws -> CaptureRig { try await StubCaptureRigFactory().attach(context) }
    func stopPreview() async { closes += 1 }
}

private actor PromptGuardCatalog: SourceCataloging {
    private(set) var screenCalls = 0
    func displays() async throws -> [DisplaySource] { screenCalls += 1; return [] }
    func windows() async throws -> [WindowSource] { screenCalls += 1; return [] }
    func cameras() async throws -> [CameraDevice] { [] }
    func microphones() async throws -> [MicrophoneDevice] { [.init(id: "safe-mic", name: "Synthetic microphone")] }
}

private actor PreviewRoutingFactory: CaptureRigFactory {
    private var publisher: (@Sendable (Data) -> Void)?
    private(set) var closes = 0
    func attach(_ context: CaptureContext) async throws -> CaptureRig {
        publisher = context.preview
        return try await StubCaptureRigFactory().attach(context)
    }
    func publish(_ data: Data) { publisher?(data) }
    func stopPreview() async { closes += 1 }
}
