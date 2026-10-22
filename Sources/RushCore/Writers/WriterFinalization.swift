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
        if let outcome = result.1 { waiter.resume(returning: outcome) }
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
        let pending: [CheckedContinuation<TrackWriterStatus, Never>] = lock.withLock {
            guard outcome == nil else { return [] }
            outcome = value; let pending = waiters; waiters.removeAll(); return pending
        }
        for waiter in pending { waiter.resume(returning: value) }
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
