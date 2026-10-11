import Foundation
import Testing
@testable import LoomCore

@Suite("SessionClock")
struct SessionClockTests {

    // MARK: - Media time

    @Test("Media time at the epoch is zero")
    func mediaTimeAtEpoch() {
        let clock = SessionClock(epochNs: 1_000)
        #expect(clock.mediaTimeNs(atHostNs: 1_000) == 0)
    }

    @Test("Host instants before the epoch clamp to zero")
    func mediaTimeBeforeEpochClamps() {
        let clock = SessionClock(epochNs: 1_000)
        #expect(clock.mediaTimeNs(atHostNs: 500) == 0)
        #expect(clock.mediaTimeNs(atHostNs: 999) == 0)
    }

    @Test("Elapsed host time maps directly when there are no pauses")
    func elapsedWithoutPauses() {
        let clock = SessionClock(epochNs: 1_000)
        #expect(clock.mediaTimeNs(atHostNs: 2_000) == 1_000)
        #expect(clock.mediaTimeNs(atHostNs: 1_500) == 500)
    }

    @Test("A completed pause is subtracted")
    func completedPauseSubtracts() {
        var clock = SessionClock(epochNs: 1_000)
        try? clock.beginPause(nowNs: 2_000)
        try? clock.endPause(nowNs: 3_000)
        // Host 4_000: 3_000 elapsed host, 1_000 paused -> 2_000 media.
        #expect(clock.mediaTimeNs(atHostNs: 4_000) == 2_000)
        #expect(clock.pausedNs(throughHostNs: 4_000) == 1_000)
    }

    @Test("The timeline is frozen while a pause is open")
    func frozenDuringOpenPause() {
        var clock = SessionClock(epochNs: 1_000)
        try? clock.beginPause(nowNs: 2_000)
        #expect(clock.mediaTimeNs(atHostNs: 2_500) == 1_000)
        #expect(clock.mediaTimeNs(atHostNs: 9_999) == 1_000)
        #expect(clock.isPaused(atHostNs: 2_500))
        #expect(!clock.isPaused(atHostNs: 1_500))
    }

