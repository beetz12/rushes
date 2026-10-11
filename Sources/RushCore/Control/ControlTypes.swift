import Foundation

/// The wire types of the control socket: newline-delimited JSON requests,
/// one-line JSON responses, NDJSON events (docs/PLAN.md, Control interface:
/// `socket: NDJSON {"id":"7","cmd":"record.start","args":{...}} ->
/// {"id":"7","ok":true,"result":{...}} plus events tagged "id":"7"`).
///
/// One request per line; one response per request, carrying the request's
/// id; events are broadcast to every connected client as they happen, each
/// tagged with the id of the request that caused them when there is one.
/// The shell and the CLI are both just clients of this one table.

// MARK: - JSON value

/// A JSON value as data rather than a type: request arguments and command
/// results are open-ended by design, so the command table carries JSON and
/// each command reads the fields it knows.
public enum JSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "unsupported JSON value")
        }
    }

    /// A JSON value built by encoding any `Encodable` value.
    public init(encoding value: some Encodable) throws {
        let data = try ControlWire.encoder.encode(value)
        if data.isEmpty || data == "null".data(using: .utf8) {
            self = .null
            return
        }
        self = try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Encodes as plain JSON (no case names): the value travels through a
    /// single-value container.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .int(let value):
            try container.encode(value)
        case .double(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let values):
            try container.encode(values)
        case .object(let dictionary):
            try container.encode(dictionary)
        }
    }

    public static func string(_ value: String?) -> JSONValue {
        value.map(JSONValue.string) ?? .null
    }

    public var object: [String: JSONValue]? {
        if case .object(let dictionary) = self { return dictionary }
        return nil
    }

    public var array: [JSONValue]? {
        if case .array(let values) = self { return values }
        return nil
    }

    public var string: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var bool: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// An integer, tolerating a JSON float that carries a whole number
    /// (`--duration 2` may arrive as 2 or 2.0).
    public var int: Int64? {
        switch self {
        case .int(let value): return value
        case .double(let value): return value == value.rounded() ? Int64(value) : nil
        default: return nil
        }
    }

    public var double: Double? {
        switch self {
        case .int(let value): return Double(value)
        case .double(let value): return value
        default: return nil
        }
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    public subscript(key: String) -> JSONValue? {
        object?[key]
    }
}

// MARK: - Request

/// One request line on the socket.
public struct ControlRequest: Codable, Equatable, Sendable {

    /// The caller's tag for this request; the response and the events it
    /// causes carry the same id.
    public var id: String

    /// The command name, dot-separated (`record.start`).
    public var cmd: String

    /// The command's arguments as a JSON object (nil means none).
    public var args: JSONValue?

    public init(id: String, cmd: String, args: JSONValue? = nil) {
        self.id = id
        self.cmd = cmd
        self.args = args
    }

    /// The arguments as an object; missing arguments read as nil.
    public var params: [String: JSONValue] { args?.object ?? [:] }

    public func param(_ key: String) -> JSONValue? { params[key] }
}

// MARK: - Errors

/// Machine-readable error codes crossing the socket and the CLI
/// (docs/PLAN.md, Start failure: "Report the error with a
/// machine-readable code"). Values are stable API.
public enum ControlErrorCode {
    /// The command does not exist. CLI exit 2.
    public static let unknownCommand = "unknown-command"
    /// Arguments missing or ill-formed. CLI exit 2.
    public static let invalidParams = "invalid-params"
    /// The CLI was invoked incorrectly. CLI exit 2.
    public static let usage = "usage"
    /// No engine is listening on the socket. CLI exit 4.
    public static let engineUnreachable = "engine-unreachable"
    /// The engine closed the connection mid-request. CLI exit 4.
    public static let connectionClosed = "connection-closed"
    /// The request did not complete in time. CLI exit 4.
    public static let timeout = "timeout"
    /// No recording/package matches the id. CLI exit 5.
    public static let notFound = "not-found"
    /// A permission was denied or never asked for. CLI exit 3.
    public static let permissionDenied = "permission-denied"
    public static let permissionNotAsked = "permission-not-asked"

    /// Everything below is a runtime error (CLI exit 1).
    public static let alreadyActive = "already-active"
    public static let notRecording = "not-recording"
    public static let internalError = "internal"
    public static let socketError = "socket-error"
}

/// The stable exit-code table (docs/PLAN.md, Control interface).
public enum ControlExitCode: Int32, Codable, Sendable {
    case ok = 0
    case runtime = 1
    case usage = 2
    case permission = 3
    case unreachable = 4
    case notFound = 5

    /// The exit code an error code maps onto. Unknown codes are runtime
    /// errors: a future engine's new failure modes must not turn into
    /// success or a usage error at an older CLI.
    public static func exitCode(forErrorCode code: String) -> ControlExitCode {
        switch code {
        case ControlErrorCode.unknownCommand,
             ControlErrorCode.invalidParams,
             ControlErrorCode.usage:
            return .usage
        case ControlErrorCode.permissionDenied, ControlErrorCode.permissionNotAsked:
            return .permission
        case ControlErrorCode.engineUnreachable,
             ControlErrorCode.connectionClosed,
             ControlErrorCode.timeout,
             ControlErrorCode.socketError:
            return .unreachable
        case ControlErrorCode.notFound:
            return .notFound
        default:
            return .runtime
        }
    }
}

