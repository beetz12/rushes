import Foundation
import Testing
@testable import RushCore

private final class HeldVerificationDecoder: @unchecked Sendable {
    enum Phase { case startup, sample }
    let release = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private let phase: Phase
    private var entered = false
    private var active = false
    private var held = false
    private var cancelRequested = false
    private var cancelReturned = false
    private var overlap = false
    private var starts = 0, copies = 0, cancels = 0
    init(_ phase: Phase) { self.phase = phase }
    func start() -> Bool {
        lock.withLock { starts += 1 }
        if phase == .startup { hold() }
        return true
    }
    func copy() -> Int? {
        lock.withLock { copies += 1 }
        if phase == .sample { hold() }
        return 7
    }
    private func hold() {
        let shouldWait = lock.withLock {
            guard !held else { return false }
            held = true; active = true; entered = true
            return true
        }
        guard shouldWait else { return }
        release.wait()
        lock.withLock { active = false }
    }
    func cancel() { lock.withLock { cancels += 1; overlap = overlap || active } }
    func requested() { lock.withLock { cancelRequested = true } }
    func finishedCancellation() { lock.withLock { cancelReturned = true } }
    var didEnter: Bool { lock.withLock { entered } }
    var didRequestCancel: Bool { lock.withLock { cancelRequested } }
    var didReturnCancel: Bool { lock.withLock { cancelReturned } }
    var didOverlap: Bool { lock.withLock { overlap } }
    var counts: [Int] { lock.withLock { [starts, copies, cancels] } }
}

@Suite("Verification decoder lifecycle", .serialized)
struct PackageVerifierDecoderTests {
    private func wait(_ condition: @escaping @Sendable () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        throw ControlFailure(code: "fixture-timeout", message: "Verification decoder did not reach its held phase")
    }
    @Test func cancellationBeforeStartupNeverStartsOrReads() {
        let fixture = HeldVerificationDecoder(.startup)
        // This case must not park: it tests refusal before native admission.
        fixture.release.signal()
        let decoder = PackageVerifier.Decoder(start: { fixture.start() }, copy: { fixture.copy() }, cancel: { fixture.cancel() })
        decoder.cancel()
        #expect(decoder.copyCount() == nil)
        decoder.cancel()
        #expect(fixture.counts == [0, 0, 1])
    }
    private func cancellationDuring(_ phase: HeldVerificationDecoder.Phase) async throws {
        let fixture = HeldVerificationDecoder(phase)
        defer { fixture.release.signal() }
        let decoder = PackageVerifier.Decoder(start: { fixture.start() }, copy: { fixture.copy() }, cancel: { fixture.cancel() })
        let reads = BoundedMediaRead<Int>(timeout: 30, copy: { decoder.copyCount() }, cancel: {
            fixture.requested(); decoder.cancel(); fixture.finishedCancellation()
        })
        let task = Task { try await reads.read() }
        try await wait { fixture.didEnter }
        let before = ContinuousClock.now
        task.cancel()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(ContinuousClock.now - before < .seconds(1))
        try await wait { fixture.didRequestCancel }
        #expect(fixture.counts[2] == 0)
        #expect(!fixture.didOverlap)
        fixture.release.signal()
        try await wait { fixture.didReturnCancel }
        #expect(fixture.counts == [1, 1, 1])
        #expect(!fixture.didOverlap)
        // A result delivered after cancellation cannot revive the read or decoder.
        await #expect(throws: CancellationError.self) { try await reads.read() }
        #expect(decoder.copyCount() == nil)
        #expect(fixture.counts == [1, 1, 1])
    }
    @Test func cancellationDuringStartupIsPromptButNativeCallsNeverOverlap() async throws {
        try await cancellationDuring(.startup)
    }
    @Test func cancellationDuringSampleReadIsPromptButNativeCallsNeverOverlap() async throws {
        try await cancellationDuring(.sample)
    }
}
