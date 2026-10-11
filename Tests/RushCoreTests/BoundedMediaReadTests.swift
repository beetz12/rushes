import Foundation
import Testing
@testable import RushCore

private final class BlockedCodecFixture:@unchecked Sendable {
    let release=DispatchSemaphore(value:0)
    let releaseCancellation=DispatchSemaphore(value:0)
    let holdCancellation:Bool
    private let lock=NSLock()
    private var cancels=0
    private var entered=false,returned=false
    var cancellations:Int { lock.withLock{cancels} }
    var didEnter:Bool { lock.withLock{entered} }
    var didReturn:Bool { lock.withLock{returned} }
    init(holdCancellation:Bool = false) { self.holdCancellation=holdCancellation }
    func copy() -> Int? { lock.withLock{entered=true}; release.wait(); lock.withLock{returned=true}; return 7 }
    func cancel() { lock.withLock{cancels += 1}; if holdCancellation { releaseCancellation.wait() }; release.signal() }
}
@Suite("Bounded codec reads",.serialized)
struct BoundedMediaReadTests {
    private func wait(_ condition:@escaping @Sendable()->Bool) async throws {
        for _ in 0..<200 { if condition() { return }; try await Task.sleep(for:.milliseconds(5)) }
        throw ControlFailure(code:"fixture-timeout",message:"Blocked codec fixture did not reach the expected checkpoint")
    }
    @Test func deadlineCancelsBlockedCodecAndDiscardsLateResult() async throws {
        let fixture=BlockedCodecFixture(),reader=BoundedMediaRead<Int>(timeout:0.05,copy:{fixture.copy()},cancel:{fixture.cancel()})
        let clock=ContinuousClock(),start=clock.now
        do { _=try await reader.read(); Issue.record("A blocked codec read must fail") }
        catch let failure as ControlFailure { #expect(failure.payload.code == "audio-reader-stalled") }
        #expect(clock.now-start < .seconds(1))
        try await wait { fixture.didReturn }
        #expect(fixture.cancellations == 1)
        await #expect(throws:ControlFailure.self) { try await reader.read() }
        #expect(fixture.cancellations == 1)
    }
    @Test func taskCancellationFinishesPromptlyAndNeverRevivesRead() async throws {
        let fixture=BlockedCodecFixture(),reader=BoundedMediaRead<Int>(timeout:30,copy:{fixture.copy()},cancel:{fixture.cancel()})
        let task=Task { try await reader.read() }
        try await wait { fixture.didEnter }
        let start=ContinuousClock.now; task.cancel()
        await #expect(throws:CancellationError.self) { try await task.value }
        #expect(ContinuousClock.now-start < .seconds(1))
        try await wait { fixture.didReturn }
        #expect(fixture.cancellations == 1)
        await #expect(throws:CancellationError.self) { try await reader.read() }
    }
    @Test func ordinarySamplesAndEOFRemainSequential() async throws {
        let fixture=SequentialCodecFixture(),reader=BoundedMediaRead<Int>(timeout:1,copy:{fixture.copy()},cancel:{})
        #expect(try await reader.read() == 1)
        #expect(try await reader.read() == 2)
        #expect(try await reader.read() == nil)
    }
    @Test func blockedCancellationCannotHoldDeadlineCaller() async throws {
        let fixture=BlockedCodecFixture(holdCancellation:true)
        defer { fixture.releaseCancellation.signal() }
        let reader=BoundedMediaRead<Int>(timeout:0.05,copy:{fixture.copy()},cancel:{fixture.cancel()})
        let start=ContinuousClock.now
        await #expect(throws:ControlFailure.self) { try await reader.read() }
        #expect(ContinuousClock.now-start < .seconds(1))
        try await wait { fixture.cancellations == 1 }
        #expect(!fixture.didReturn)
        fixture.releaseCancellation.signal()
        try await wait { fixture.didReturn }
        await #expect(throws:ControlFailure.self) { try await reader.read() }
    }
}
private final class SequentialCodecFixture:@unchecked Sendable {
    let lock=NSLock(); var index=0
    func copy() -> Int? { lock.withLock { index += 1; return index<=2 ? index : nil } }
}
