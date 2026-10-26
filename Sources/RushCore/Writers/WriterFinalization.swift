import Dispatch
import Foundation

/// Reporting cannot wait on the native writer queue: even a synchronous native
/// call may stall. The first caller seals admission and owns one absolute budget;
/// every caller receives the same immutable terminal report.
internal final class WriterFinalization: @unchecked Sendable {
    private let lock = NSLock()
    private var sealed = false
    private var finalizeJoined = false
    private let fileURL: URL
    private let fileToken = UUID()
    private var snapshot: TrackWriterStatus
    private var outcome: TrackWriterStatus?
    private var waiters: [CheckedContinuation<TrackWriterStatus, Never>] = []
#if DEBUG
    // Test-only opt-in, installed before any finalize call and never replaced.
    var trace: WriterFinalizationTrace?
#endif

    init(_ initial: TrackWriterStatus, fileURL: URL) { snapshot = initial; self.fileURL = fileURL }
    var accepting: Bool { lock.withLock { !sealed } }
    var status: TrackWriterStatus { lock.withLock { outcome ?? snapshot } }

    func publish(_ value: TrackWriterStatus) {
        lock.withLock {
            guard outcome == nil else { return }
            snapshot = value.withFinalization(sealed ? .finalizing : value.finalizeState)
        }
    }

    /// Non-nil owns the deadline. True also owns native finalization; false
    /// observes an already-owned cancellation without issuing more native work.
    func join(_ waiter: CheckedContinuation<TrackWriterStatus, Never>) -> Bool? {
        let result: (Bool?, TrackWriterStatus?) = lock.withLock {
            if let outcome { return (nil, outcome) }
            waiters.append(waiter)
            guard !finalizeJoined else { return (nil, nil) }
            finalizeJoined = true
            let finish = !sealed
            if !sealed { PendingWriterFiles.shared.begin(fileToken, url: fileURL) }
            sealed = true
            snapshot = snapshot.withFinalization(.finalizing)
            return (finish, nil)
        }
        if let outcome = result.1 {
#if DEBUG
            let resumeTick = DispatchTime.now().uptimeNanoseconds
#endif
            waiter.resume(returning: outcome)
#if DEBUG
            trace?.record(.waiterResumeIssued, at: resumeTick)
#endif
        }
        return result.0
    }

    func sealCancellation() -> Bool {
        lock.withLock {
            guard !sealed else { return false }
            PendingWriterFiles.shared.begin(fileToken, url: fileURL)
            sealed = true
            snapshot = snapshot.withFinalization(.finalizing)
            return true
        }
    }

    func nativeDidFinish() { PendingWriterFiles.shared.end(fileToken) }

    func expire() {
        resolve(status.withFinalization(.degraded,
            error: status.errorDescription ?? "Finalization deadline passed; retained media is unchecked and the native writer may still be finishing"))
    }

    func resolve(_ value: TrackWriterStatus) {
#if DEBUG
        var publicationTick: UInt64?
#endif
        let pending: [CheckedContinuation<TrackWriterStatus, Never>] = lock.withLock {
            guard outcome == nil else { return [] }
            outcome = value
#if DEBUG
            if trace != nil { publicationTick = DispatchTime.now().uptimeNanoseconds }
#endif
            let pending = waiters; waiters.removeAll(); return pending
        }
#if DEBUG
        // Capture under the outcome lock, but never acquire the recorder lock there.
        if let publicationTick { trace?.record(.winningResolvePublished, at: publicationTick) }
#endif
        for waiter in pending {
#if DEBUG
            let resumeTick = DispatchTime.now().uptimeNanoseconds
#endif
            waiter.resume(returning: value)
#if DEBUG
            trace?.record(.waiterResumeIssued, at: resumeTick)
#endif
        }
    }
}

extension TrackWriterStatus {
    internal func withFinalization(_ state: FinalizeState, error: String? = nil) -> TrackWriterStatus {
        .init(kind: kind, framesWritten: framesWritten, silenceFramesWritten: silenceFramesWritten,
              framesDropped: framesDropped, firstMediaTimeNs: firstMediaTimeNs,
              lastMediaTimeNs: lastMediaTimeNs, pendingDepth: pendingDepth,
              usedFallbackCodec: usedFallbackCodec, finalizeState: state,
              errorDescription: error ?? errorDescription,
              framesSuppressedByPause: framesSuppressedByPause, microphoneSilent: microphoneSilent)
    }
}

/// A deadline is a response bound, not evidence that AVFoundation closed the
/// file. Decode jobs must not inspect a file still owned by a native finalizer.
/// Process restart clears these leases; crash recovery independently checks disk.
internal final class PendingWriterFiles: @unchecked Sendable {
    static let shared = PendingWriterFiles()
    private let lock = NSLock()
    private var files: [UUID: URL] = [:]
    func begin(_ token: UUID, url: URL) { lock.withLock { files[token] = url.standardizedFileURL } }
    func end(_ token: UUID) { _ = lock.withLock { files.removeValue(forKey: token) } }
    func contains(in folder: URL) -> Bool {
        let path = folder.resolvingSymlinksInPath().standardizedFileURL.path + "/"
        return lock.withLock { files.values.contains { $0.path.hasPrefix(path) } }
    }
}

#if DEBUG
/// Raw monotonic ticks for one opted-in test writer. Recording performs no I/O;
/// callers capture ticks before this recorder's lock. Absent phases stay unknown.
internal final class WriterFinalizationTrace: @unchecked Sendable {
    enum Phase: String, CaseIterable {
        case callerStart, finalizeEntry, joined, timerEnqueue, timerEnqueued
        case nativeQueueEntered, fixtureEndSessionBegin, fixtureEndSessionEnd
        case expiryCallbackEntered, winningResolvePublished, waiterResumeIssued, callerReturn
    }
    struct Event {
        let phase: Phase
        let uptimeNanoseconds: UInt64
        let absoluteDeadlineNanoseconds: UInt64?
    }
    static let limit = 32
    private let lock = NSLock()
    private var events: [Event] = []
    private var dropped = 0

    init() { events.reserveCapacity(Self.limit) }

    func record(_ phase: Phase, at tick: UInt64 = DispatchTime.now().uptimeNanoseconds,
                absoluteDeadline: UInt64? = nil) {
        let event = Event(phase: phase, uptimeNanoseconds: tick, absoluteDeadlineNanoseconds: absoluteDeadline)
        lock.withLock {
            if events.count < Self.limit { events.append(event) }
            else { dropped += 1 }
        }
    }

    func snapshot() -> (events: [Event], dropped: Int) {
        lock.withLock { (events.sorted { $0.uptimeNanoseconds < $1.uptimeNanoseconds }, dropped) }
    }
}
#endif
