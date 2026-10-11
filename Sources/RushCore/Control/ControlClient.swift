import Darwin
import Foundation

/// Errors a client can hit talking to the engine. Codes align with
/// `ControlErrorCode` so the CLI can map them straight onto the exit-code
/// table.
public enum ControlClientError: Error, Equatable, Sendable, CustomStringConvertible {
    case socketUnavailable(path: String, errno: Int32)
    case connectionClosed(path: String)
    case timedOut(path: String)

    public var description: String {
        switch self {
        case .socketUnavailable(let path, let errno):
            return "could not connect to \(path): errno \(errno)"
        case .connectionClosed(let path):
            return "the engine closed the connection at \(path)"
        case .timedOut(let path):
            return "no response from the engine at \(path) before the deadline"
        }
    }
}

/// A client connection to the engine's control socket: the CLI, the shell
/// and the tests all speak through this one shape.
///
/// Requests are one line each; multiple requests may share a connection,
/// and events for any request (or spontaneous broadcasts) arrive as NDJSON
/// lines between responses.
public final class ControlConnection: @unchecked Sendable {

    private let io: SocketLineIO
    public let socketPath: URL

    init(io: SocketLineIO, socketPath: URL) {
        self.io = io
        self.socketPath = socketPath
    }

    /// Writes one request line.
    public func send(_ request: ControlRequest) throws {
        try sendLine(try ControlWire.line(request))
    }

    /// Writes one pre-encoded line (tests use this to send invalid bytes).
    public func sendLine(_ data: Data) throws {
        guard io.writeFully(data) else {
            throw ControlClientError.connectionClosed(path: socketPath.path)
        }
    }

    /// Reads one line (response or event) as raw data, waiting at most
    /// `timeout` seconds in total. Throws `connectionClosed` when the
    /// engine hangs up; returns nil when the deadline passes first.
    public func readLine(timeout: TimeInterval = 15) throws -> Data? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else { return nil }
            switch io.pollLine(
                pollTimeoutMs: Int32(max(1, remaining * 1000)),
                shouldContinue: { Date() < deadline }
            ) {
            case .line(let line):
                return line
            case .expired:
                continue
            case .closed:
                throw ControlClientError.connectionClosed(path: socketPath.path)
            }
        }
    }

    /// Decodes the next line as a response or an event, whichever arrives.
    /// nil on deadline; throws on hang-up. Unrecognized lines are skipped:
    /// the protocol may grow around this client.
    public func readMessage(timeout: TimeInterval = 15) throws -> ControlMessage? {
        while true {
            guard let line = try readLine(timeout: timeout) else { return nil }
            if let response = try? ControlWire.decoder.decode(ControlResponse.self, from: line) {
                return .response(response)
            }
            if let event = try? ControlWire.decoder.decode(ControlEvent.self, from: line) {
                return .event(event)
            }
        }
    }

    /// Sends one request and waits for its response, collecting and
    /// forwarding the events that arrive meanwhile. Events are also handed
    /// to `onEvent` as they land (the CLI's `--wait` streaming path).
    public func roundTrip(
        _ request: ControlRequest,
        timeout: TimeInterval = 15,
        onEvent: (@Sendable (ControlEvent) -> Void)? = nil
    ) throws -> (response: ControlResponse, events: [ControlEvent]) {
        try send(request)
        var events: [ControlEvent] = []
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let remaining = deadline.timeIntervalSinceNow
            guard remaining > 0 else {
                throw ControlClientError.timedOut(path: socketPath.path)
            }
            guard let message = try readMessage(timeout: remaining) else {
                throw ControlClientError.timedOut(path: socketPath.path)
            }
            switch message {
            case .event(let event):
                onEvent?(event)
                events.append(event)
            case .response(let response):
                if response.id == request.id {
                    return (response, events)
                }
                // A response to another request on this connection: wait on.
                continue
            }
        }
    }

    /// The connection's poll interval for the streaming (`--wait`) loop:
    /// the CLI re-checks its signal flag roughly twice a second.
    public func streamMessage(
        shouldContinue: @escaping @Sendable () -> Bool
    ) throws -> ControlMessage? {
        while true {
            switch io.pollLine(pollTimeoutMs: 500, shouldContinue: shouldContinue) {
            case .line(let line):
                if let response = try? ControlWire.decoder.decode(ControlResponse.self, from: line) {
                    return .response(response)
                }
                if let event = try? ControlWire.decoder.decode(ControlEvent.self, from: line) {
                    return .event(event)
                }
                continue
            case .expired:
                continue
            case .closed:
                throw ControlClientError.connectionClosed(path: socketPath.path)
            }
        }
    }

    public func close() {
        io.close()
    }
}

/// What arrived on the socket.
public enum ControlMessage: Sendable {
    case response(ControlResponse)
    case event(ControlEvent)
}

/// Opens client connections to the engine's control socket.
public enum ControlClient {

    /// Connects to `socketPath`; throws `socketUnavailable` when nothing is
    /// listening (the CLI's "engine not running" path).
    public static func connect(to socketPath: URL) throws -> ControlConnection {
        let path = socketPath.path
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw ControlClientError.socketUnavailable(path: path, errno: errno)
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        guard path.count < 104 else {
            Darwin.close(fd)
            throw ControlClientError.socketUnavailable(path: path, errno: 0)
        }
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: bytes)
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                Darwin.connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard connected == 0 else {
            let caught = errno
            Darwin.close(fd)
            throw ControlClientError.socketUnavailable(path: path, errno: caught)
        }
        return ControlConnection(io: SocketLineIO(fd: fd), socketPath: socketPath)
    }
}
