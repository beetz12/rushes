import AVFoundation
import CoreMedia
import CoreVideo
import Foundation
import Testing

@testable import RushCore

@Suite("Camera writer compatibility", .serialized)
struct CameraWriterFailureTests {
    @Test("Camera chooses supported eight-bit output without relying on native format")
    func explicitEightBitOutput() {
        let nv12 = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        let full = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        let bgra = kCVPixelFormatType_32BGRA
        let tenBit = kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
        #expect(CameraPixelFormatChoice.choose(from: [tenBit, bgra, full, nv12]) == nv12)
        #expect(CameraPixelFormatChoice.choose(from: [tenBit, full, bgra]) == full)
        #expect(CameraPixelFormatChoice.choose(from: [tenBit, bgra]) == bgra)
        #expect(CameraPixelFormatChoice.choose(from: [tenBit]) == nil)
        #expect(CameraPixelFormatChoice.choose(from: []) == nil)
    }

    @Test("Writer diagnostics keep native error codes and exclude arbitrary user info")
    func nativeErrorDiagnostics() throws {
        let cause = NSError(domain: NSOSStatusErrorDomain, code: -12905,
            userInfo: ["privateToken": "DO_NOT_LOG_PRIVATE_TOKEN"])
        let error = NSError(domain: AVFoundationErrorDomain, code: -11800,
            userInfo: [NSLocalizedDescriptionKey: "Unable to encode frame",
                       NSUnderlyingErrorKey: cause,
                       "privatePayload": "DO_NOT_LOG_PRIVATE_PAYLOAD"])
        let frame = try pixelBuffer(format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        let diagnostic = AVAssetFileWriter.describeFailure(error,
            videoInput: AVAssetFileWriter.videoInputDescription(frame))
        #expect(diagnostic.contains("AVFoundationErrorDomain(-11800)"))
        #expect(diagnostic.contains("NSOSStatusErrorDomain(-12905)"))
        #expect(diagnostic.contains("420v/875704438 1920x1080"))
        #expect(!diagnostic.contains("DO_NOT_LOG"))
        #expect(!diagnostic.contains("privateToken"))
        #expect(!diagnostic.contains("privatePayload"))
    }

    @Test("1080p eight-bit camera inputs encode from their first frame and fully decode",
          arguments: [kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                      kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                      kCVPixelFormatType_32BGRA], [VideoCodec.hevc, .h264])
    func nativeCameraInput(pixelFormat: OSType, codec: VideoCodec) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("camera-writer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("camera.mov")
        let writer = try AVAssetFileWriter(configuration: .camera(outputURL: url,
            width: 1920, height: 1080, codec: codec), codec: codec)
        try #require(writer.startWriting())
        writer.startSession()
        let pixels = try pixelBuffer(format: pixelFormat)
        for frame in 0..<5 {
            let deadline = Date().addingTimeInterval(3)
            while !writer.isReadyForMoreMediaData, Date() < deadline {
                try await Task.sleep(for: .milliseconds(2))
            }
            try #require(writer.isReadyForMoreMediaData)
            try #require(writer.appendVideoFrame(pixels, mediaTimeNs: Int64(frame) * 33_333_333))
            try await Task.sleep(for: .milliseconds(34))
        }
        writer.endSession(atMediaNs: 166_666_667)
        writer.markInputFinished()
        await withCheckedContinuation { continuation in
            writer.finishWriting { continuation.resume() }
        }
        #expect(writer.currentState == .completed, "\(writer.failureDescription ?? "no writer error")")
        #expect(writer.failureDescription == nil)

        let asset = AVURLAsset(url: url)
        let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
        let description = try #require(try await track.load(.formatDescriptions).first)
        #expect(CMFormatDescriptionGetMediaSubType(description)
            == (codec == .hevc ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264))
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        #expect(reader.startReading())
        var count = 0
        var firstPTS: CMTime?
        while let decoded = output.copyNextSampleBuffer() {
            if firstPTS == nil { firstPTS = CMSampleBufferGetPresentationTimeStamp(decoded) }
            let image = try #require(CMSampleBufferGetImageBuffer(decoded))
            #expect(CVPixelBufferGetWidth(image) == 1920)
            #expect(CVPixelBufferGetHeight(image) == 1080)
            count += 1
        }
        #expect(reader.status == .completed)
        #expect(firstPTS == .zero)
        #expect(count == 5)
    }

    private func pixelBuffer(format: OSType) throws -> CVPixelBuffer {
        var created: CVPixelBuffer?
        #expect(CVPixelBufferCreate(kCFAllocatorDefault, 1920, 1080, format,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary, &created) == kCVReturnSuccess)
        let buffer = try #require(created)
        CVPixelBufferLockBaseAddress(buffer, [])
        if CVPixelBufferIsPlanar(buffer) {
            for plane in 0..<CVPixelBufferGetPlaneCount(buffer) {
                let base = try #require(CVPixelBufferGetBaseAddressOfPlane(buffer, plane))
                memset(base, 128, CVPixelBufferGetHeightOfPlane(buffer, plane)
                    * CVPixelBufferGetBytesPerRowOfPlane(buffer, plane))
            }
        } else {
            let base = try #require(CVPixelBufferGetBaseAddress(buffer))
            memset(base, 128, CVPixelBufferGetHeight(buffer) * CVPixelBufferGetBytesPerRow(buffer))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }

}
