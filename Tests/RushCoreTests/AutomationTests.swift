import Foundation
import Testing
@testable import RushCore

private func rpcBody(_ method: String, params: JSONValue? = nil) throws -> Data {
    var object: [String: JSONValue] = ["jsonrpc": .string("2.0"), "id": .int(42), "method": .string(method)]
    if let params { object["params"] = params }
    return try ControlWire.encoder.encode(JSONValue.object(object))
}
private func makeMCP() throws -> AutomationDispatcher {
    try AutomationDispatcher(token: String(repeating: "t", count: 64), tools: [
        MCPTool(command: "status", description: "Recording status", readOnly: true),
        MCPTool(command: "record.start", description: "Start recording", readOnly: false)
    ]) { request in .object(["command": .string(request.cmd)]) }
}
private func mcpHeaders(port: UInt16 = 12345) -> [String: String] {
    ["authorization": "Bearer " + String(repeating: "t", count: 64), "host": "127.0.0.1:\(port)", "content-type": "application/json", "accept": "application/json, text/event-stream"]
}

@Suite("Local automation")
struct AutomationTests {
    @Test("Strict URL routes reject unknown, ambiguous and injectable input", arguments: [
        "https://record", "rushes://unknown", "rushes://record/evil", "rushes://evil@record", "rushes://record:42", "rushes://record#x", "rushes://record?mode=screen&mode=camera", "rushes://record?output=/tmp/evil", "rushes://record?countdown=-1", "rushes://record?systemAudio=1", "rushes://stop?id=invalid", "rushes://record?title=hello%0Aworld"
    ])
    func rejectsURL(text: String) throws {
        let url = try #require(URL(string: text))
        #expect(throws: ControlFailure.self) { try RushURLRoute.parse(url) }
    }
    @Test("Valid URL maps only allowed control commands")
    func validURLs() throws {
        let route = try RushURLRoute.parse(#require(URL(string: "rushes://record?mode=screen&camera=none&systemAudio=true&countdown=3")))
        #expect(route.command == "record.start"); #expect(route.arguments["systemAudio"] == .bool(true))
        #expect(route.arguments["countdown"] == .int(3))
        #expect(try RushURLRoute.parse(#require(URL(string: "rushes://pause"))).command == "record.pause")
    }
    @Test("Bearer, loopback Host and Origin checks reject unsafe clients")
    func authGuards() async throws {
        let dispatcher = try makeMCP(), body = try rpcBody("tools/list")
        var headers = mcpHeaders()
        headers.removeValue(forKey: "authorization")
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 401)
        headers = mcpHeaders(); headers["host"] = "evil.example:12345"
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 403)
        headers = mcpHeaders(); headers["origin"] = "https://evil.example"
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 403)
        headers["origin"] = "null"
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 403)
        headers["origin"] = "http://localhost:12345"
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 200)
    }
    @Test("Tools remain read-only until explicit second switch")
    func readOnlyToggle() async throws {
        let dispatcher = try makeMCP()
        let list = await dispatcher.respond(headers: mcpHeaders(), body: try rpcBody("tools/list"), port: 12345)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: list.body)
        #expect(decoded["result"]?["tools"]?.array?.count == 1)
        let call = try rpcBody("tools/call", params: .object(["name": .string("record.start"), "arguments": .object([:])]))
        let denied = await dispatcher.respond(headers: mcpHeaders(), body: call, port: 12345)
        #expect(try JSONDecoder().decode(JSONValue.self, from: denied.body)["error"]?["code"]?.int == -32003)
        await dispatcher.setAllowMutations(true)
        let allowed = await dispatcher.respond(headers: mcpHeaders(), body: call, port: 12345)
        let result = try JSONDecoder().decode(JSONValue.self, from: allowed.body)
        #expect(result["result"]?["isError"]?.bool == false)
        #expect(String(decoding: allowed.body, as: UTF8.self).contains("record.start"))
    }
    @Test("Real loopback transport lists tools and denies absent auth and external Host")
    func loopbackTransport() async throws {
        let server = try LoopbackMCPServer(dispatcher: makeMCP())
        let port = try await server.start(); defer { server.stop() }
        let url = try #require(URL(string: "http://127.0.0.1:\(port)/mcp"))
        func request(headers: [String: String]) async throws -> (Data, HTTPURLResponse) {
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 5
            request.httpBody = try rpcBody("tools/list")
            for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
            let (data, response) = try await URLSession.shared.data(for: request)
            return (data, try #require(response as? HTTPURLResponse))
        }
        let response = try await request(headers: mcpHeaders(port: port))
        #expect(response.1.statusCode == 200)
        #expect(try JSONDecoder().decode(JSONValue.self, from: response.0)["result"]?["tools"]?.array?.count == 1)
        var unauthorized = mcpHeaders(port: port); unauthorized.removeValue(forKey: "authorization")
        #expect(try await request(headers: unauthorized).1.statusCode == 401)
        var evil = mcpHeaders(port: port); evil["host"] = "evil.example:\(port)"
        #expect(try await request(headers: evil).1.statusCode == 403)
        evil = mcpHeaders(port: port); evil["origin"] = "http://evil.example"
        #expect(try await request(headers: evil).1.statusCode == 403)
    }
    @Test("Invalid framing, protocol and schemas fail closed")
    func protocolGuards() async throws {
        let dispatcher = try makeMCP(), body = try rpcBody("tools/list")
        var headers = mcpHeaders(); headers["mcp-protocol-version"] = "bogus"
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 400)
        headers = mcpHeaders(); headers["Host"] = "localhost:12345"
        #expect(await dispatcher.respond(headers: headers, body: body, port: 12345).status == 400)
        #expect(await dispatcher.respond(method: "GET", headers: mcpHeaders(), body: Data(), port: 12345).status == 405)
        let initResult = await dispatcher.respond(headers: mcpHeaders(), body: try rpcBody("initialize", params: .object(["protocolVersion": .string("2025-06-18")])), port: 12345)
        #expect(try JSONDecoder().decode(JSONValue.self, from: initResult.body)["result"]?["protocolVersion"]?.string == "2025-06-18")
        #expect(throws: ControlFailure.self) { try AutomationDispatcher(token: "short", tools: []) { _ in .null } }
    }
}
