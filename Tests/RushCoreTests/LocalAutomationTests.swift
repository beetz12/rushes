import Foundation
import Network
import Testing
@testable import RushCore

@Suite("Opt-in automation lifecycle", .serialized)
struct LocalAutomationTests {
    @Test func persistsExplicitOptInAndKeepsStatusCredentialFree() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mcp-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let service = LocalAutomationService(directory: folder)
        let tools = [MCPTool(command: "status", description: "Read status", readOnly: true),
                     MCPTool(command: "record.start", description: "Start", readOnly: false)]
        let handler: AutomationDispatcher.CommandHandler = { request in .object(["command": .string(request.cmd)]) }
        let before = try await service.handle(.init(id: "status", cmd: "mcp.status"), tools: tools, handler: handler)
        #expect(before["enabled"]?.bool == false)
        #expect(!FileManager.default.fileExists(atPath: folder.path))
        let started = try await service.handle(.init(id: "enable", cmd: "mcp.enable"), tools: tools, handler: handler)
        let token = try #require(started["token"]?.string)
        let urlText = try #require(started["url"]?.string)
        let url = try #require(URL(string: urlText))
        #expect(token.count == 64)
        let attributes = try FileManager.default.attributesOfItem(atPath: folder.appendingPathComponent("token").path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        func invoke(_ command: String, token supplied: String?) async throws -> (Int, JSONValue?) {
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 5
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let supplied { request.setValue("Bearer " + supplied, forHTTPHeaderField: "Authorization") }
            request.httpBody = try ControlWire.encoder.encode(JSONValue.object(["jsonrpc": .string("2.0"), "id": .int(1),
                "method": .string("tools/call"), "params": .object(["name": .string(command), "arguments": .object([:])])]))
            let (data, response) = try await URLSession.shared.data(for: request)
            return ((response as! HTTPURLResponse).statusCode, try? JSONDecoder().decode(JSONValue.self, from: data))
        }
        #expect(try await invoke("status", token: nil).0 == 401)
        #expect(try await invoke("status", token: token).1?["result"]?["isError"]?.bool == false)
        #expect(try await invoke("record.start", token: token).1?["error"]?["code"]?.int == -32003)
        let status = try await service.handle(.init(id: "status", cmd: "mcp.status"), tools: tools, handler: handler)
        #expect(status["token"] == nil)
        await service.shutdown()
        let restored = LocalAutomationService(directory: folder)
        try await restored.restore(tools: tools, handler: handler)
        let afterRestart = try await restored.handle(.init(id: "status", cmd: "mcp.status"), tools: tools, handler: handler)
        #expect(afterRestart["enabled"]?.bool == true)
        #expect(afterRestart["url"]?.string == urlText)
        #expect(try await invoke("status", token: token).1?["result"]?["isError"]?.bool == false)
        let changed = try await restored.handle(.init(id: "mutate", cmd: "mcp.enable", args: .object(["allowMutations": .bool(true)])), tools: tools, handler: handler)
        #expect(changed["url"]?.string == urlText && changed["token"]?.string == token)
        #expect(try await invoke("record.start", token: token).1?["result"]?["isError"]?.bool == false)
        _ = try await restored.handle(.init(id: "disable", cmd: "mcp.disable"), tools: tools, handler: handler)
        let disabled = LocalAutomationService(directory: folder)
        try await disabled.restore(tools: tools, handler: handler)
        #expect(try await disabled.handle(.init(id: "status", cmd: "mcp.status"), tools: tools, handler: handler)["enabled"]?.bool == false)
    }
    @Test func occupiedPairingPortDoesNotSilentlyMoveOrChangeSavedSettings() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("mcp-port-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let service = LocalAutomationService(directory: folder)
        let tools = [MCPTool(command: "status", description: "Status", readOnly: true)]
        let handler: AutomationDispatcher.CommandHandler = { _ in .object(["ready": .bool(true)]) }
        let started = try await service.handle(.init(id: "start", cmd: "mcp.enable"), tools: tools, handler: handler)
        let settings = folder.appendingPathComponent("settings.json")
        let before = try Data(contentsOf: settings)
        let duplicate = LocalAutomationService(directory: folder)
        do {
            try await duplicate.restore(tools: tools, handler: handler)
            Issue.record("An occupied pairing port must fail instead of changing the endpoint")
        } catch let error as NWError {
            if case .posix(.EADDRINUSE) = error { }
            else { Issue.record("Expected address-in-use refusal, received \(error)") }
        } catch { Issue.record("Expected occupied-port network refusal, received \(error)") }
        #expect(try Data(contentsOf: settings) == before)
        #expect(try await duplicate.handle(.init(id: "status", cmd: "mcp.status"), tools: tools, handler: handler)["enabled"]?.bool == false)
        await service.shutdown()
        try await duplicate.restore(tools: tools, handler: handler)
        #expect(try await duplicate.handle(.init(id: "status", cmd: "mcp.status"), tools: tools, handler: handler)["url"] == started["url"])
        await duplicate.shutdown()
    }
    @Test func refusesPublicCredentialAndIncorrectParameterTypes() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("unsafe-mcp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: folder) }
        let service = LocalAutomationService(directory: folder)
        let handler: AutomationDispatcher.CommandHandler = { _ in .null }
        try Data(String(repeating: "a", count: 64).utf8).write(to: folder.appendingPathComponent("token"))
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: folder.appendingPathComponent("token").path)
        await #expect(throws: ControlFailure.self) {
            try await service.handle(.init(id: "unsafe", cmd: "mcp.enable"), tools: [], handler: handler)
        }
        await #expect(throws: ControlFailure.self) {
            try await service.handle(.init(id: "typed", cmd: "mcp.enable", args: .object(["allowMutations": .string("yes")])), tools: [], handler: handler)
        }
    }
}
