import Darwin
import Foundation
import Testing
@testable import RushCore

private struct BridgeEchoHandler: ControlHandling {
    func handle(_ request: ControlRequest, context: ControlCommandContext) async {
        context.reply(.success(id: request.id, result: .object(["cmd": .string(request.cmd)])))
    }
}

@Suite("Desktop cloud service bridge")
struct ShellBridgeTests {
    @Test("A real private socket carries the engine request and response")
    func actualSocket() async throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("sb-\(UUID().uuidString).sock")
        let server = ControlServer(socketPath: path, handler: BridgeEchoHandler())
        try server.start()
        defer { server.stop() }
        let response = try await ShellServiceBridge(socketPath: path).forward(
            ControlRequest(id: "bridge", cmd: "share.setup"))
        #expect(response.ok)
        #expect(response.id == "bridge")
        #expect(response.result?["cmd"]?.string == "share.setup")
        for command in ["share.status", "share.policy.get", "share.policy.set", "share.feedback"] {
            let forwarded = try await ShellServiceBridge(socketPath: path).forward(
                ControlRequest(id: command, cmd: command, args: .object(["id": .string("fixture")])))
            #expect(forwarded.ok && forwarded.result?["cmd"]?.string == command)
        }
        #expect(chmod(path.path, 0o666) == 0)
        do {
            _ = try await ShellServiceBridge(socketPath: path).forward(ControlRequest(id: "bad", cmd: "share"))
            Issue.record("A public socket must be refused")
        } catch let failure as ControlFailure {
            #expect(failure.payload.code == "shell-socket-unsafe")
        }
    }

    @Test("An absent app and unlisted operations fail truthfully")
    func unavailable() async throws {
        let bridge = ShellServiceBridge(socketPath: URL(fileURLWithPath: "/tmp/missing-shell-\(UUID().uuidString).sock"))
        for (command, code) in [("share", "shell-required"), ("record.start", "unknown-command")] {
            do {
                _ = try await bridge.forward(ControlRequest(id: "missing", cmd: command))
                Issue.record("Missing or forbidden service must fail")
            } catch let failure as ControlFailure {
                #expect(failure.payload.code == code)
            }
        }
    }
}
