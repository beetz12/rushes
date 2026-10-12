import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import Testing

@testable import RushCore

enum GateReplay: String, CaseIterable, Sendable {
    case delayedPreGate
    case firstLiveAtZero
}

@Suite("Video gate callback ordering", .serialized)
struct VideoGateRaceTests {
    private let epoch: Int64 = 7_000_000_000_000
    private let step: Int64 = 16_666_666

    @Test("Warm-up cache never replays zero after an accepted frame", arguments: GateReplay.allCases)
    func strictTimestampObserver(schedule: GateReplay) async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let factory = GateReplayFactory(native: false)
        let writer = try makeWriter(root: root, factory: factory, codec: .hevc)
        try await feed(schedule: schedule, writer: writer, factory: factory)
        let backend = try #require(factory.backend)
        #expect(backend.attemptedPTS == expectedPTS(schedule))
        #expect(backend.attemptedPTS.filter { $0 == 0 }.count == 1)
        #expect(zip(backend.attemptedPTS, backend.attemptedPTS.dropFirst()).allSatisfy { $0 < $1 })
        let final = await writer.finalize()
        #expect(final.finalizeState == .finalized)
        #expect(final.framesWritten == Int64(expectedPTS(schedule).count))
        #expect(final.framesDropped == (schedule == .delayedPreGate ? 1 : 0))
    }

    @Test("Real native writer survives gate callback races and fully decodes",
          arguments: GateReplay.allCases, [VideoCodec.hevc, .h264])
    func nativeGateReplay(schedule: GateReplay, codec: VideoCodec) async throws {
        let root = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let factory = GateReplayFactory(native: true)
        let writer = try makeWriter(root: root, factory: factory, codec: codec)
        try await feed(schedule: schedule, writer: writer, factory: factory)
        let final = await writer.finalize(deadline: .seconds(10))
        #expect(final.finalizeState == .finalized, "\(final.errorDescription ?? "no writer error")")
        #expect(final.errorDescription == nil, "\(final.errorDescription ?? "no writer error")")
        #expect(!final.usedFallbackCodec)
        #expect(final.framesWritten == Int64(expectedPTS(schedule).count))
        #expect(final.framesDropped == (schedule == .delayedPreGate ? 1 : 0))
        let backend = try #require(factory.backend)
        #expect(backend.attemptedPTS == expectedPTS(schedule))

        let asset = AVURLAsset(url: writer.configuration.outputURL)
        let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        reader.add(output)
        try #require(reader.startReading())
        var times: [CMTime] = []
        while let decoded = output.copyNextSampleBuffer() {
            times.append(CMSampleBufferGetPresentationTimeStamp(decoded))
        }
        #expect(reader.status == .completed)
        #expect(times.count == expectedPTS(schedule).count)
        #expect(times.first == .zero)
        #expect(zip(times, times.dropFirst()).allSatisfy { CMTimeCompare($0, $1) < 0 })
    }

    private func makeWriter(root: URL, factory: GateReplayFactory, codec: VideoCodec) throws -> TrackWriter {
        try TrackWriter(configuration: .screen(outputURL: root.appendingPathComponent("screen.mov"),
            width: 320, height: 240, codec: codec), clock: .init(epochNs: .max), factory: factory)
    }

    private func feed(schedule: GateReplay, writer: TrackWriter, factory: GateReplayFactory) async throws {
        let backend = try #require(factory.backend)
        writer.appendVideo(try video(at: epoch - step))
        // Deterministically model the encoder being busy at the gate, while
        // retaining the real native input beneath this readiness-only seam.
        backend.holdReadiness = schedule == .firstLiveAtZero
        try await waitForNativeReadiness(backend)
        writer.adoptClock(.init(epochNs: epoch))
        backend.holdReadiness = false
        try await waitForNativeReadiness(backend)
        for index in 0..<12 {
            let frame = schedule == .delayedPreGate ? index + 1 : index
            writer.appendVideo(try video(at: epoch + Int64(frame) * step))
            if schedule == .delayedPreGate, index == 0 {
                writer.appendVideo(try video(at: epoch - 1_000_000))
            }
            try await Task.sleep(for: .milliseconds(17))
        }
    }

    private func expectedPTS(_ schedule: GateReplay) -> [Int64] {
        let range = schedule == .delayedPreGate ? 1..<13 : 1..<12
        return [0] + range.map { Int64($0) * step }
    }

    private func waitForNativeReadiness(_ backend: GateReplayBackend) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !backend.nativeReady, Date() < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(backend.nativeReady)
    }

    private func video(at host: Int64) throws -> CMSampleBuffer {
        try #require(SyntheticMedia.videoBuffer(width: 320, height: 240, hostNs: host))
    }

    private func temporaryDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("video-gate-race-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}

private final class GateReplayFactory: TrackFileWritingFactory, @unchecked Sendable {
    let native: Bool
    private(set) var backend: GateReplayBackend?
    init(native: Bool) { self.native = native }
    func makeWriter(configuration: TrackWriterConfiguration, codec: VideoCodec) throws -> any TrackFileWriting {
        let created = GateReplayBackend(outputURL: configuration.outputURL,
            native: native ? try AVAssetFileWriter(configuration: configuration, codec: codec) : nil)
        backend = created
        return created
    }
}

private final class GateReplayBackend: TrackFileWriting {
    let outputURL: URL
    private let native: AVAssetFileWriter?
    var holdReadiness = false
    private var state: FileWritingState = .idle
    private(set) var attemptedPTS: [Int64] = []
    var currentState: FileWritingState { native?.currentState ?? state }
    var failureDescription: String? { native?.failureDescription }
    var nativeReady: Bool { native?.isReadyForMoreMediaData ?? true }
    var isReadyForMoreMediaData: Bool { !holdReadiness && nativeReady }
    init(outputURL: URL, native: AVAssetFileWriter?) {
        self.outputURL = outputURL
        self.native = native
    }
    func startWriting() -> Bool { state = .writing; return native?.startWriting() ?? true }
    func startSession() { native?.startSession() }
    func endSession(atMediaNs value: Int64) { native?.endSession(atMediaNs: value) }
    func appendVideoFrame(_ buffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool {
        attemptedPTS.append(mediaTimeNs)
        return native?.appendVideoFrame(buffer, mediaTimeNs: mediaTimeNs) ?? true
    }
    func appendAudioSamples(_ buffer: CMSampleBuffer) -> Bool { native?.appendAudioSamples(buffer) ?? false }
    func markInputFinished() { native?.markInputFinished() }
    func finishWriting(completion: @escaping @Sendable () -> Void) {
        if let native { native.finishWriting(completion: completion) }
        else { state = .completed; completion() }
    }
    func cancelWriting() { native?.cancelWriting(); state = .failed }
}
