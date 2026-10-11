import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import Testing
@testable import RushCore

@Suite("Native MOV timestamp precision without capture")
struct VideoTimescaleTests {
    @Test("Sub-600Hz frame gaps remain distinct across sixty seconds and recovery", arguments: [VideoCodec.hevc, .h264])
    func preciseMovie(codec: VideoCodec) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("video-time-fixture-\(UUID().uuidString)").resolvingSymlinksInPath()
        defer { try? FileManager.default.removeItem(at: root) }
        let package = try RecordingPackage.create(root: root)
        let url = package.trackURL(for: .screen)
        let configuration = TrackWriterConfiguration.screen(outputURL: url, width: 64, height: 48, codec: codec)
        let backend = try AVAssetFileWriter(configuration: configuration, codec: codec)
        try #require(backend.startWriting())
        backend.startSession()
        let desired: [Int64] = [0, 100_000, 59_980_000_000, 60_020_000_000]
        for time in desired {
            let deadline = Date().addingTimeInterval(3)
            while !backend.isReadyForMoreMediaData, Date() < deadline { try await Task.sleep(for: .milliseconds(2)) }
            try #require(backend.isReadyForMoreMediaData)
            let sample = try #require(SyntheticMedia.videoBuffer(width: 64, height: 48, hostNs: time))
            let pixels = try #require(CMSampleBufferGetImageBuffer(sample))
            try #require(backend.appendVideoFrame(pixels, mediaTimeNs: time))
        }
        let endNs: Int64 = 60_040_000_000
        backend.endSession(atMediaNs: endNs)
        backend.markInputFinished()
        await withCheckedContinuation { continuation in backend.finishWriting { continuation.resume() } }
        #expect(backend.currentState == .completed, "\(backend.failureDescription ?? "no writer error")")

        let asset = AVURLAsset(url: url)
        let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
        #expect(try await track.load(.naturalTimeScale) == 1_000_000)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        try #require(reader.startReading())
        var actual: [Int64] = []
        while let sample = output.copyNextSampleBuffer() {
            actual.append(try #require(CMSampleBufferGetPresentationTimeStamp(sample).nanosecondsI64))
        }
        #expect(reader.status == .completed)
        #expect(actual == desired)
        let duration = try await asset.load(.duration).seconds
        #expect(abs(duration - Double(endNs) / 1e9) < 0.05)
        let before = try Data(contentsOf: url)
        try package.writeManifest(.init(id: package.id, status: .recording,
                                        clock: .init(clock: SessionClock(epochNs: 0), durationNs: endNs),
                                        tracks: [.init(kind: .screen, codec: codec.rawValue, width: 64, height: 48, fps: 60)]))
        let report = try await PackageRecovery(root: root).recover(interruptedAtLaunch: true)
        #expect(report.count == 1)
        #expect(try package.readManifest().status == .recovered)
        #expect(try Data(contentsOf: url) == before)
        #expect(await PackageVerifier().verify(package).ok)
    }
}