/// The `error` block of a failed response and of the CLI's stderr JSON
/// (docs/PLAN.md: `{"error":{"code":"permission-denied","permission":"screen",
/// "settings":"x-apple.systempreferences:..."}}`). Extra keys travel beside
/// `code` and `message` at the error object's top level.
public struct ControlErrorPayload: Codable, Equatable, Sendable {
    public var code: String
    public var message: String?
    /// Extra machine-readable details, flattened into the error object.
    public var details: [String: JSONValue]

    public init(code: String, message: String? = nil, details: [String: JSONValue] = [:]) {
        self.code = code
        self.message = message
        self.details = details
    }

    private enum CodingKeys: String, CodingKey {
        case code, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        code = try container.decode(String.self, forKey: .code)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        // Extras are flattened at the error object's top level; collect
        // every other key.
        if let whole = try? decoder.singleValueContainer().decode([String: JSONValue].self) {
            details = whole.filter { $0.key != "code" && $0.key != "message" }
        } else {
            details = [:]
        }
    }

    /// Encodes `code` and `message`; the flattened wire shape (extras at the
    /// error object's top level, per the plan's stderr example) is produced
    /// from `wireDictionary` by `ControlResponse.encode`.
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(code, forKey: .code)
        try container.encodeIfPresent(message, forKey: .message)
    }

    /// The error object as it appears on the wire, extras flattened.
    public var wireDictionary: [String: JSONValue] {
        var object: [String: JSONValue] = ["code": .string(code)]
        if let message { object["message"] = .string(message) }
        for (key, value) in details where key != "code" && key != "message" {
            object[key] = value
        }
        return object
    }
}

/// The error `EngineController` throws: a machine-readable payload that
/// becomes the failed response as-is.
public struct ControlFailure: Error, Sendable {
    public let payload: ControlErrorPayload

    public init(
        code: String, message: String? = nil, details: [String: JSONValue] = [:]
    ) {
        self.payload = ControlErrorPayload(code: code, message: message, details: details)
    }
}

// MARK: - Response

/// One response line on the socket: `ok` with a `result`, or `!ok` with an
/// `error` block.
public struct ControlResponse: Codable, Equatable, Sendable {
    public var id: String?
    public var ok: Bool
    public var result: JSONValue?
    public var error: ControlErrorPayload?

    public init(id: String?, ok: Bool, result: JSONValue? = nil, error: ControlErrorPayload? = nil) {
        self.id = id
        self.ok = ok
        self.result = result
        self.error = error
    }

    public static func success(id: String, result: JSONValue = .object([:])) -> ControlResponse {
        ControlResponse(id: id, ok: true, result: result, error: nil)
    }

    public static func failure(id: String?, code: String, message: String? = nil,
                               details: [String: JSONValue] = [:]) -> ControlResponse {
        ControlResponse(
            id: id, ok: false, result: nil,
            error: ControlErrorPayload(code: code, message: message, details: details))
    }

    private enum CodingKeys: String, CodingKey {
        case id, ok, result, error
    }

    /// Encodes with a flattened error object (code, message and extras at
    /// the error object's top level, per the plan's stderr shape).
    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        try container.encodeIfPresent(result, forKey: .result)
        if let error {
            try container.encode(JSONValue.object(error.wireDictionary), forKey: .error)
        }
    }
}

// MARK: - Events

/// Event kinds broadcast on the socket and printed by the CLI.
public enum ControlEventKind: String, Codable, Sendable {
    /// The gate opened and the recording is live.
    case recordingStarted = "recording-started"
    /// The take finished; `result` carries the stop outcome.
    case recordingStopped = "recording-stopped"
    /// The session's state changed (`state`: the new state).
    case stateChanged = "state-changed"
    /// A warning was recorded mid-take (`code`, `message`).
    case warning = "warning"
    /// Engine-local only: the engine booted and the socket is listening.
    /// Never crosses the socket; the engine prints it on its own stdout.
    case ready = "ready"
}

/// One NDJSON event line on the socket. `id` is the originating request's
/// tag; the CLI re-emits events on its stdout with the recording id as
/// `id`, matching the plan's CLI event shape.
public struct ControlEvent: Codable, Equatable, Sendable {
    public var event: String
    public var id: String?
    public var recordingId: String?
    /// For `state-changed`: the new state.
    public var state: String?
    /// Media time in milliseconds.
    public var t: Double?
    /// For `warning`: the warning code.
    public var code: String?
    public var message: String?
    /// For `recording-stopped`: the stop outcome.
    public var result: JSONValue?

    public init(
        kind: ControlEventKind,
        id: String? = nil,
        recordingId: String? = nil,
        state: String? = nil,
        t: Double? = nil,
        code: String? = nil,
        message: String? = nil,
        result: JSONValue? = nil
    ) {
        self.event = kind.rawValue
        self.id = id
        self.recordingId = recordingId
        self.state = state
        self.t = t
        self.code = code
        self.message = message
        self.result = result
    }
}

// MARK: - Wire codec

/// One place for the socket's JSON conventions: one line per object, keys
/// sorted, forward slashes unescaped (paths must read as paths).
public enum ControlWire {

    public static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    public static let decoder = JSONDecoder()

    /// Encodes `value` as one NDJSON line (with its newline).
    public static func line<Value: Encodable>(_ value: Value) throws -> Data {
        var data = try encoder.encode(value)
        data.append(0x0A)
        return data
    }
}