    @Test("Multiple pauses accumulate")
    func multiplePausesAccumulate() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 100)
        try? clock.endPause(nowNs: 200)
        try? clock.beginPause(nowNs: 300)
        try? clock.endPause(nowNs: 350)
        // Host 1_000: 1_000 elapsed, 150 paused -> 850 media.
        #expect(clock.mediaTimeNs(atHostNs: 1_000) == 850)
        #expect(clock.pauses.count == 2)
    }

    @Test("pausedNs clips an open pause at the query instant")
    func openPauseClippedAtQuery() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 100)
        #expect(clock.pausedNs(throughHostNs: 150) == 50)
        #expect(clock.pausedNs(throughHostNs: 90) == 0)
    }

    // MARK: - Inverse mapping

    @Test("Inverse of zero is the epoch")
    func inverseOfZero() {
        let clock = SessionClock(epochNs: 7_000)
        #expect(clock.hostTimeNs(atMediaNs: 0) == 7_000)
    }

    @Test("Inverse round-trips without pauses")
    func inverseNoPauses() {
        let clock = SessionClock(epochNs: 1_000)
        #expect(clock.hostTimeNs(atMediaNs: 1_234) == 2_234)
    }

    @Test("Inverse skips completed pauses")
    func inverseSkipsPauses() {
        var clock = SessionClock(epochNs: 1_000)
        try? clock.beginPause(nowNs: 2_000)
        try? clock.endPause(nowNs: 3_000)
        // Media 1_000: first live segment is 1_000 long, so 1_000 consumes it
        // exactly and maps to the pause start, 2_000.
        #expect(clock.hostTimeNs(atMediaNs: 1_000) == 2_000)
        // Media past the pause maps after the pause end.
        #expect(clock.hostTimeNs(atMediaNs: 1_500) == 3_500)
        // Round-trip: media 500 lives before the pause.
        #expect(clock.hostTimeNs(atMediaNs: 500) == 1_500)
    }

    @Test("Inverse maps a pause boundary to the pause start, not the end")
    func inverseBoundaryIsPauseStart() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 100)
        try? clock.endPause(nowNs: 200)
        #expect(clock.hostTimeNs(atMediaNs: 100) == 100)
    }

    @Test("Inverse returns nil for negative media time")
    func inverseNegativeIsNil() {
        let clock = SessionClock(epochNs: 1_000)
        #expect(clock.hostTimeNs(atMediaNs: -1) == nil)
    }

    @Test("Inverse returns nil for media time beyond an open pause")
    func inverseBeyondOpenPauseIsNil() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 100)
        #expect(clock.hostTimeNs(atMediaNs: 150) == nil)
        #expect(clock.hostTimeNs(atMediaNs: 99) == 99)
    }

    @Test("Inverse round-trips with two pauses")
    func inverseTwoPauses() {
        var clock = SessionClock(epochNs: 100)
        try? clock.beginPause(nowNs: 200)
        try? clock.endPause(nowNs: 300)
        try? clock.beginPause(nowNs: 400)
        try? clock.endPause(nowNs: 500)
        // Live segments: [100,200) len 100, [300,400) len 100, [500,inf).
        #expect(clock.hostTimeNs(atMediaNs: 50) == 150)
        #expect(clock.hostTimeNs(atMediaNs: 100) == 200)
        #expect(clock.hostTimeNs(atMediaNs: 150) == 350)
        #expect(clock.hostTimeNs(atMediaNs: 200) == 400)
        #expect(clock.hostTimeNs(atMediaNs: 250) == 550)
    }

    // MARK: - Pause state machine

    @Test("Two beginPause calls fail")
    func doubleBeginFails() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 10)
        #expect(throws: SessionClock.ClockError.pauseAlreadyActive) {
            try clock.beginPause(nowNs: 20)
        }
    }

    @Test("endPause without an open pause fails")
    func endWithoutBeginFails() {
        var clock = SessionClock(epochNs: 0)
        #expect(throws: SessionClock.ClockError.noPauseActive) {
            try clock.endPause(nowNs: 10)
        }
    }

    @Test("A pause before the epoch fails")
    func pauseBeforeEpochFails() {
        var clock = SessionClock(epochNs: 100)
        #expect(throws: SessionClock.ClockError.pauseBeforeEpoch) {
            try clock.beginPause(nowNs: 50)
        }
    }

    @Test("An end before the pause start fails")
    func endBeforeStartFails() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 100)
        #expect(throws: SessionClock.ClockError.pauseEndBeforeStart) {
            try clock.endPause(nowNs: 99)
        }
        // The pause is still open and can be closed properly.
        try? clock.endPause(nowNs: 100)
        #expect(clock.pauses == [SessionClock.Pause(startNs: 100, endNs: 100)])
    }

    @Test("A zero-length pause is kept and subtracts nothing")
    func zeroLengthPause() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 100)
        try? clock.endPause(nowNs: 100)
        #expect(clock.mediaTimeNs(atHostNs: 200) == 200)
    }

    // MARK: - Codable

    @Test("Codable round-trip preserves the clock")
    func codableRoundTrip() throws {
        var clock = SessionClock(epochNs: 1_000)
        try clock.beginPause(nowNs: 2_000)
        try clock.endPause(nowNs: 2_500)
        try clock.beginPause(nowNs: 3_000)

        let data = try JSONEncoder().encode(clock)
        let decoded = try JSONDecoder().decode(SessionClock.self, from: data)

        #expect(decoded == clock)
        #expect(decoded.activePauseStartNs == 3_000)
        #expect(decoded.pauses == [SessionClock.Pause(startNs: 2_000, endNs: 2_500)])
    }

    @Test("Duration is media elapsed")
    func durationIsMediaElapsed() {
        var clock = SessionClock(epochNs: 0)
        try? clock.beginPause(nowNs: 1_000)
        try? clock.endPause(nowNs: 2_000)
        #expect(clock.durationNs(nowNs: 4_000) == 3_000)
    }
}
