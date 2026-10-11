import Foundation

public struct RushURLRoute: Equatable, Sendable {
    public var command: String
    public var arguments: [String: JSONValue]
    public static func parse(_ url: URL) throws -> RushURLRoute {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "rushes",
              parts.user == nil, parts.password == nil, parts.port == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let route = parts.host,
              ["record", "stop", "pause", "resume"].contains(route), url.absoluteString.count <= 2048 else {
            throw ControlFailure(code: "invalid-url", message: "Use rushes://record, stop, pause or resume with supported parameters only.")
        }
        let items = parts.queryItems ?? []
        guard Set(items.map(\.name)).count == items.count else { throw ControlFailure(code: "invalid-url", message: "Duplicate URL parameters are not allowed.") }
        var arguments: [String: JSONValue] = [:]
        let allowed: Set<String> = route == "record" ? ["mode", "target", "camera", "mic", "systemAudio", "countdown", "title"] : ["id"]
        for item in items {
            guard allowed.contains(item.name), let value = item.value, !value.isEmpty,
                  !value.contains(where: { $0.isNewline || $0 == "\0" }) else { throw ControlFailure(code: "invalid-url", message: "Unknown or empty URL parameter.") }
            switch item.name {
            case "mode":
                guard ["screen", "window", "region", "camera", "audio"].contains(value) else { throw ControlFailure(code: "invalid-url", message: "Invalid recording mode.") }
                arguments[item.name] = .string(value)
            case "systemAudio":
                guard ["true", "false"].contains(value) else { throw ControlFailure(code: "invalid-url") }
                arguments[item.name] = .bool(value == "true")
            case "countdown":
                guard let count = Int64(value), (0...10).contains(count) else { throw ControlFailure(code: "invalid-url") }
                arguments[item.name] = .int(count)
            case "id":
                guard RecordingId.isValid(value) else { throw ControlFailure(code: "invalid-url", message: "A recording id must be a valid ULID.") }
                arguments[item.name] = .string(value)
            default: arguments[item.name] = .string(value)
            }
        }
        return .init(command: route == "record" ? "record.start" : "record.\(route)", arguments: arguments)
    }
    public var request: ControlRequest { ControlRequest(id: UUID().uuidString, cmd: command, args: .object(arguments)) }
}
