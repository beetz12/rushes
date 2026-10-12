import Foundation
import Network

/// Minimal stateless Streamable HTTP MCP transport. Explicit loopback binding; one request per connection.
public final class LoopbackMCPServer: @unchecked Sendable {
    private let listener: NWListener
    private let dispatcher: AutomationDispatcher
    private let queue = DispatchQueue(label: "rushes.mcp.http")
    private var stopWaiters: [CheckedContinuation<Void, Never>] = []
    private var waitingForStop = false
    public init(port: UInt16 = 0, dispatcher: AutomationDispatcher) throws {
        self.dispatcher = dispatcher
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
        parameters.requiredInterfaceType = .loopback
        listener = try NWListener(using: parameters)
        listener.newConnectionLimit = 16
    }
    public func start() async throws -> UInt16 {
        try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.listener.stateUpdateHandler = nil
                    continuation.resume(returning: self.listener.port!.rawValue)
                case .failed(let error):
                    self.listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
                case .cancelled:
                    self.listener.stateUpdateHandler = nil
                    continuation.resume(throwing: ControlFailure(code: "mcp-cancelled"))
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self, let port = self.listener.port?.rawValue else { connection.cancel(); return }
                MCPHTTPConnection(connection: connection, dispatcher: self.dispatcher, queue: self.queue, port: port).start()
            }
            listener.start(queue: queue)
        }
    }
    public func stop() { listener.cancel() }
    /// Preserve the pairing port only after the old listener has released it.
    /// All waiters and listener callbacks are owned by its serial queue.
    public func stopAndWait() async {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                if case .cancelled = listener.state { continuation.resume(); return }
                stopWaiters.append(continuation)
                guard !waitingForStop else { return }
                waitingForStop = true
                listener.stateUpdateHandler = { [self] state in
                    if case .cancelled = state {
                        let waiters = stopWaiters; stopWaiters.removeAll()
                        listener.stateUpdateHandler = nil
                        for waiter in waiters { waiter.resume() }
                    }
                }
                listener.cancel()
            }
        }
    }
}

private final class MCPHTTPConnection: @unchecked Sendable {
    let connection: NWConnection
    let dispatcher: AutomationDispatcher
    let queue: DispatchQueue
    let port: UInt16
    var buffer = Data()
    var complete = false
    init(connection: NWConnection, dispatcher: AutomationDispatcher, queue: DispatchQueue, port: UInt16) {
        self.connection = connection; self.dispatcher = dispatcher; self.queue = queue; self.port = port
    }
    func start() {
        connection.start(queue: queue); receive()
        queue.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self, !self.complete else { return }
            self.connection.cancel()
        }
    }
    func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [self] data, _, finished, error in
            guard !complete else { return }
            if let data { buffer.append(data) }
            guard buffer.count <= 1_064_960 else { reply(.init(status: 413)); return }
            if let headerRange = buffer.range(of: Data("\r\n\r\n".utf8)) {
                guard headerRange.lowerBound <= 16_384,
                      let header = String(data: buffer[..<headerRange.lowerBound], encoding: .utf8) else { reply(.init(status: 400)); return }
                let lines = header.components(separatedBy: "\r\n")
                let first = lines[0].split(separator: " ")
                guard first.count == 3, first[2] == "HTTP/1.1" else { reply(.init(status: 400)); return }
                var headers: [String: String] = [:]
                for line in lines.dropFirst() {
                    guard let colon = line.firstIndex(of: ":"), !line.hasPrefix(" "), !line.hasPrefix("\t") else { reply(.init(status: 400)); return }
                    let name = line[..<colon].lowercased()
                    guard headers[name] == nil, !name.contains(where: \.isWhitespace) else { reply(.init(status: 400)); return }
                    headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
                }
                guard headers["transfer-encoding"] == nil else { reply(.init(status: 400)); return }
                let lengthText = headers["content-length"] ?? "0"
                guard !lengthText.isEmpty, lengthText.allSatisfy(\.isNumber), let length = Int(lengthText), length <= 1_048_576 else { reply(.init(status: 400)); return }
                let expected = headerRange.upperBound + length
                if buffer.count >= expected {
                    guard buffer.count == expected else { reply(.init(status: 400)); return }
                    complete = true
                    let body = Data(buffer[headerRange.upperBound..<expected])
                    let method = String(first[0]), path = String(first[1])
                    Task { [self] in
                        let response = await dispatcher.respond(method: method, path: path, headers: headers, body: body, port: port)
                        queue.async { [self] in reply(response) }
                    }
                    return
                }
            } else if buffer.count > 16_384 { reply(.init(status: 413)); return }
            if finished || error != nil { connection.cancel() } else { receive() }
        }
    }
    func reply(_ response: MCPHTTPResponse) {
        complete = true
        let reason = [200: "OK", 202: "Accepted", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Content Too Large"][response.status] ?? "Error"
        var data = Data("HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: application/json\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n".utf8)
        data.append(response.body)
        connection.send(content: data, completion: .contentProcessed { [connection] _ in connection.cancel() })
    }
}
