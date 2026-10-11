/// The shared clock for one recording.
///
/// All tracks of a recording share one `SessionClock`. The epoch is the host
/// time at which the start gate opened; every track's media time zero is that
/// instant, so separate files line up on any editor timeline. Pauses are
/// intervals of host time that do not count as media time. While a pause is
/// active the media timeline is frozen.
///
/// Times are nanoseconds on a monotonic host clock, as produced by the
/// capture layer. This type is pure: it never reads a clock itself, so tests
/// drive it with explicit instants.
public struct SessionClock: Codable, Equatable, Sendable {

    /// A completed pause. `startNs` and `endNs` are host-time nanoseconds,
    /// with `startNs < endNs`. Pauses never overlap and are kept sorted.
    public struct Pause: Codable, Equatable, Sendable {
        public let startNs: Int64
        public let endNs: Int64

        public init(startNs: Int64, endNs: Int64) {
            self.startNs = startNs
            self.endNs = endNs
        }
    }

    public enum ClockError: Error, Equatable, Sendable {
        case pauseAlreadyActive
        case noPauseActive
        case pauseBeforeEpoch
        case pauseEndBeforeStart
        case negativeMediaTime
    }

    /// Host time at which the start gate opened. Media time zero.
    public let epochNs: Int64

    /// Completed pauses, sorted by start, never overlapping.
    public private(set) var pauses: [Pause]

    /// Start of the currently open pause, if any.
    public private(set) var activePauseStartNs: Int64?

    public init(epochNs: Int64) {
        self.epochNs = epochNs
        self.pauses = []
        self.activePauseStartNs = nil
    }

    /// A clock whose gate opens at `nowNs`.
    public static func gating(nowNs: Int64) -> SessionClock {
        SessionClock(epochNs: nowNs)
    }

    // MARK: - Pauses

    /// Open a pause. Fails if a pause is already open or `nowNs` is before
    /// the epoch.
    public mutating func beginPause(nowNs: Int64) throws {
        guard activePauseStartNs == nil else { throw ClockError.pauseAlreadyActive }
        guard nowNs >= epochNs else { throw ClockError.pauseBeforeEpoch }
        activePauseStartNs = nowNs
    }

    /// Close the open pause at `nowNs`.
    public mutating func endPause(nowNs: Int64) throws {
        guard let start = activePauseStartNs else { throw ClockError.noPauseActive }
        guard nowNs >= start else { throw ClockError.pauseEndBeforeStart }
        pauses.append(Pause(startNs: start, endNs: nowNs))
        activePauseStartNs = nil
    }

    /// Whether the host instant is inside a pause.
    public func isPaused(atHostNs hostNs: Int64) -> Bool {
        if let start = activePauseStartNs, hostNs >= start { return true }
        return pauses.contains { $0.startNs <= hostNs && hostNs < $0.endNs }
    }

    /// Total paused nanoseconds from the epoch through `hostNs`. An open
    /// pause counts up to `hostNs`.
    public func pausedNs(throughHostNs hostNs: Int64) -> Int64 {
        var total: Int64 = 0
        for pause in pauses {
            if pause.startNs >= hostNs { break }
            total += min(pause.endNs, hostNs) - pause.startNs
        }
        if let start = activePauseStartNs, hostNs > start {
            total += hostNs - start
        }
        return total
    }

    // MARK: - Time mapping

    /// Media time of a host instant.
    ///
    /// Host instants at or before the epoch map to zero: a frame captured
    /// before the gate is placed at media time zero rather than dropped by
    /// the clock (the writer decides whether it replaces the cached pre-gate
    /// frame). Inside a pause the timeline is frozen, so the result equals
    /// the media time at which the pause began.
    public func mediaTimeNs(atHostNs hostNs: Int64) -> Int64 {
        guard hostNs > epochNs else { return 0 }
        return hostNs - epochNs - pausedNs(throughHostNs: hostNs)
    }

    /// Media elapsed from the epoch through `nowNs`.
    public func durationNs(nowNs: Int64) -> Int64 {
        mediaTimeNs(atHostNs: nowNs)
    }

    /// The earliest host instant whose media time is `mediaNs`, or nil for a
    /// negative media time. A media time that falls on a pause boundary maps
    /// to the instant the pause began, not the instant it ended.
    public func hostTimeNs(atMediaNs mediaNs: Int64) -> Int64? {
        guard mediaNs >= 0 else { return nil }
        var remaining = mediaNs
        var cursor = epochNs
        for pause in pauses {
            if pause.startNs > cursor {
                let liveLength = pause.startNs - cursor
                if remaining <= liveLength { return cursor + remaining }
                remaining -= liveLength
            }
            cursor = max(cursor, pause.endNs)
        }
        if let start = activePauseStartNs, cursor < start {
            let liveLength = start - cursor
            if remaining <= liveLength { return cursor + remaining }
            // The remaining media time lies beyond the start of the still-open
            // pause; an open pause has no known end, so there is no host
            // instant for it yet.
            return nil
        }
        return cursor + remaining
    }
}
