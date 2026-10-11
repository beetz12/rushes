import AppIntents
import Darwin
import Foundation
import RushCore
import Testing
@testable import RushIntents

private actor StubIntentEngine: ControlHandling {
    let id = "01J00000000000000000000000"
    var seen: [ControlRequest] = []
    var active = false
    let packagePath: String
    init(packagePath: String) { self.packagePath = packagePath }
    func handle(_ request: ControlRequest, context: ControlCommandContext) async {
        seen.append(request)
        switch request.cmd {
        case "record.start":
            guard !active else { context.reply(.failure(id: request.id, code: "already-active", message: "A recording is active.")); return }
            active = true
            context.broadcast(ControlEvent(kind: .warning, code: "stub", message: "No device capture"))
            context.reply(.success(id: request.id, result: .object(["id": .string(id), "packagePath": .string(packagePath), "state": .string("recording")])))
        case "record.stop":
            guard active else { context.reply(.failure(id: request.id, code: "not-recording", message: "No recording is active.")); return }
            active = false
            context.reply(.success(id: request.id, result: .object(["id": .string(id), "packagePath": .string(packagePath), "status": .string("complete")])))
        default: context.reply(.failure(id: request.id, code: "unknown-command"))
        }
    }
    func requests() -> [ControlRequest] { seen }
}
private struct BrokenResultBridge: IntentCommandSending {
    func send(_ request: ControlRequest) async throws -> JSONValue { .object(["id": .string("invented"), "state": .string("recording"), "status": .string("complete"), "packagePath": .string("https://example.com")]) }
}

@Suite("Native App Intents")
struct IntentTests {
    @Test("Default start is screen only; camera and microphone are explicit off")
    func defaults() throws {
        let intent = StartRecordingIntent(), request = try intent.options().request(id: "qa")
        #expect(request.cmd == "record.start")
        #expect(request.args?["display"]?.string == "main")
        #expect(request.args?["camera"]?.string == "none")
        #expect(request.args?["mic"]?.string == "none")
        #expect(request.args?["systemAudio"]?.bool == false)
        #expect(StartRecordingIntent.supportedModes == .background)
    }
    @Test("Display/window/region and chosen device options map to actual engine parameters")
    func sourceOptions() throws {
        var options = IntentStartOptions()
        options.source = .window; options.sourceID = "window-42"; options.camera = .specificDevice; options.cameraID = "camera-synthetic"
        options.microphone = .defaultDevice; options.countdown = 3
        let window = try options.request()
        #expect(window.args?["window"]?.string == "window-42")
        #expect(window.args?["display"] == nil)
        #expect(window.args?["camera"]?.string == "camera-synthetic")
        #expect(window.args?["mic"]?.string == "default")
        #expect(window.args?["countdownSeconds"]?.int == 3)
        options.source = .region; options.sourceID = "display-12"; options.regionX = -120
        #expect(try options.request().args?["area"]?["x"]?.double == -120)
    }
    @Test("Invalid combinations are refused before any control request")
    func invalidOptions() {
        var options = IntentStartOptions(); options.source = .window
        #expect(throws: IntentBridgeError.self) { try options.request() }
        options.source = .cameraOnly
        #expect(throws: IntentBridgeError.self) { try options.request() }
        options.source = .audioOnly
        #expect(throws: IntentBridgeError.self) { try options.request() }
        options.source = .region; options.regionWidth = .nan
        #expect(throws: IntentBridgeError.self) { try options.request() }
        options.source = .display; options.countdown = 11
        #expect(throws: IntentBridgeError.self) { try options.request() }
    }
    @Test("Actual AppIntent perform methods round trip through protected stub engine socket and return id/path")
    func actualPerform() async throws {
        let directory = URL(fileURLWithPath: "/tmp/ri-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: directory) }
        let handler = StubIntentEngine(packagePath: directory.appendingPathComponent("package").path)
        let server = ControlServer(socketPath: directory.appendingPathComponent("control.sock"), handler: handler)
        try server.start(); defer { server.stop() }
        let bridge = IntentEngineBridge(socketPath: server.socketPath, timeout: 2)
        let start = StartRecordingIntent(); let started = try await start.perform(using: bridge)
        #expect(started.value == "01J00000000000000000000000")
        let stop = StopRecordingIntent(); stop.recordingID = started.value
        let stopped = try await stop.perform(using: bridge)
        #expect(stopped.value == directory.appendingPathComponent("package").path)
        let requests = await handler.requests()
        #expect(requests.map(\.cmd) == ["record.start", "record.stop"])
        #expect(requests[1].args?["id"]?.string == started.value)
        await #expect(throws: IntentBridgeError.self) { try await stop.perform(using: bridge) }
    }
    @Test("Missing/insecure sockets and unconfirmed results cannot report success")
    func failures() async throws {
        let directory = URL(fileURLWithPath: "/tmp/ri-\(UUID().uuidString.prefix(8))")
        defer { try? FileManager.default.removeItem(at: directory) }
        await #expect(throws: IntentBridgeError.self) { try await StartRecordingIntent().perform(using: IntentEngineBridge(socketPath: directory.appendingPathComponent("missing.sock"))) }
        await #expect(throws: IntentBridgeError.self) { try await StartRecordingIntent().perform(using: BrokenResultBridge()) }
        await #expect(throws: IntentBridgeError.self) { try await StopRecordingIntent().perform(using: BrokenResultBridge()) }
        let server = ControlServer(socketPath: directory.appendingPathComponent("control.sock"), handler: StubIntentEngine(packagePath: "/tmp/stub"))
        try server.start(); defer { server.stop() }
        chmod(server.socketPath.path, 0o666)
        #expect(throws: IntentBridgeError.self) { try IntentEngineBridge.checkPrivateSocket(server.socketPath) }
    }
}
