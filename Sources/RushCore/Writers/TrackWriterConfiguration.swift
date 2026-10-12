import AVFoundation
import Foundation

/// Which of a recording's four media files a `TrackWriter` produces.
public enum TrackKind: String, Codable, Sendable {

    /// The recorded display, window or area. Video only.
    case screen

    /// The camera picture. Video only.
    case camera

    /// The microphone. Audio only.
    case microphone

    /// System audio. Audio only.
    case systemAudio

    /// Whether this kind carries a video track.
    public var carriesVideo: Bool {
        self == .screen || self == .camera
    }

    /// Whether this kind carries an audio track.
    public var carriesAudio: Bool {
        !carriesVideo
    }
}

/// Master codec for a video track.
public enum VideoCodec: String, Codable, Sendable {

    /// The preferred master codec for screen and camera files.
    case hevc

    /// The fallback when no HEVC encoder can start.
    case h264

    /// The codec to try when this one cannot start (docs/PLAN.md, Track
    /// settings: HEVC falls back to H.264; H.264 has no further fallback).
    public var fallback: VideoCodec? {
        self == .hevc ? .h264 : nil
    }
}

/// Everything a `TrackWriter` needs to build its file: the output URL, the
/// track kind, and the codec settings from the plan's Track settings table.
///
/// This is a value type. The settings builders (`videoOutputSettings`,
/// `audioOutputSettings`) are derived, so the plan's bitrate, frame-rate and
/// keyframe rules live in exactly one place and can be unit tested without an
/// encoder.
public struct TrackWriterConfiguration: Sendable {

    /// The track this writer produces.
    public let kind: TrackKind

    /// File the writer owns. The writer removes any existing file at start.
    public let outputURL: URL

    /// Video dimensions in pixels. Required and only meaningful for video
    /// kinds; the appended pixel buffers must match.
    public let videoWidth: Int?
    public let videoHeight: Int?

    /// Video codec to try first (docs/PLAN.md, Track settings). Audio kinds
    /// ignore this.
    public let preferredVideoCodec: VideoCodec

    /// Movie fragment interval in seconds. One second, so a crash loses at
    /// most one fragment interval of footage.
    public let fragmentIntervalSeconds: Double

    /// Backpressure bound: video frames accepted but not yet handed to the
    /// encoder. When the deque is full the writer drops the oldest frame
    /// instead of growing memory.
    public let maxPendingVideoFrames: Int

    /// Audio gap threshold in nanoseconds on the media clock. Gaps between the
    /// end of the last written audio and the next sample longer than this are
    /// filled with silence.
    public let audioGapThresholdNs: Int64

    public init(
        kind: TrackKind,
        outputURL: URL,
        videoWidth: Int? = nil,
        videoHeight: Int? = nil,
        preferredVideoCodec: VideoCodec = .hevc,
        fragmentIntervalSeconds: Double = 1,
        maxPendingVideoFrames: Int = 8,
        audioGapThresholdNs: Int64 = 250_000_000
    ) {
        precondition(kind.carriesVideo || (videoWidth == nil && videoHeight == nil),
                      "audio tracks take no video dimensions")
        precondition(maxPendingVideoFrames > 0, "maxPendingVideoFrames must be at least 1")
        precondition(audioGapThresholdNs >= 0, "audioGapThresholdNs must not be negative")
        self.kind = kind
        self.outputURL = outputURL
        self.videoWidth = videoWidth
        self.videoHeight = videoHeight
        self.preferredVideoCodec = preferredVideoCodec
        self.fragmentIntervalSeconds = fragmentIntervalSeconds
        self.maxPendingVideoFrames = maxPendingVideoFrames
        self.audioGapThresholdNs = audioGapThresholdNs
    }

    /// Screen master: `screen.mov`.
    public static func screen(
        outputURL: URL,
        width: Int,
        height: Int,
        codec: VideoCodec = .hevc
    ) -> TrackWriterConfiguration {
        TrackWriterConfiguration(
            kind: .screen, outputURL: outputURL, videoWidth: width, videoHeight: height,
            preferredVideoCodec: codec)
    }

    /// Camera master: `camera.mov`.
    public static func camera(
        outputURL: URL,
        width: Int,
        height: Int,
        codec: VideoCodec = .hevc
    ) -> TrackWriterConfiguration {
        TrackWriterConfiguration(
            kind: .camera, outputURL: outputURL, videoWidth: width, videoHeight: height,
            preferredVideoCodec: codec)
    }

    /// Microphone master: `mic.mov` (AAC-LC, 48 kHz, mono, 128 kbit/s).
    public static func microphone(outputURL: URL) -> TrackWriterConfiguration {
        TrackWriterConfiguration(kind: .microphone, outputURL: outputURL)
    }

    /// System audio master: `system.mov` (AAC-LC, 48 kHz, stereo, 192 kbit/s).
    public static func systemAudio(outputURL: URL) -> TrackWriterConfiguration {
        TrackWriterConfiguration(kind: .systemAudio, outputURL: outputURL)
    }
}

// MARK: - Derived AVAssetWriter settings

extension TrackWriterConfiguration {

    /// Output settings for one video codec, or nil when this configuration is
    /// not a complete video track.
    ///
    /// Rules from the plan's Track settings table: the screen master targets
    /// 60 fps with an average bitrate of at least 20 Mbit/s or
    /// width x height x 4 bit/s and a keyframe every 60 frames; the camera
    /// master targets 30 fps with at least 6 Mbit/s (or width x height x 6)
    /// and a keyframe every 30 frames.
    func videoOutputSettings(codec: VideoCodec) -> [String: Any]? {
        guard kind.carriesVideo,
              let width = videoWidth, let height = videoHeight,
              width > 0, height > 0 else { return nil }
        let bitrate: Int
        let frameRate: Int
        let keyframeInterval: Int
        switch kind {
        case .screen:
            bitrate = max(20_000_000, width * height * 4)
            frameRate = 60
            keyframeInterval = 60
        case .camera:
            bitrate = max(6_000_000, width * height * 6)
            frameRate = 30
            keyframeInterval = 30
        case .microphone, .systemAudio:
            return nil
        }
        var settings: [String: Any] = [
            AVVideoCodecKey: codec == .hevc ? AVVideoCodecType.hevc : AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoExpectedSourceFrameRateKey: frameRate,
                AVVideoMaxKeyFrameIntervalKey: keyframeInterval,
                AVVideoMaxKeyFrameIntervalDurationKey: 1.0,
            ] as [String: Any],
        ]
        // GitHub-hosted macOS has no AppleM2ScalerParavirtDriver. Hardware
        // VideoToolbox never finishes there; software encode does.
        if ProcessInfo.processInfo.environment["CI"] == "true" {
            settings[AVVideoEncoderSpecificationKey] = [
                "EnableHardwareAcceleratedVideoEncoder": false,
            ]
        }
        return settings
    }

    /// Output settings for the audio track, or nil for video kinds.
    ///
    /// Microphone is AAC-LC at 48 kHz mono 128 kbit/s; system audio is AAC-LC
    /// at 48 kHz stereo 192 kbit/s (docs/PLAN.md, Track settings).
    func audioOutputSettings() -> [String: Any]? {
        switch kind {
        case .microphone:
            return [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 128_000,
            ] as [String: Any]
        case .systemAudio:
            return [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 48_000,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 192_000,
            ] as [String: Any]
        case .screen, .camera:
            return nil
        }
    }
}
