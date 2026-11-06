import CoreMedia
import Foundation
import Testing

@testable import RushCore

/// Backend barriers exercise response deadlines, not file decodability. Every
/// barrier releases even on the old implementation so RED runs cannot wedge CI.
@Suite("WriterFinalizeBudgetTests", .serialized)
struct WriterFinalizeBudgetTests {
    private final class Backend: TrackFileWriting, @unchecked Sendable {
        let outputURL: URL
        private let lock = NSLock()
        private var state = FileWritingState.writing
        private var ready = true
        private var appends = 0
        private var finishes = 0
        private var cancels = 0
        private var completion: (@Sendable () -> Void)?
        var appendBarrier: DispatchSemaphore?
        let appendEntered = DispatchSemaphore(value: 0)
        var endDelay: TimeInterval = 0
        var finishDelay: TimeInterval?
        var cancelBarrier: DispatchSemaphore?
        let cancelEntered = DispatchSemaphore(value: 0)
        init(_ url: URL) { outputURL = url }
        var currentState: FileWritingState { lock.withLock { state } }
        var failureDescription: String? { nil }
        var isReadyForMoreMediaData: Bool { lock.withLock { ready } }
        var counts: (appends: Int, finishes: Int, cancels: Int) { lock.withLock { (appends, finishes, cancels) } }
        func waitForAppend() -> Bool { appendEntered.wait(timeout: .now() + 1) == .success }
        func waitForCancel() -> Bool { cancelEntered.wait(timeout: .now() + 1) == .success }
        func setReady(_ value: Bool) { lock.withLock { ready = value } }
        func startWriting() -> Bool { true }
        func startSession() {}
        func endSession(atMediaNs: Int64) { Thread.sleep(forTimeInterval: endDelay) }
        func appendVideoFrame(_ buffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool {
            if let appendBarrier { appendEntered.signal(); _ = appendBarrier.wait(timeout: .now() + 1) }
            lock.withLock { appends += 1 }; return true
        }
        func appendAudioSamples(_ buffer: CMSampleBuffer) -> Bool { true }
        func markInputFinished() {}
        func finishWriting(completion: @escaping @Sendable () -> Void) {
            let alreadyComplete=lock.withLock { finishes += 1; self.completion = completion; return state == .completed }
            if alreadyComplete { complete() }
            else if let finishDelay {
                DispatchQueue.global().asyncAfter(deadline: .now() + finishDelay) { self.complete() }
            }
        }
        func complete() {
            let callback = lock.withLock { () -> (@Sendable () -> Void)? in
                state = .completed; let value = completion; completion = nil; return value
            }
            callback?()
        }
        func cancelWriting() {
            if let cancelBarrier { cancelEntered.signal(); _ = cancelBarrier.wait(timeout: .now() + 1) }
            lock.withLock { cancels += 1; state = .failed }
        }
    }
    private struct Factory: TrackFileWritingFactory {
        let backend: Backend
        func makeWriter(configuration: TrackWriterConfiguration, codec: VideoCodec) throws -> any TrackFileWriting { backend }
    }
    private final class Backends: @unchecked Sendable {
        private let lock = NSLock()
        private var values: [Backend] = []
        func make(_ config: TrackWriterConfiguration, _ clock: SessionClock) throws -> TrackWriter {
            let backend = Backend(config.outputURL)
            lock.withLock { values.append(backend) }
            try Data("retained fragment fixture".utf8).write(to: config.outputURL)
            return try TrackWriter(configuration: config, clock: clock, factory: Factory(backend: backend))
        }
        func close() { for backend in lock.withLock({ values }) { backend.complete() } }
    }
    private struct Catalog: SourceCataloging {
        func displays() async throws -> [DisplaySource] { [] }
        func windows() async throws -> [WindowSource] { [] }
        func cameras() async throws -> [CameraDevice] { [.init(id: "fixture", name: "Generated fixture")] }
        func microphones() async throws -> [MicrophoneDevice] { [] }
    }
    private struct Fixture {
        let root: URL
        let backend: Backend
        let writer: TrackWriter
        init() throws {
            root = FileManager.default.temporaryDirectory.appendingPathComponent("writer-budget-\(UUID())")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let url = root.appendingPathComponent("screen.mov")
            try Data("retained fragment fixture".utf8).write(to: url)
            backend = Backend(url)
            writer = try TrackWriter(configuration: .screen(outputURL: url, width: 32, height: 32, codec: .h264),
                                     clock: SessionClock(epochNs: 0), factory: Factory(backend: backend))
        }
        func close() { backend.complete(); try? FileManager.default.removeItem(at: root) }
    }
    private func frame(_ ns: Int64 = 0) throws -> CMSampleBuffer {
        var pixel: CVPixelBuffer?
        #expect(CVPixelBufferCreate(nil, 32, 32, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixel) == 0)
        let buffer = try #require(pixel)
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(allocator: nil, imageBuffer: buffer, formatDescriptionOut: &format)
        var timing = CMSampleTimingInfo(duration: .init(value: 1, timescale: 30),
                                       presentationTimeStamp: .init(exactNanoseconds: ns), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(allocator: nil, imageBuffer: buffer, dataReady: true, makeDataReadyCallback: nil,
                                          refcon: nil, formatDescription: try #require(format), sampleTiming: &timing, sampleBufferOut: &sample)
        return try #require(sample)
    }
    private func elapsed(_ start: DispatchTime) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1e9 }

    @Test("Queue admission is inside the finish budget")
    func parkedAppend() async throws {
        let f = try Fixture(); defer { f.close() }
        f.writer.appendVideo(try frame())
        let barrier = DispatchSemaphore(value: 0); f.backend.appendBarrier = barrier
        let sample = try frame(33_333_333)
        let append = Task.detached { f.writer.appendVideo(sample) }
        #expect(f.backend.waitForAppend())
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(500)) { barrier.signal() }
        let start = DispatchTime.now()
        let result = await f.writer.finalize(deadline: .milliseconds(100))
        #expect(elapsed(start) < 0.25)
        #expect(result.finalizeState == .degraded)
        #expect(result.framesWritten >= 1)
        #expect(PendingWriterFiles.shared.contains(in:f.root))
        await append.value
        #expect(f.backend.counts.cancels == 0)
        #expect(try Data(contentsOf: f.backend.outputURL) == Data("retained fragment fixture".utf8))
    }

