@preconcurrency import AVFoundation
import Foundation
@testable import RushCore

/// Fixture writers poll readiness on the calling task. `AVAssetWriter` is not
/// thread-safe; checking readiness from another queue crashes VideoToolbox.
func waitUntilReadyForMedia(_ input: AVAssetWriterInput, writer: AVAssetWriter) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(15))
    while !input.isReadyForMoreMediaData {
        try Task.checkCancellation()
        guard writer.status == .writing else {
            throw renderFailure(writer.error?.localizedDescription ?? "Encoder stopped before accepting media")
        }
        guard ContinuousClock.now < deadline else {
            throw renderFailure("\(input.mediaType.rawValue) encoder was not ready within 15 seconds")
        }
        try await Task.sleep(for: .milliseconds(2))
    }
}

/// Tiny fixture movies. The CI VM logs `AppleM2ScalerParavirtDriver` missing
/// and hardware H.264 never finishes, so these settings ask for a software encoder.
func fixtureH264Settings(width: Int, height: Int) -> [String: Any] {
    [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoEncoderSpecificationKey: [
            "EnableHardwareAcceleratedVideoEncoder": false,
        ],
    ]
}
