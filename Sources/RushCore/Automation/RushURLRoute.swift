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
                arguments["countdownSeconds"] = .int(count)
            case "id":
                guard RecordingId.isValid(value) else { throw ControlFailure(code: "invalid-url", message: "A recording id must be a valid ULID.") }
                arguments[item.name] = .string(value)
            default: arguments[item.name] = .string(value)
            }
        }
        if route == "record" {
            let mode = arguments.removeValue(forKey: "mode")?.string ?? "screen"
            let target = arguments.removeValue(forKey: "target")?.string
            switch mode {
            case "screen": arguments["display"] = .string(target ?? "main")
            case "window":
                guard let target else { throw ControlFailure(code: "invalid-url", message: "Window mode needs a target from targets.") }
                arguments["window"] = .string(target)
            case "region":
                guard let target else { throw ControlFailure(code: "invalid-url", message: "Region target needs x,y,width,height in display points.") }
                let pieces = target.split(separator: ",", omittingEmptySubsequences: false)
                let values = pieces.compactMap { Double($0) }
                guard pieces.count == 4, values.count == 4, values.allSatisfy(\.isFinite), values[2] > 0, values[3] > 0 else {
                    throw ControlFailure(code: "invalid-url", message: "Region target needs finite x,y,width,height with positive size.")
                }
                arguments["display"] = .string("main")
                arguments["area"] = .object(Dictionary(uniqueKeysWithValues: zip(["x", "y", "width", "height"], values.map(JSONValue.double))))
            case "camera":
                if let target, let selected = arguments["camera"]?.string, target != selected { throw ControlFailure(code: "invalid-url", message: "Camera target conflicts with camera selection.") }
                arguments["camera"] = arguments["camera"] ?? .string(target ?? "default")
                guard arguments["camera"]?.string != "none", arguments["systemAudio"]?.bool != true else {
                    throw ControlFailure(code: "invalid-url", message: "Camera mode needs a camera; system audio needs a screen mode target.")
                }
            case "audio":
                if let target, let selected = arguments["mic"]?.string, target != selected { throw ControlFailure(code: "invalid-url", message: "Audio target conflicts with microphone selection.") }
                arguments["mic"] = arguments["mic"] ?? .string(target ?? "default")
                guard arguments["mic"]?.string != "none", arguments["camera"]?.string == nil || arguments["camera"]?.string == "none", arguments["systemAudio"]?.bool != true else {
                    throw ControlFailure(code: "invalid-url", message: "Audio mode needs a microphone and no camera; system audio needs a screen mode target.")
                }
            default: throw ControlFailure(code: "invalid-url")
            }
        }
        return .init(command: route == "record" ? "record.start" : "record.\(route)", arguments: arguments)
    }
    public var request: ControlRequest { ControlRequest(id: UUID().uuidString, cmd: command, args: .object(arguments)) }
}
