import Darwin
import Foundation
import Testing
@testable import RushCore

@Suite("Terminal control transport failures")
struct TransportFailureTests {
    @Test("An unsent preview may be dropped; a blocked reliable reply remains terminal", arguments: ["preview", "reply"])
    func noPrefixPressure(category: String) throws {
        var endpoints: [Int32] = [-1, -1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0)
        let writer = SocketLineIO(fd: endpoints[0])
        defer { writer.close(); Darwin.close(endpoints[1]) }
        try configureBackpressure(endpoints[0], reader: endpoints[1])
        let occupied = try occupySendBuffer(endpoints[0])
        #expect(!writer.writeFully(Data("{\"generatedPreview\":true}\n".utf8), category: category))
        if category == "reply" {
            #expect(!writer.isOpen)
            return
        }
        try #require(writer.isOpen)
        var remaining = occupied, chunk = [UInt8](repeating: 0, count: 4096)
        while remaining > 0 {
            let received = chunk.withUnsafeMutableBytes { Darwin.read(endpoints[1], $0.baseAddress, min(remaining, $0.count)) }
            try #require(received > 0)
            #expect(chunk.prefix(received).allSatisfy { $0 == 32 })
            remaining -= received
        }
        let reply = Data("{\"control\":\"still-connected\"}\n".utf8)
        #expect(writer.writeFully(reply))
        let received = chunk.withUnsafeMutableBytes { Darwin.read(endpoints[1], $0.baseAddress, $0.count) }
        #expect(received == reply.count)
        #expect(Data(chunk.prefix(max(0, received))) == reply)
    }
    @Test("First failed write records metadata and category without frame/request contents")
    func writeFailureDiagnostic() async throws {
        for category in ["reply", "preview"] {
            var endpoints: [Int32] = [-1, -1]
            #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0)
            let receipt = WriteReceipt()
            let writer = SocketLineIO(fd: endpoints[0], diagnose: { receipt.set($0) })
            defer { writer.close(); Darwin.close(endpoints[1]) }
            try configureBackpressure(endpoints[0], reader: endpoints[1])
            #expect(!writer.writeFully(Data(repeating: 65, count: 262_144), category: category))
            let first = try #require(receipt.get())
            #expect(first.category == category)
            #expect(first.connectionID == writer.connectionID)
            #expect(first.errorNumber == EAGAIN || first.errorNumber == EWOULDBLOCK)
            #expect(first.lineBytes == 262_144)
            #expect(first.sentBytes > 0 && first.sentBytes < first.lineBytes)
            #expect(first.disposition == "closed")
            #expect(!writer.writeFully(Data([65, 10])))
            #expect(receipt.get()?.lineBytes == 262_144)
        }
    }
    @Test("A timed-out JSON prefix closes its stream before any later reliable line can append")
    func partialWriteIsTerminal() throws {
        var endpoints: [Int32] = [-1, -1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0)
        let writer = SocketLineIO(fd: endpoints[0])
        defer { writer.close(); Darwin.close(endpoints[1]) }
        try configureBackpressure(endpoints[0], reader: endpoints[1])
        let line = try ControlWire.line(ControlEvent(kind: .cameraPreview, result: .object([
            "previewToken": .string("generated-lifetime"), "jpeg": .string(String(repeating: "A", count: 262_144))
        ])))
        #expect(!writer.writeFully(line))
        #expect(!writer.isOpen)
        let received = readUntilClosed(endpoints[1])
        #expect(received.reachedEOF)
        #expect(!received.bytes.isEmpty)
        #expect(received.bytes.count < line.count)
        #expect(!received.bytes.contains(0x0A))
        // Drain first: the old implementation would now have room to append a
        // valid event to its unterminated prefix, creating an invalid JSON line.
        let nextLine = try ControlWire.line(ControlEvent(kind: .stateChanged, state: "idle"))
        #expect(!writer.writeFully(nextLine))
        #expect(!writer.isOpen)
        let after = readUntilClosed(endpoints[1])
        #expect(after.reachedEOF && after.bytes.isEmpty)
    }

