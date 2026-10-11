import AVFoundation
import Foundation

/// A read-only look at one media file with AVFoundation. Shared by recovery
/// (keep-if-playable decision) and `verify` (decode test).
struct MediaProbe: Equatable, Sendable {
    /// Whether AVFoundation could load the file at all.
    let openable: Bool
    let durationSeconds: Double?
    let videoTrackCount: Int
    let audioTrackCount: Int
    let errorDescription: String?
}

enum MediaProbing {

    /// Loads `url` with `AVURLAsset` and reports duration and track counts.
    /// Never throws: an unopenable file is a probe outcome, not an error,
    /// so callers can record it as a finding.
    static func probe(url: URL) async -> MediaProbe {
        let asset = AVURLAsset(url: url)
        do {
            let duration = try await asset.load(.duration)
            let video = try await asset.loadTracks(withMediaType: .video)
            let audio = try await asset.loadTracks(withMediaType: .audio)
            let seconds = duration.seconds.isFinite ? duration.seconds : nil
            return MediaProbe(
                openable: true,
                durationSeconds: seconds,
                videoTrackCount: video.count,
                audioTrackCount: audio.count,
                errorDescription: nil)
        } catch {
            return MediaProbe(
                openable: false,
                durationSeconds: nil,
                videoTrackCount: 0,
                audioTrackCount: 0,
                errorDescription: String(describing: error))
        }
    }
}
