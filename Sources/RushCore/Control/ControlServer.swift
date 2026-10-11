import Darwin
import Foundation

/// The command handler the server calls once per request line. The handler
/// owns its reply: it must call `context.reply` exactly once, and may call
/// `context.broadcast` any number of times (including before the reply, the
/// `--wait` streaming shape).
public struct ControlCommandContext: Sendable {
    /// Sends the response line to the requesting client.
    public let reply: @Sendable (ControlResponse) -> Void
    /// Sends one NDJSON event line to every connected client.
    public let broadcast: @Sendable (ControlEvent) -> Void
    public let connectionID: String?
    public let isConnected: @Sendable () -> Bool

    public init(
        reply: @escaping @Sendable (ControlResponse) -> Void,
        broadcast: @escaping @Sendable (ControlEvent) -> Void,
        connectionID: String? = nil,
        isConnected: @escaping @Sendable () -> Bool = { true }
    ) {
        self.reply = reply
        self.broadcast = broadcast
        self.connectionID = connectionID
        self.isConnected = isConnected
    }
}

public protocol ControlHandling: Sendable {
    func handle(_ request: ControlRequest, context: ControlCommandContext) async
    func clientDisconnected(_ connectionID: String) async
}

extension ControlHandling {
    public func clientDisconnected(_ connectionID: String) async {}
}

/// Errors the server itself can fail with, before any request arrives.
public enum ControlServerError: Error, Equatable, Sendable, CustomStringConvertible {
    case pathTooLong(String)
    case bindFailed(String, errno: Int32)
    case listenFailed(errno: Int32)
    case alreadyRunning(path: String)
    case folderCreationFailed(String)

    public var description: String {
        switch self {
        case .pathTooLong(let path):
            return "socket path is longer than the sockaddr_un limit: \(path)"
        case .bindFailed(let path, let errno):
            return "could not bind \(path): errno \(errno)"
        case .listenFailed(let errno):
            return "listen failed: errno \(errno)"
        case .alreadyRunning(let path):
            return "another engine is already serving \(path)"
        case .folderCreationFailed(let path):
            return "could not create the socket folder \(path)"
        }
    }
}

/// The same-user rule for the control socket (docs/PLAN.md, Process model:
/// "The socket's folder is mode 0700 and the server checks that the peer
/// runs as the same user"; privacy-security: "The control socket is
/// readable only by David's user").
public enum PeerCredentialCheck {

    /// The pure rule, separated so a mismatched stub can be tested without
    /// a second user account.
    public static func peerUID(_ peerUID: UInt32, matchesExpected expectedUID: UInt32) -> Bool {
        peerUID == expectedUID
    }

    /// Reads the peer's credentials from a connected socket (getpeereid on
    /// macOS) and applies the same-user rule. `expectedUID` of nil means
    /// this process's own user.
    public static func acceptPeer(
        fileDescriptor: Int32, expectedUID: UInt32? = nil
    ) -> Bool {
        var peerUID: uid_t = 0
        var peerGID: gid_t = 0
        guard getpeereid(fileDescriptor, &peerUID, &peerGID) == 0 else {
            return false
        }
        return Self.peerUID(peerUID, matchesExpected: expectedUID ?? UInt32(getuid()))
    }
}

// MARK: - Line IO

/// Buffered full-line reads and single-line writes over a socket. One
/// writer lock per connection: responses, events and the reader's error
/// replies never interleave mid-line.
final class SocketLineIO: @unchecked Sendable {

    let fd: Int32
    let connectionID = UUID().uuidString
    var isOpen: Bool { writeLock.withLock { !closed } }
    private let writeLock = NSLock()
    private var buffer = Data()
    private var closed = false
    private var activeReads = 0
    private let previewLock = NSLock()
    private let previewQueue = DispatchQueue(label: "rush.socket.preview")
    private var pendingPreview: Data?
    private var previewWriting = false

    init(fd: Int32) {
        self.fd = fd
    }

