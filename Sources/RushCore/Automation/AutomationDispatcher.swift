import Foundation
import Security

public struct MCPHTTPResponse: Sendable {
    public var status: Int
    public var body: Data
    public init(status: Int, body: Data = Data()) { self.status = status; self.body = body }
}

public struct MCPTool: Sendable {
    public var command: String
    public var description: String
    public var inputSchema: JSONValue
    public var readOnly: Bool
    public init(command: String, description: String, inputSchema: JSONValue = .object(["type": .string("object")]), readOnly: Bool) {
        self.command = command; self.description = description; self.inputSchema = inputSchema; self.readOnly = readOnly
    }
}

public actor AutomationDispatcher {
    public typealias CommandHandler = @Sendable (ControlRequest) async throws -> JSONValue
    private let token: String
    private var allowMutations: Bool
    private let tools: [MCPTool]
    private let handler: CommandHandler
    public init(token: String, allowMutations: Bool = false, tools: [MCPTool], handler: @escaping CommandHandler) throws {
        guard token.utf8.count >= 32, !token.contains(where: \.isWhitespace), Set(tools.map(\.command)).count == tools.count else {
            throw ControlFailure(code: "invalid-params", message: "MCP requires a unique tool table and a bearer token of at least 32 bytes.")
        }
        self.token = token; self.allowMutations = allowMutations; self.tools = tools; self.handler = handler
    }
    public func setAllowMutations(_ enabled: Bool) { allowMutations = enabled }
    public static func randomToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ControlFailure(code: "secure-random-failed")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
    public func respond(method: String = "POST", path: String = "/mcp", headers: [String: String], body: Data, port: UInt16) async -> MCPHTTPResponse {
        var normalized: [String: String] = [:]
        for (key, value) in headers {
            let lower = key.lowercased()
            guard normalized[lower] == nil else { return .init(status: 400) }
            normalized[lower] = value
        }
        guard let authorization = normalized["authorization"], constantTimeEqual(authorization, "Bearer " + token) else { return .init(status: 401) }
        let hosts = ["127.0.0.1:\(port)", "localhost:\(port)", "[::1]:\(port)"]
        guard let host = normalized["host"], hosts.contains(host.lowercased()) else { return .init(status: 403) }
        if let origin = normalized["origin"], !hosts.map({ "http://" + $0 }).contains(origin.lowercased()) { return .init(status: 403) }
        guard path == "/mcp" else { return .init(status: 404) }
        guard method == "POST" else { return .init(status: 405) }
        guard body.count <= 1_048_576, normalized["content-type"]?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces) == "application/json" else { return .init(status: 400) }
        if let version = normalized["mcp-protocol-version"], !["2025-03-26", "2025-06-18", "2025-11-25"].contains(version) { return .init(status: 400) }
        guard let request = try? JSONDecoder().decode(JSONValue.self, from: body), let object = request.object,
              object["jsonrpc"]?.string == "2.0", let methodName = object["method"]?.string else {
            return rpcError(id: .null, code: -32600, message: "Invalid JSON-RPC request")
        }
        let id = object["id"] ?? .null
        if object["id"] != nil {
            switch id {
            case .string, .int: break
            case .double(let value) where value.isFinite: break
            default: return rpcError(id: .null, code: -32600, message: "Request id must be a string or number")
            }
        }
        if object["id"] == nil {
            return methodName.hasPrefix("notifications/") ? .init(status: 202) : rpcError(id: .null, code: -32600, message: "Request id is required")
        }
        switch methodName {
        case "initialize":
            let desired = object["params"]?["protocolVersion"]?.string ?? "2025-06-18"
            let protocolVersion = ["2025-03-26", "2025-06-18", "2025-11-25"].contains(desired) ? desired : "2025-06-18"
            return rpcResult(id: id, result: .object(["protocolVersion": .string(protocolVersion), "capabilities": .object(["tools": .object([:])]),
                "serverInfo": .object(["name": .string("Rushes Local"), "version": .string("1.0")])]))
        case "ping": return rpcResult(id: id, result: .object([:]))
        case "tools/list":
            let available = tools.filter { $0.readOnly || allowMutations }.map { tool in
                JSONValue.object(["name": .string(tool.command), "description": .string(tool.description), "inputSchema": tool.inputSchema,
                    "annotations": .object(["readOnlyHint": .bool(tool.readOnly), "destructiveHint": .bool(!tool.readOnly), "openWorldHint": .bool(false)])])
            }
            return rpcResult(id: id, result: .object(["tools": .array(available)]))
        case "tools/call":
            guard let name = object["params"]?["name"]?.string, let tool = tools.first(where: { $0.command == name }) else { return rpcError(id: id, code: -32602, message: "Unknown tool") }
            guard tool.readOnly || allowMutations else { return rpcError(id: id, code: -32003, message: "MCP is read-only. Enable mutating automation separately in Rushes settings.") }
            let args = object["params"]?["arguments"] ?? .object([:])
            guard args.object != nil else { return rpcError(id: id, code: -32602, message: "Tool arguments must be an object") }
            do {
                let result = try await handler(ControlRequest(id: UUID().uuidString, cmd: name, args: args))
                let encoded = String(decoding: try ControlWire.encoder.encode(result), as: UTF8.self)
                return rpcResult(id: id, result: .object(["content": .array([.object(["type": .string("text"), "text": .string(encoded)])]), "isError": .bool(false)]))
            } catch {
                let payload = (error as? ControlFailure)?.payload.wireDictionary ?? ["code": .string("internal"), "message": .string(error.localizedDescription)]
                let text = String(decoding: (try? ControlWire.encoder.encode(JSONValue.object(payload))) ?? Data(), as: UTF8.self)
                return rpcResult(id: id, result: .object(["content": .array([.object(["type": .string("text"), "text": .string(text)])]), "isError": .bool(true)]))
            }
        default: return rpcError(id: id, code: -32601, message: "Method not found")
        }
    }
    private func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8), b = Array(right.utf8)
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in a.indices { difference |= a[index] ^ b[index] }
        return difference == 0
    }
    private func rpcResult(id: JSONValue, result: JSONValue) -> MCPHTTPResponse {
        .init(status: 200, body: (try? ControlWire.encoder.encode(JSONValue.object(["jsonrpc": .string("2.0"), "id": id, "result": result]))) ?? Data())
    }
    private func rpcError(id: JSONValue, code: Int64, message: String) -> MCPHTTPResponse {
        .init(status: 200, body: (try? ControlWire.encoder.encode(JSONValue.object(["jsonrpc": .string("2.0"), "id": id,
            "error": .object(["code": .int(code), "message": .string(message)])]))) ?? Data())
    }
}
