@preconcurrency import AVFoundation
import Foundation
@testable import RushCore

/// Fixture writers poll readiness. An encoder that never flips ready used to
/// spin until the CI job was cancelled, so the wait is bounded and reports
/// a failed writer instead of hanging the suite.
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
