import Foundation

public enum ExportPreset: String, Codable, CaseIterable, Sendable {
    case share, full, youtube, audio, editorTracks = "editor-tracks"
}
public struct ExportOptions: Codable, Equatable, Sendable {
    public var preset: ExportPreset
    public var codec: String
    public var container: String
    public var fps: Int
    public var sourceSize: Bool
    public init(preset: ExportPreset = .share, codec: String = "h264", container: String? = nil, fps: Int? = nil, sourceSize: Bool = false) {
        self.preset=preset; self.codec=codec; self.container=container ?? (preset == .audio ? "m4a" : "mp4")
        self.fps=fps ?? (preset == .youtube ? 60 : 30); self.sourceSize=sourceSize
    }
    public func validate() throws {
        guard [30,60].contains(fps), ["h264","hevc"].contains(codec), ["mp4","mov","m4a","wav"].contains(container),
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