    /// Writes `data` fully, retrying on partial writes and EINTR.
    /// Returns false when the peer has gone.
    func writeFully(_ data: Data) -> Bool {
        writeLock.lock()
        defer { writeLock.unlock() }
        guard !closed else { return false }
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard var base = raw.baseAddress else { return true }
            var remaining = raw.count
            while remaining > 0 {
                let sent = Darwin.write(fd, base, remaining)
                if sent > 0 {
                    base += sent
                    remaining -= sent
                    continue
                }
                if sent < 0 && errno == EINTR { continue }
                return false
            }
            return true
        }
    }

    /// A bounded mailbox for best-effort camera previews. New frames replace
    /// pending frames; at most one writer and one pending frame exist per peer.
    func offerPreview(_ line: Data) {
        let start = previewLock.withLock {
            pendingPreview = line
            if previewWriting { return false }
            previewWriting = true
            return true
        }
        guard start else { return }
        previewQueue.async { [self] in
            while let line = previewLock.withLock({ () -> Data? in
                guard let line = pendingPreview else { previewWriting = false; return nil }
                pendingPreview = nil
                return line
            }) {
                guard writeFully(line) else {
                    previewLock.withLock { pendingPreview = nil; previewWriting = false }
                    close()
                    break
                }
            }
        }
    }

    /// Reads one newline-terminated line (returned without the newline), or
    /// nil on EOF/error. A line still buffered from a previous read is
    /// returned first. Blocking: for a client-steerable variant use
    /// `pollLine(pollTimeoutMs:shouldContinue:)`.
    func readLine() -> Data? {
        guard beginRead() else { return nil }
        defer { endRead() }
        while true {
            if let buffered = takeBufferedLine() { return buffered }
            var chunk = [UInt8](repeating: 0, count: 65_536)
            let received = chunk.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Int in
                Darwin.read(fd, raw.baseAddress, raw.count)
            }
            if received > 0 {
                buffer.append(contentsOf: chunk[0..<received])
                continue
            }
            if received < 0 && errno == EINTR { continue }
            return drainTrailing()
        }
    }

    /// One buffered line without its newline, if a full one has arrived.
    private func takeBufferedLine() -> Data? {
        guard let newline = buffer.firstIndex(of: 0x0A) else { return nil }
        let line = Data(buffer[buffer.startIndex..<newline])
        buffer.removeSubrange(buffer.startIndex...newline)
        return line.isEmpty ? nil : line
    }

    /// EOF/error: anything left without its newline, else nil.
    private func drainTrailing() -> Data? {
        guard !buffer.isEmpty else { return nil }
        let trailing = buffer
        buffer = Data()
        return trailing
    }

    private func beginRead() -> Bool {
        writeLock.withLock {
            guard !closed else { return false }
            activeReads += 1
            return true
        }
    }

    private func endRead() {
        writeLock.withLock {
            activeReads -= 1
            if closed && activeReads == 0 { Darwin.close(fd) }
        }
    }

    func close() {
        writeLock.withLock {
            guard !closed else { return }
            closed = true
            // Wake a blocking reader, but retain the descriptor until its
            // final syscall returns so the OS cannot reuse it mid-read.
            _ = Darwin.shutdown(fd, SHUT_RDWR)
            if activeReads == 0 { Darwin.close(fd) }
        }
    }
}

/// The client-steerable read outcome: a line, a poll window that expired
/// (retry after checking `shouldContinue`), or the connection's end.
enum SocketLineResult: Sendable {
    case line(Data)
    case expired
    case closed
}

extension SocketLineIO {

    /// Polls for one line with a bounded wait. `expired` means no line
    /// arrived within the window: the caller re-checks its abort condition
    /// and calls again.
    func pollLine(
        pollTimeoutMs: Int32, shouldContinue: @escaping @Sendable () -> Bool
    ) -> SocketLineResult {
        guard beginRead() else { return .closed }
        defer { endRead() }
        while true {
            if let buffered = takeBufferedLine() { return .line(buffered) }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let ready = Darwin.poll(&descriptor, 1, pollTimeoutMs)
            if ready < 0 {
                if errno == EINTR { continue }
                return .closed
            }
            if ready == 0 {
                return shouldContinue() ? .expired : .closed
            }
            var chunk = [UInt8](repeating: 0, count: 65_536)
            let received = chunk.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) -> Int in
                Darwin.read(fd, raw.baseAddress, raw.count)
            }
            if received > 0 {
                buffer.append(contentsOf: chunk[0..<received])
                continue
            }
            if received < 0 && errno == EINTR { continue }
            if let trailing = drainTrailing() { return .line(trailing) }
            return .closed
        }
    }
}

// MARK: - Server

/// The Unix domain socket server the engine serves and the shell, the CLI
/// and the later MCP server all connect to (docs/PLAN.md, Control
/// interface; Process model).
///
/// Contract:
/// - The socket lives at `socketPath`; its folder is created mode 0700 and
///   the socket file itself is 0600.
/// - A peer whose uid is not this process's user is refused before any
///   request is parsed.
/// - Requests are newline-delimited JSON, one per line; each request gets
///   exactly one one-line JSON response carrying the request's id.
/// - Events are broadcast to every connected client as NDJSON lines.
/// - The listen backlog is small (8): at most the shell, the CLI and a
///   test client are expected, and requests are handled serially per
///   connection (each request line spawns one handler task; the
///   `EngineController` actor serializes what must be serial).
public final class ControlServer: @unchecked Sendable {

    public let socketPath: URL

    private let handler: any ControlHandling
    private let expectedUID: UInt32
    private let stateLock = NSLock()
    private var listenFD: Int32 = -1
    private var clients: [SocketLineIO] = []
    private var running = false

    public init(
        socketPath: URL,
        handler: any ControlHandling,
        expectedUID: UInt32? = nil
    ) {
        self.socketPath = socketPath
        self.handler = handler
        self.expectedUID = expectedUID ?? UInt32(getuid())
    }

