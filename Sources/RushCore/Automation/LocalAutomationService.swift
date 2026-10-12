import Darwin
import Foundation

/// Opt-in loopback automation, with credentials stored outside recording packages.
public actor LocalAutomationService {
    public static let commands: Set<String> = ["mcp.enable", "mcp.disable", "mcp.status"]
    private let directory: URL
    private var server: LoopbackMCPServer?
    private var port: UInt16?
    private var token: String?
    private var allowMutations = false
    private var changing = false
    private var closed = false
    private var pendingServer: LoopbackMCPServer?

    public init(directory: URL) { self.directory = directory }

    public func handle(_ request: ControlRequest, tools: [MCPTool],
                       handler: @escaping AutomationDispatcher.CommandHandler) async throws -> JSONValue {
        let mutation = request.cmd == "mcp.enable" || request.cmd == "mcp.disable"
        if mutation {
            guard !changing, !closed else { throw ControlFailure(code: "automation-busy", message: "Automation is changing or shutting down.") }
            changing = true
        }
        defer { if mutation { changing = false } }
        switch request.cmd {
        case "mcp.status": return status(revealToken: false)
        case "mcp.disable":
            let retainedPort = try port ?? readSettings()?.port
            await stopActive()
            token = nil; allowMutations = false
            try save(enabled: false, mutations: false, assignedPort: retainedPort)
            return status(revealToken: false)
        case "mcp.enable":
            if let raw = request.param("allowMutations"), raw.bool == nil {
                throw ControlFailure(code: "invalid-params", message: "allowMutations must be Boolean")
            }
            let mutations = request.param("allowMutations")?.bool ?? false
            var requestedPort: UInt16 = try port ?? readSettings()?.port ?? 0
            if let raw = request.param("port") {
                guard let value = raw.int, value >= 0, value <= Int64(UInt16.max) else {
                    throw ControlFailure(code: "invalid-params", message: "port must be an integer from 0 through 65535")
                }
                requestedPort = UInt16(value)
            }
            await stopActive()
            guard !closed else { throw ControlFailure(code: "mcp-cancelled") }
            let credential = try loadToken()
            let dispatcher = try AutomationDispatcher(token: credential, allowMutations: mutations,
                                                        tools: tools, handler: handler)
            let candidate = try LoopbackMCPServer(port: requestedPort, dispatcher: dispatcher)
            pendingServer = candidate
            defer { pendingServer = nil }
            do {
                let assignedPort = try await candidate.start()
                guard !closed else { candidate.stop(); throw ControlFailure(code: "mcp-cancelled") }
                try save(enabled: true, mutations: mutations, assignedPort: assignedPort)
                server = candidate; port = assignedPort; token = credential; allowMutations = mutations
                return status(revealToken: true)
            } catch { candidate.stop(); throw error }
        default: throw ControlFailure(code: "unknown-command")
        }
    }

    public func restore(tools: [MCPTool], handler: @escaping AutomationDispatcher.CommandHandler) async throws {
        guard let config = try readSettings() else { return }
        if config.enabled {
            var args: [String: JSONValue] = ["allowMutations": .bool(config.allowMutations)]
            if let port = config.port { args["port"] = .int(Int64(port)) }
            _ = try await handle(.init(id: "restore-mcp", cmd: "mcp.enable",
                args: .object(args)), tools: tools, handler: handler)
        }
    }

    public func shutdown() async {
        closed = true; pendingServer?.stop()
        await stopActive(); token = nil
    }
    private func stopActive() async {
        let previous = server; server = nil; port = nil
        if let previous { await previous.stopAndWait() }
    }

    private func status(revealToken: Bool) -> JSONValue {
        var object: [String: JSONValue] = ["enabled": .bool(server != nil),
            "allowMutations": .bool(server != nil && allowMutations)]
        if let port { object["url"] = .string("http://127.0.0.1:\(port)/mcp") }
        if revealToken, let token { object["token"] = .string(token) }
        return .object(object)
    }

    private struct Settings: Codable { var enabled: Bool; var allowMutations: Bool; var port: UInt16? }
    private func readSettings() throws -> Settings? {
        let url = directory.appendingPathComponent("settings.json")
        var info = stat()
        guard lstat(url.path, &info) == 0 else {
            if errno == ENOENT { return nil }
            throw ControlFailure(code: "unsafe-automation-store")
        }
        try prepareDirectory()
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(),
              info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= 32768 else {
            throw ControlFailure(code: "unsafe-automation-store", message: "Automation settings must be a private user-owned regular file.")
        }
        return try JSONDecoder().decode(Settings.self, from: Data(contentsOf: url))
    }
    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        var info = stat()
        guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR,
              info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
            throw ControlFailure(code: "unsafe-automation-store", message: "Automation settings must use a private user-owned directory")
        }
    }
    private func loadToken() throws -> String {
        try prepareDirectory()
        let url = directory.appendingPathComponent("token")
        var info = stat()
        if lstat(url.path, &info) == 0 {
            guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == geteuid(), info.st_mode & 0o077 == 0 else {
                throw ControlFailure(code: "unsafe-automation-store", message: "Automation credential is not a private user-owned file")
            }
            let value = try String(contentsOf: url, encoding: .utf8)
            guard value.count == 64, value.allSatisfy({ $0.isHexDigit }) else { throw ControlFailure(code: "invalid-automation-token") }
            return value
        }
        let value = try AutomationDispatcher.randomToken()
        try Data(value.utf8).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return value
    }
    private func save(enabled: Bool, mutations: Bool, assignedPort: UInt16?) throws {
        try prepareDirectory()
        let url = directory.appendingPathComponent("settings.json")
        try JSONEncoder().encode(Settings(enabled: enabled, allowMutations: mutations, port: assignedPort)).write(to: url, options: [.atomic])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}
