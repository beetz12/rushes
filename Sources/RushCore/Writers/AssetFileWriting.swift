import AVFoundation
import CoreMedia
import Foundation

/// Mirrors `AVAssetWriter.Status` for the backend protocol.
internal enum FileWritingState: Sendable {
    /// Created but `startWriting` has not run (or returned) yet.
    case idle
    case writing
    case completed
    case failed
}

/// One output file's `AVAssetWriter` plus its single input, isolated behind a
/// protocol so unit tests can drive a `TrackWriter` with stubs instead of
/// hardware encoders.
///
/// Confinement contract: every method except `finishWriting(completion:)` is
/// called on the owning `TrackWriter`'s serial queue. The completion handler
/// of `finishWriting` runs on an AVFoundation-internal queue and must only
/// touch `Sendable` state.
internal protocol TrackFileWriting: AnyObject {

    var outputURL: URL { get }

    /// The writer's current state. Reading this is the health check: a writer
    /// that silently entered `.failed` (disk full, encoder death, bad
    /// timestamps) is reported here and in `failureDescription`.
    var currentState: FileWritingState { get }

    /// The writer's error, formatted for a status report, or nil.
    var failureDescription: String? { get }

    /// Whether the input accepts more media right now.
    var isReadyForMoreMediaData: Bool { get }

    /// `AVAssetWriter.startWriting()`. False when the writer cannot start,
    /// which is where an unavailable encoder surfaces.
    @discardableResult
    func startWriting() -> Bool

    /// `startSession(atSourceTime: .zero)`: the file's media time zero is the
    /// session epoch.
    func startSession()
    func endSession(atMediaNs: Int64)

    /// Appends one video frame at a media-clock time.
    @discardableResult
    func appendVideoFrame(_ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool

    /// Appends one (already media-timed) audio buffer.
    @discardableResult
    func appendAudioSamples(_ sampleBuffer: CMSampleBuffer) -> Bool

    /// `markAsFinished()` on the input.
    func markInputFinished()

    /// `finishWriting(_:)`. The completion fires exactly once on success; a
    /// hung writer may never call it (bounded finalize handles that).
    func finishWriting(completion: @escaping @Sendable () -> Void)

    /// `cancelWriting()`.
    func cancelWriting()
}

/// Builds backends. Injected so tests can supply stub writers, including ones
/// that refuse a codec to drive the HEVC-to-H.264 fallback.
extension TrackFileWriting {
    func endSession(atMediaNs: Int64) {}
}

internal protocol TrackFileWritingFactory: Sendable {
    /// Creates (but does not start) a writer for the configuration.
    /// Throws when the file cannot be created or the codec has no settings.
    func makeWriter(
        configuration: TrackWriterConfiguration,
        codec: VideoCodec
    ) throws -> any TrackFileWriting
}

/// The production factory: real `AVAssetWriter` backends.
internal struct AssetFileWriterFactory: TrackFileWritingFactory {
    func makeWriter(
        configuration: TrackWriterConfiguration,
        codec: VideoCodec
    ) throws -> any TrackFileWriting {
        try AVAssetFileWriter(configuration: configuration, codec: codec)
    }
}

/// Real `AVAssetWriter` conformer of `TrackFileWriting`.
///
/// All state is confined to the owning `TrackWriter`'s serial queue (hence
/// `@unchecked Sendable`); only `finishWriting`'s completion crosses threads,
/// and that is handled by the caller.
internal final class AVAssetFileWriter: TrackFileWriting, @unchecked Sendable {

    let outputURL: URL

    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var firstVideoInput: String?