    /// The plan's default socket: `~/Library/Application Support/Rushes/control.sock`.
    public static var defaultSocketPath: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Rushes/control.sock")
    }

    /// Creates the folder (0700), binds and listens. Throws if another
    /// engine already answers on this path.
    public func start() throws {
        let path = socketPath.path
        guard path.count < 104 else {
            throw ControlServerError.pathTooLong(path)
        }
        let folder = socketPath.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: folder, withIntermediateDirectories: true)
        } catch {
            throw ControlServerError.folderCreationFailed(folder.path)
        }
        chmod(folder.path, 0o700)

        // A socket file that answers is a live engine: never unlink it.
        if FileManager.default.fileExists(atPath: path) {
            if Self.probeLiveSocket(at: path) {
                throw ControlServerError.alreadyRunning(path: path)
            }
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: path))
        }

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else {
            throw ControlServerError.bindFailed(path, errno: errno)
        }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: bytes)
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0 else {
            Darwin.close(fd)
            throw ControlServerError.bindFailed(path, errno: errno)
        }
        chmod(path, 0o600)
        guard listen(fd, 8) == 0 else {
            Darwin.close(fd)
            throw ControlServerError.listenFailed(errno: errno)
        }

        stateLock.lock()
        listenFD = fd
        running = true
        stateLock.unlock()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.acceptLoop()
        }
    }

    /// Stops the server: no new connections, existing connections closed,
    /// the socket file removed. Safe to call more than once.
    public func stop() {
        stateLock.lock()
        running = false
        let fd = listenFD
        listenFD = -1
        let currentClients = clients
        clients = []
        stateLock.unlock()
        if fd >= 0 { Darwin.close(fd) }
        for client in currentClients { client.close() }
        try? FileManager.default.removeItem(at: socketPath)
    }

    /// Broadcasts one event line to every connected client.
    public func broadcast(_ event: ControlEvent) {
        guard let line = try? ControlWire.line(event) else { return }
        stateLock.lock()
        let currentClients = clients
        stateLock.unlock()
        for client in currentClients {
            if event.event == ControlEventKind.cameraPreview.rawValue { client.offerPreview(line) }
            else { _ = client.writeFully(line) }
        }
    }

    // MARK: Internals

    /// Connects and disconnects cleanly: true when something answered.
    private static func probeLiveSocket(at path: String) -> Bool {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { Darwin.close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { destination in
            destination.copyBytes(from: bytes)
        }
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                connect(fd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        return connected == 0
    }

    private func acceptLoop() {
        while true {
            stateLock.lock()
            let isRunning = running
            let fd = listenFD
            stateLock.unlock()
            guard isRunning, fd >= 0 else { return }
            let accepted = accept(fd, nil, nil)
            if accepted < 0 {
                if errno == EINTR { continue }
                // listenFD was closed by stop(): the loop's own flags end it.
                stateLock.lock()
                let stillRunning = running
                stateLock.unlock()
                if stillRunning { continue }
                return
            }
            guard PeerCredentialCheck.acceptPeer(fileDescriptor: accepted, expectedUID: expectedUID) else {
                Darwin.close(accepted)
                continue
            }
            var sendTimeout = timeval(tv_sec: 0, tv_usec: 250_000)
            _ = setsockopt(accepted, SOL_SOCKET, SO_SNDTIMEO, &sendTimeout, socklen_t(MemoryLayout<timeval>.size))
            var noSIGPIPE: Int32 = 1
            _ = setsockopt(accepted, SOL_SOCKET, SO_NOSIGPIPE, &noSIGPIPE, socklen_t(MemoryLayout<Int32>.size))
            let client = SocketLineIO(fd: accepted)
            stateLock.lock()
            if running {
                clients.append(client)
            }
            let acceptedWhileRunning = running
            stateLock.unlock()
            guard acceptedWhileRunning else {
                client.close()
                return
            }
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                self?.serve(client: client)
            }
        }
    }

    /// One connection's read loop: a line per request, a task per request.
    private func serve(client: SocketLineIO) {
        while true {
            guard let line = client.readLine() else { break }
            guard let request = try? ControlWire.decoder.decode(ControlRequest.self, from: line) else {
                let failure = ControlResponse.failure(
                    id: nil, code: ControlErrorCode.invalidParams,
                    message: "the line is not a valid request object")
                if let data = try? ControlWire.line(failure) {
                    _ = client.writeFully(data)
                }
                continue
            }
            let context = ControlCommandContext(
                reply: { [weak client] response in
                    guard let client, let data = try? ControlWire.line(response) else { return }
                    _ = client.writeFully(data)
                },
                broadcast: { [weak self] event in
                    self?.broadcast(event)
                },
                connectionID: client.connectionID,
                isConnected: { [weak client] in client?.isOpen == true })
            Task { [handler] in
                await handler.handle(request, context: context)
            }
        }
        stateLock.lock()
        clients.removeAll { $0 === client }
        stateLock.unlock()
        client.close()
        Task { [handler] in await handler.clientDisconnected(client.connectionID) }
    }
}