    @Test("Write failure wakes a blocked reader and repeated close preserves an unrelated descriptor")
    func failureWithReaderAndReuse() async throws {
        var endpoints: [Int32] = [-1, -1]
        #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &endpoints) == 0)
        let heldDescriptor = fcntl(endpoints[0], F_DUPFD, 1024)
        #expect(heldDescriptor >= 1024)
        Darwin.close(endpoints[0])
        defer { Darwin.close(endpoints[1]) }
        let writer = SocketLineIO(fd: heldDescriptor)
        try configureBackpressure(heldDescriptor, reader: endpoints[1])
        let reading = Task.detached { writer.readLine() }
        try await Task.sleep(for: .milliseconds(20))
        #expect(!writer.writeFully(Data(repeating: 65, count: 262_144)))
        #expect(await reading.value == nil)
        let unrelated = Darwin.open("/dev/null", O_RDONLY)
        #expect(unrelated >= 0)
        let replacement = fcntl(unrelated, F_DUPFD, heldDescriptor)
        Darwin.close(unrelated)
        #expect(replacement == heldDescriptor)
        defer { Darwin.close(replacement) }
        writer.close()
        #expect(fcntl(replacement, F_GETFD) >= 0)
        #expect(!writer.writeFully(Data([65, 10])))
        #expect(fcntl(replacement, F_GETFD) >= 0)
    }
}

private func occupySendBuffer(_ descriptor: Int32) throws -> Int {
    let previous = fcntl(descriptor, F_GETFL)
    try #require(previous >= 0)
    try #require(fcntl(descriptor, F_SETFL, previous | O_NONBLOCK) == 0)
    defer { _ = fcntl(descriptor, F_SETFL, previous) }
    let spaces = [UInt8](repeating: 32, count: 4096)
    var occupied = 0
    while occupied < 4 * 1024 * 1024 {
        let sent = spaces.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress, $0.count) }
        if sent > 0 { occupied += sent; continue }
        if sent < 0 && errno == EINTR { continue }
        try #require(sent < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
        return occupied
    }
    throw ControlFailure(code: "fixture-send-buffer-not-full")
}

private final class WriteReceipt: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TransportWriteDiagnostic?
    func set(_ next: TransportWriteDiagnostic) { lock.withLock { value = next } }
    func get() -> TransportWriteDiagnostic? { lock.withLock { value } }
}

private func configureBackpressure(_ descriptor: Int32, reader: Int32) throws {
    var sendBytes: Int32 = 4096, noPipeSignal: Int32 = 1
    var sendDeadline = timeval(tv_sec: 0, tv_usec: 250_000)
    var readDeadline = timeval(tv_sec: 1, tv_usec: 0)
    #expect(setsockopt(descriptor, SOL_SOCKET, SO_SNDBUF, &sendBytes, socklen_t(MemoryLayout<Int32>.size)) == 0)
    #expect(setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &sendDeadline, socklen_t(MemoryLayout<timeval>.size)) == 0)
    #expect(setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noPipeSignal, socklen_t(MemoryLayout<Int32>.size)) == 0)
    #expect(setsockopt(reader, SOL_SOCKET, SO_RCVTIMEO, &readDeadline, socklen_t(MemoryLayout<timeval>.size)) == 0)
}
private func readUntilClosed(_ descriptor: Int32) -> (bytes: Data, reachedEOF: Bool) {
    var collected = Data(), chunk = [UInt8](repeating: 0, count: 16_384)
    while true {
        let count = chunk.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, $0.count) }
        if count == 0 { return (collected, true) }
        if count < 0 {
            if errno == EINTR { continue }
            return (collected, false)
        }
        collected.append(contentsOf: chunk.prefix(count))
    }
}
