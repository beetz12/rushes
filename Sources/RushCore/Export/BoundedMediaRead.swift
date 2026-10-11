import Foundation

/// A synchronous codec read must not occupy Swift's cooperative executor or
/// prevent cancellation forever. One dedicated queue owns this reader's reads;
/// an independent timer bounds lack of progress. There is no global render lock.
final class BoundedMediaRead<Value:Sendable>:@unchecked Sendable {
    private final class Request:@unchecked Sendable {
        let lock=NSLock()
        var continuation:CheckedContinuation<Value?,any Error>?
        var timer:DispatchSourceTimer?
        init(_ continuation:CheckedContinuation<Value?,any Error>) { self.continuation=continuation }
        func attach(_ timer:DispatchSourceTimer) {
            let accepted=lock.withLock { if continuation == nil { return false }; self.timer=timer; return true }
            if !accepted { timer.cancel() }
        }
        func finish(_ result:Result<Value?,any Error>) {
            let state=lock.withLock { let value=continuation; continuation=nil; let timer=self.timer; self.timer=nil; return (value,timer) }
            state.1?.cancel(); state.0?.resume(with:result)
        }
    }
    private let queue=DispatchQueue(label:"rushes.codec.read.\(UUID().uuidString)",qos:.utility)
    private let cancellationQueue=DispatchQueue(label:"rushes.codec.cancel.\(UUID().uuidString)",qos:.utility)
    private let deadlineQueue=DispatchQueue(label:"rushes.codec.deadline.\(UUID().uuidString)",qos:.utility)
    private let lock=NSLock()
    private let copy:@Sendable()->Value?
    private let cancelRead:@Sendable()->Void
    private let timeout:TimeInterval
    private var current:Request?
    private var terminal:(any Error)?
    init(timeout:TimeInterval = 30,copy:@escaping @Sendable()->Value?,cancel:@escaping @Sendable()->Void) {
        precondition(timeout.isFinite && timeout>0)
        self.timeout=timeout; self.copy=copy; cancelRead=cancel
    }
    func read() async throws -> Value? {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation:{
            try await withCheckedThrowingContinuation { continuation in begin(continuation) }
        },onCancel:{ self.cancel() })
    }
    func cancel() { stop(CancellationError()) }
    private func begin(_ continuation:CheckedContinuation<Value?,any Error>) {
        let request=Request(continuation)
        let rejection:(any Error)?=lock.withLock {
            if let terminal { return terminal }
            guard current == nil else { return ControlFailure(code:"reader-busy",message:"A codec read is already in progress") }
            current=request; return nil
        }
        if let rejection { request.finish(.failure(rejection)); return }
        let timer=DispatchSource.makeTimerSource(queue:deadlineQueue)
        timer.schedule(deadline:.now()+timeout)
        timer.setEventHandler { [weak self,weak request] in
            guard let request else { return }
            self?.stop(ControlFailure(code:"audio-reader-stalled",message:"Audio decoder produced no sample for \(self?.timeout ?? 30) seconds; export was cancelled"),expected:request)
        }
        request.attach(timer); timer.resume()
        queue.async { [copy,weak self,request] in
            let value=copy()
            self?.lock.withLock { if self?.current === request { self?.current=nil } }
            // If cancellation/deadline already resumed it, this late result is
            // discarded and cannot append a sample or revive the export.
            request.finish(.success(value))
        }
    }
    private func stop(_ error:any Error,expected:Request? = nil) {
        let state:(Bool,Request?)=lock.withLock {
            if terminal != nil || (expected != nil && current !== expected) { return (false,nil) }
            terminal=error; let request=current; current=nil; return (true,request)
        }
        guard state.0 else { return }
        state.1?.finish(.failure(error))
        // AVFoundation cancellation itself is synchronous; never let it hold
        // the caller's continuation or the deadline's queue.
        cancellationQueue.async(execute:cancelRead)
    }
}
