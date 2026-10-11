import Foundation

/// A point-in-time report on one `TrackWriter`, for the control layer to read
/// while recording and to persist at Stop.
///
/// All fields are counts or instants on the media clock (nanoseconds, zero at
/// the session epoch). This is a value type: reading it never touches
/// AVFoundation.
public struct TrackWriterStatus: Codable, Equatable, Sendable {

    /// Where the writer's finalize stands.
    public enum FinalizeState: String, Codable, Sendable {

        /// Still accepting samples.
        case idle

        /// `finalize` has started; the finish deadline has not yet passed.
        case finalizing

        /// `finishWriting` completed cleanly before the deadline.
        case finalized

        /// The finish deadline passed. The fragmented file on disk keeps every
        /// complete movie fragment AVAssetWriter flushed, so the footage is
        /// playable up to the last fragment; the writer deliberately left the
        /// underlying writer alone instead of cancelling it.
        case degraded

        /// No usable file: the writer failed, or no samples were ever written.
        case failed

        /// Cancelled by the session layer; the output file was removed.
        case cancelled
    }

    /// The track this writer produces.
    public let kind: TrackKind

    /// Samples handed to the encoder: video frames, or audio buffers with
    /// synthesized silence included.
    public let framesWritten: Int64

    /// The subset of `framesWritten` that was synthesized (leading silence,
    /// gap fill, mute and tail padding).
    public let silenceFramesWritten: Int64

    /// Samples lost: backpressure (oldest-first), non-monotonic timestamps, payloads with no image buffer, and an
    /// encoder that was not ready for audio.
    public let framesDropped: Int64
    /// Intentional pause suppression is separate from encoder/backpressure loss.
    public let framesSuppressedByPause: Int64?
    public let microphoneSilent: Bool?

    /// Media time of the first appended sample, or nil when nothing was
    /// written.
    public let firstMediaTimeNs: Int64?

    /// Media time of the newest appended sample: its presentation time for
    /// video, its end for audio. Nil when nothing was written.
    public let lastMediaTimeNs: Int64?

    /// Video frames accepted but not yet handed to the encoder. This is the
    /// backpressure gauge; it never exceeds the configured bound.
    public let pendingDepth: Int

    /// Whether the preferred video codec could not start and the writer fell
    /// back (HEVC to H.264).
    public let usedFallbackCodec: Bool

    /// Where finalize stands.
    public let finalizeState: FinalizeState

    /// First writer failure observed, if any. Never cleared once set.
    public let errorDescription: String?

    public init(
        kind: TrackKind,
        framesWritten: Int64,
        silenceFramesWritten: Int64,
        framesDropped: Int64,
        firstMediaTimeNs: Int64?,
        lastMediaTimeNs: Int64?,
        pendingDepth: Int,
        usedFallbackCodec: Bool,
        finalizeState: FinalizeState,
        errorDescription: String?,
        framesSuppressedByPause: Int64? = 0,
        microphoneSilent: Bool? = false
    ) {
        self.kind = kind
        self.framesWritten = framesWritten
        self.silenceFramesWritten = silenceFramesWritten
        self.framesDropped = framesDropped
        self.firstMediaTimeNs = firstMediaTimeNs
        self.lastMediaTimeNs = lastMediaTimeNs
        self.pendingDepth = pendingDepth
        self.usedFallbackCodec = usedFallbackCodec
        self.finalizeState = finalizeState
        self.errorDescription = errorDescription
        self.framesSuppressedByPause = framesSuppressedByPause
        self.microphoneSilent = microphoneSilent
    }
}
