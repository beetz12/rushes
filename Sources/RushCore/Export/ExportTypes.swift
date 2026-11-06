import Foundation

public enum ExportPreset: String, Codable, CaseIterable, Sendable {
    case share, full, youtube, audio, editorTracks = "editor-tracks", gif
}
public struct ExportOptions: Codable, Equatable, Sendable {
    public var preset: ExportPreset
    public var codec: String
    public var container: String
    public var fps: Int
    public var sourceSize: Bool
    /// Animated GIF only: the edited-timeline range and output width. Nil
    /// fields are omitted when encoded, so other presets keep their cache keys.
    public var gifStartMs: Double?
    public var gifDurationMs: Double?
    public var gifWidth: Int?
    public static let gifDefaultDurationMs: Double = 5_000
    public static let gifMaxDurationMs: Double = 15_000
    public static let gifDefaultWidth = 480
    public static let gifMaxBytes = 8 * 1_048_576
    public init(preset: ExportPreset = .share, codec: String = "h264", container: String? = nil, fps: Int? = nil, sourceSize: Bool = false,
                gifStartMs: Double? = nil, gifDurationMs: Double? = nil, gifWidth: Int? = nil) {
        self.preset=preset; self.codec=codec; self.container=container ?? (preset == .audio ? "m4a" : preset == .gif ? "gif" : "mp4")
        self.fps=fps ?? (preset == .youtube ? 60 : preset == .gif ? 10 : 30); self.sourceSize=sourceSize
        if preset == .gif { self.gifStartMs=gifStartMs; self.gifDurationMs=gifDurationMs; self.gifWidth=gifWidth }
    }
    public func validate() throws {
        if preset == .gif {
            guard container == "gif", [10,12].contains(fps), !sourceSize,
                  gifStartMs.map({ $0.isFinite && $0 >= 0 }) ?? true,
                  gifDurationMs.map({ $0.isFinite && $0 > 0 && $0 <= Self.gifMaxDurationMs }) ?? true,
                  gifWidth.map({ (240...640).contains($0) }) ?? true else {
                throw ControlFailure(code: ControlErrorCode.invalidParams, message: "GIF export needs 10 or 12 fps, a width from 240 to 640 and at most 15 seconds")
            }
            return
        }
        guard gifStartMs == nil, gifDurationMs == nil, gifWidth == nil, [30,60].contains(fps), ["h264","hevc"].contains(codec), ["mp4","mov","m4a","wav"].contains(container),
              (preset == .full || codec == "h264"),
              (preset == .audio ? ["m4a","wav"].contains(container) : ["mp4","mov"].contains(container)),
              (preset == .full || preset == .audio || container == "mp4") else {
            throw ControlFailure(code: ControlErrorCode.invalidParams, message: "Invalid export container, codec or frame rate")
        }
    }
}
public struct ExportResult: Codable, Equatable, Sendable {
    public var id: String
    public var path: String
    public var preset: String
    public var cacheKey: String
    public var cached: Bool
    public var durationMs: Double
    public var width: Int
    public var height: Int
    public var fps: Int
}
public struct ExportProgress: Codable, Equatable, Sendable {
    public var frames: Int
    public var totalFrames: Int
    public var fraction: Double
    public init(frames: Int,totalFrames: Int) { self.frames=frames; self.totalFrames=totalFrames; fraction=Double(frames)/Double(max(1,totalFrames)) }
}