    @Test("Drain, padding and hung native completion share one budget")
    func combinedBudget() async throws {
        let f = try Fixture(); defer { f.close() }
        f.writer.appendVideo(try frame()); f.backend.setReady(false)
        f.writer.appendVideo(try frame(33_333_333))
        let start = DispatchTime.now()
        let result = await f.writer.finalize(endMediaTimeNs: 1_000_000_000, deadline: .milliseconds(100))
        #expect(elapsed(start) < 0.25)
        #expect(result.finalizeState == .degraded)
        #expect(f.backend.counts.cancels == 0)
    }

    @Test("A synchronous native endSession cannot extend the response budget")
    func parkedEndSession() async throws {
        let f = try Fixture(); defer { f.close() }
        f.writer.appendVideo(try frame()); f.backend.endDelay = 0.5
        let start = DispatchTime.now()
        let result = await f.writer.finalize(endMediaTimeNs: 1_000_000_000, deadline: .milliseconds(100))
        #expect(elapsed(start) < 0.25)
        #expect(result.finalizeState == .degraded)
        // Allow the owned backend to leave its synchronous operation before cleanup.
        #expect(PendingWriterFiles.shared.contains(in:f.root))
        try await Task.sleep(for: .milliseconds(550))
        #expect(f.backend.counts.cancels == 0)
    }

    @Test("Concurrent finalize callers join one terminal outcome")
    func repeatedFinalize() async throws {
        let f = try Fixture(); defer { f.close() }
        f.writer.appendVideo(try frame()); f.backend.finishDelay = 0.15
        let first = Task { await f.writer.finalize(deadline: .seconds(1)) }
        try await Task.sleep(for: .milliseconds(30))
        let second = await f.writer.finalize(deadline: .seconds(1))
        let original = await first.value
        #expect(second.finalizeState == .finalized)
        #expect(second == original)
        #expect(f.backend.counts.finishes == 1)
    }

    @Test("Late appends are refused and late completion cannot rewrite the terminal outcome")
    func lateAppendAndCompletion() async throws {
        let f = try Fixture(); defer { f.close() }
        f.writer.appendVideo(try frame())
        let result = await f.writer.finalize(deadline: .milliseconds(50))
        let count = f.backend.counts.appends
        f.writer.appendVideo(try frame(33_333_333))
        #expect(f.backend.counts.appends == count)
        f.backend.complete()
        #expect(await f.writer.finalize(deadline: .seconds(1)) == result)
        #expect(f.writer.status() == result)
    }

    @Test("A deadline miss retains originals and cannot become a complete session")
    func degradedSessionRemainsUnchecked() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("budget-session-\(UUID())")
        let backends=Backends()
        defer { backends.close(); try? FileManager.default.removeItem(at:root) }
        let session=RecordingSession(outputRoot:root,catalog:Catalog(),
            volumeProvider:{ _ in VolumeInfo(availableBytes:100_000_000_000) },hostNowNs:{ 1_000_000_000 },
            makeWriter:{ config,clock in try backends.make(config,clock) })
        let package=try await session.start(.init(cameraId:"fixture",cameraDimensions:.init(width:32,height:32)))
        _=try await session.openGate(atHostNs:0)
        let writer=try #require(await session.trackWriter(for:.camera))
        writer.appendVideo(try frame())
        #expect(await writer.finalize(deadline:.milliseconds(50)).finalizeState == .degraded)
        let result=try await session.stop(),manifest=try package.readManifest()
        #expect(result.status == .failed && manifest.status == .failed)
        #expect(manifest.verified == nil)
        #expect(manifest.tracks.first?.present == true)
        #expect(manifest.warnings.contains { $0.code == "finalize-degraded" })
        #expect(try Data(contentsOf:package.trackURL(for:.camera)) == Data("retained fragment fixture".utf8))
    }

    @Test("Joining a cancellation still obeys the first finalize deadline")
    func parkedCancellation() async throws {
        let f=try Fixture(); defer { f.close() }
        let barrier=DispatchSemaphore(value:0); f.backend.cancelBarrier=barrier
        let cancel=Task { await f.writer.cancel() }
        #expect(f.backend.waitForCancel())
        DispatchQueue.global().asyncAfter(deadline:.now() + .milliseconds(500)) { barrier.signal() }
        let start=DispatchTime.now()
        let result=await f.writer.finalize(deadline:.milliseconds(100))
        #expect(elapsed(start)<0.25)
        #expect(result.finalizeState == .degraded)
        #expect(PendingWriterFiles.shared.contains(in:f.root))
        await cancel.value
        #expect(!PendingWriterFiles.shared.contains(in:f.root))
        #expect(await f.writer.finalize() == result)
        #expect(f.backend.counts.finishes == 0 && f.backend.counts.cancels == 1)
    }
}
