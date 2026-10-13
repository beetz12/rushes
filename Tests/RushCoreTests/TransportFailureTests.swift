import Darwin
import Foundation
import Testing
@testable import RushCore

@Suite("Terminal control transport failures")
struct TransportFailureTests {
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