    init(configuration: TrackWriterConfiguration, codec: VideoCodec) throws {
        outputURL = configuration.outputURL
        try? FileManager.default.removeItem(at: configuration.outputURL)

        writer = try AVAssetWriter(outputURL: configuration.outputURL, fileType: .mov)
        // Fragmented movie: a crash or forced quit leaves a file playable up
        // to the last complete fragment (docs/PLAN.md, Crash safety).
        writer.movieFragmentInterval = CMTime(
            seconds: configuration.fragmentIntervalSeconds, preferredTimescale: 600)

        if configuration.kind.carriesVideo {
            guard let settings = configuration.videoOutputSettings(codec: codec) else {
                throw TrackWriterError.videoTrackMissingDimensions(
                    width: configuration.videoWidth, height: configuration.videoHeight)
            }
            input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            // Preserve sub-millisecond video timestamps. The default
            // MOV scale of 600 can collapse a live frame and a nearby static
            // heartbeat frame onto the same stored presentation time.
            // Nanosecond scale 1e9 fails a native MOV with a sixty-second sparse
            // gap; microsecond scale preserves close frames and long gaps.
            input.mediaTimeScale = 1_000_000
            adaptor = AVAssetWriterInputPixelBufferAdaptor(
                assetWriterInput: input,
                sourcePixelBufferAttributes: [
                    kCVPixelBufferPixelFormatTypeKey as String:
                        kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                    kCVPixelBufferWidthKey as String: configuration.videoWidth ?? 0,
                    kCVPixelBufferHeightKey as String: configuration.videoHeight ?? 0,
                ])
        } else {
            guard let settings = configuration.audioOutputSettings() else {
                throw TrackWriterError.audioTrackWithoutSettings(kind: configuration.kind)
            }
            input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            adaptor = nil
        }
        // Real-time source: the writer is fed at capture rate, and the input
        // may signal not-ready instead of buffering without bound.
        input.expectsMediaDataInRealTime = true
        writer.add(input)
    }

    var currentState: FileWritingState {
        switch writer.status {
        case .unknown: return .idle
        case .writing: return .writing
        case .completed: return .completed
        case .failed: return .failed
        default: return .failed
        }
    }

    var failureDescription: String? {
        writer.error.map { Self.describeFailure($0 as NSError, videoInput: firstVideoInput) }
    }

    /// Diagnostics deliberately omit arbitrary user-info values and imagery.
    /// Native domains/codes survive localization and distinguish encoder errors.
    static func describeFailure(_ error: NSError, videoInput: String? = nil) -> String {
        var codes: [String] = []
        var current: NSError? = error
        var visited = Set<ObjectIdentifier>()
        while let native = current, codes.count < 4,
              visited.insert(ObjectIdentifier(native)).inserted {
            codes.append("\(native.domain)(\(native.code))")
            current = native.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        let input = videoInput.map { "; first video input \($0)" } ?? ""
        return "\(error.localizedDescription) [\(codes.joined(separator: " <- "))]\(input)"
    }

    static func videoInputDescription(_ pixelBuffer: CVPixelBuffer) -> String {
        let format = CVPixelBufferGetPixelFormatType(pixelBuffer)
        let bytes = stride(from: 24, through: 0, by: -8).map { shift -> UInt8 in
            let byte = UInt8(truncatingIfNeeded: format >> shift)
            return (32...126).contains(byte) ? byte : 46
        }
        let fourCC = String(bytes: bytes, encoding: .ascii) ?? "????"
        return "\(fourCC)/\(format) \(CVPixelBufferGetWidth(pixelBuffer))x\(CVPixelBufferGetHeight(pixelBuffer))"
    }

    var isReadyForMoreMediaData: Bool {
        input.isReadyForMoreMediaData
    }

    @discardableResult
    func startWriting() -> Bool {
        writer.startWriting()
    }

    func startSession() {
        writer.startSession(atSourceTime: .zero)
    }

    @discardableResult
    func appendVideoFrame(_ pixelBuffer: CVPixelBuffer, mediaTimeNs: Int64) -> Bool {
        guard let adaptor else { return false }
        if firstVideoInput == nil { firstVideoInput = Self.videoInputDescription(pixelBuffer) }
        // The adaptor throws an ObjC exception (not a false return) when a
        // pixel buffer is appended while the input is not ready, so gate on
        // readiness here and report "not now" as false.
        guard input.isReadyForMoreMediaData else { return false }
        return adaptor.append(
            pixelBuffer, withPresentationTime: CMTime(exactNanoseconds: mediaTimeNs))
    }

    @discardableResult
    func appendAudioSamples(_ sampleBuffer: CMSampleBuffer) -> Bool {
        input.append(sampleBuffer)
    }

    func endSession(atMediaNs: Int64) {
        writer.endSession(atSourceTime: CMTime(exactNanoseconds: atMediaNs))
    }

    func markInputFinished() {
        input.markAsFinished()
    }

    func finishWriting(completion: @escaping @Sendable () -> Void) {
        writer.finishWriting { completion() }
    }

    func cancelWriting() {
        writer.cancelWriting()
    }
}
