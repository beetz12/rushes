@preconcurrency import AVFoundation
import Foundation
@testable import RushCore

/// Fixture writers poll readiness. On the CI VM, `isReadyForMoreMediaData`
/// can block inside VideoToolbox instead of returning false, so the poll
/// runs off the test task and gives up if that call does not return.
func waitUntilReadyForMedia(_ input: AVAssetWriterInput, writer: AVAssetWriter) async throws {
    let deadline = Date().addingTimeInterval(15)
    while Date() < deadline {
        switch await readyForMedia(input) {
        case .ready:
            return
        case .notReady:
            break
        case .blocked:
            // One stuck VideoToolbox call is enough. Further polls would
            // leak a thread each and can exhaust the process. Do not
            // cancelWriting here: that races the stuck call and segfaults.
            throw renderFailure("\(input.mediaType.rawValue) encoder readiness did not return")
        }
        try Task.checkCancellation()
        guard writer.status == .writing else {
            throw renderFailure(writer.error?.localizedDescription ?? "Encoder stopped before accepting media")
        }
        try await Task.sleep(for: .milliseconds(20))
    }
    throw renderFailure("\(input.mediaType.rawValue) encoder was not ready within 15 seconds")
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

private enum ReadinessProbe {
    case ready
    case notReady
    case blocked
}

private func readyForMedia(_ input: AVAssetWriterInput) async -> ReadinessProbe {
    await withCheckedContinuation { continuation in
        let gate = OnceGate()
        DispatchQueue.global(qos: .userInitiated).async {
            let ready = input.isReadyForMoreMediaData
            if gate.claim() { continuation.resume(returning: ready ? .ready : .notReady) }
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 2) {
            if gate.claim() { continuation.resume(returning: .blocked) }
        }
    }
}

private final class OnceGate: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if claimed { return false }
        claimed = true
        return true
    }
}
