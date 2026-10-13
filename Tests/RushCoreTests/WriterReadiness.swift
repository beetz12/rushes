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

/// H.264 fixture settings: codec and dimensions only. No software-encoder
/// profile is requested.
func fixtureH264Settings(width: Int, height: Int) -> [String: Any] {
    [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
    ]
}

/// Fixture writers only. A finish that never returns pins the hosted runner.
/// Real exports wait for `finishWriting` without this deadline.
func finishWriting(_ writer: AVAssetWriter, within seconds: Double) async throws {
    let gate = OnceGate()
    let finished: Bool = await withCheckedContinuation { continuation in
        writer.finishWriting {
            if gate.claim() { continuation.resume(returning: true) }
        }
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + seconds) {
            if gate.claim() { continuation.resume(returning: false) }
        }
    }
    if finished {
        guard writer.status == .completed else {
            throw renderFailure(writer.error?.localizedDescription ?? "Writer failed during finalize")
        }
        return
    }
    // Dropping the writer while VideoToolbox is still inside finishWriting
    // segfaults. Keep it alive for the rest of the process.
    StalledWriters.shared.keep(writer)
    throw ControlFailure(code: "encoder-stalled", message: "Writer did not finish within \(Int(seconds)) seconds")
}

private final class StalledWriters: @unchecked Sendable {
    static let shared = StalledWriters()
    private let lock = NSLock()
    private var held: [AVAssetWriter] = []
    func keep(_ writer: AVAssetWriter) {
        lock.lock()
        held.append(writer)
        lock.unlock()
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
