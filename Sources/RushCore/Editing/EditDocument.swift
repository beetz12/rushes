import Foundation

public struct EditClip: Codable, Equatable, Sendable {
    public var id: String
    public var sourceStartMs: Double
    public var sourceEndMs: Double
    public var speed: Double
    public init(id: String = UUID().uuidString, sourceStartMs: Double, sourceEndMs: Double, speed: Double = 1) {
        self.id = id; self.sourceStartMs = sourceStartMs; self.sourceEndMs = sourceEndMs; self.speed = speed
    }
    public var durationMs: Double { (sourceEndMs - sourceStartMs) / speed }
}
public struct EditCut: Codable, Equatable, Sendable {
    public var sourceStartMs: Double
    public var sourceEndMs: Double
    public var reason: String
    public var wordIds: [String]
    public init(sourceStartMs: Double, sourceEndMs: Double, reason: String, wordIds: [String] = []) {
        self.sourceStartMs = sourceStartMs; self.sourceEndMs = sourceEndMs; self.reason = reason; self.wordIds = wordIds
    }
}
public enum LayoutPreset: String, Codable, CaseIterable, Sendable {
    case bubble, overlap, sideBySide = "side-by-side", presenter, cameraOnly = "camera-only", screenOnly = "screen-only"
}
public struct BubbleSettings: Codable, Equatable, Sendable {
    public var center: [Double] = [0.88, 0.82]
    public var size: Double = 0.22
    public var shape: String = "circle"
    public var roundness: Double = 1
    public var mirror: Bool = true
    public var visible: Bool = true
    public init() {}
}
public struct EditLayout: Codable, Equatable, Sendable {
    public var preset: LayoutPreset = .bubble
    public var cameraAspect: String = "1:1"
    public var canvas: String = "source"
    public var bubble = BubbleSettings()
    public init() {}
}
public struct EditAudio: Codable, Equatable, Sendable {
    public var micGain: Double = 1
    public var systemGain: Double = 0.5
    public var micMuted: Bool = false
    public init() {}
}
public struct EditCaptions: Codable, Equatable, Sendable {
    public var burnIn: Bool = false
    public var style: String = "default"
    public var fontSize: Double = 36
    public var position: Double = 0.88
    public init() {}
}
public struct ZoomCue: Codable, Equatable, Sendable {
    public var id: String = UUID().uuidString
    public var clipId: String
    public var sourceStartMs: Double
    public var sourceEndMs: Double
    public var scale: Double
    public var focus: [Double]
    public var origin: String = "auto"
    public init(clipId: String, sourceStartMs: Double, sourceEndMs: Double, scale: Double, focus: [Double], origin: String = "auto") {
        self.clipId = clipId; self.sourceStartMs = sourceStartMs; self.sourceEndMs = sourceEndMs
        self.scale = scale; self.focus = focus; self.origin = origin
    }
}
public struct EditChapter: Codable, Equatable, Sendable {
    public var startMs: Double
    public var title: String
    public init(startMs: Double, title: String) { self.startMs = startMs; self.title = title }
}
public struct EditMeta: Codable, Equatable, Sendable {
    public var title: String = "Untitled recording"
    public var summary: String?
    public var chapters: [EditChapter] = []
    public init() {}
}
public struct EditExportSettings: Codable, Equatable, Sendable {
    public var preset: String = "share"
    public var lastPath: String?
    public init() {}
}
public struct EditDocument: Codable, Equatable, Sendable {
    public static let currentSchema = "rushes.edit/1"
    public var schema: String = currentSchema
    public var revision: Int = 0
    public var clips: [EditClip]
    public var cuts: [EditCut] = []
    public var layout = EditLayout()
    public var zoomCues: [ZoomCue] = []
    public var audio = EditAudio()
    public var captions = EditCaptions()
    public var export = EditExportSettings()
    public var meta = EditMeta()
    public var drawCursor: Bool = false
    public init(durationMs: Double, title: String? = nil) {
        clips = [EditClip(id: "c1", sourceStartMs: 0, sourceEndMs: durationMs)]
        meta.title = title ?? "Untitled recording"
    }
    public var durationMs: Double { clips.reduce(0) { $0 + $1.durationMs } }
    public func validate(sourceDurationMs: Double) throws {
        guard schema == Self.currentSchema else { throw invalid("Unsupported edit schema") }
        guard !clips.isEmpty, Set(clips.map(\.id)).count == clips.count else { throw invalid("Keep at least one clip with unique identifiers") }
        for clip in clips {
            guard !clip.id.isEmpty, clip.sourceStartMs.isFinite, clip.sourceEndMs.isFinite, clip.speed.isFinite,
                  clip.sourceStartMs >= 0, clip.sourceEndMs > clip.sourceStartMs,
                  clip.sourceEndMs <= sourceDurationMs + 1, (1...8).contains(clip.speed) else { throw invalid("Clip range or speed is invalid") }
        }
        guard audio.micGain.isFinite, audio.systemGain.isFinite, (0...4).contains(audio.micGain), (0...4).contains(audio.systemGain),
              layout.bubble.center.count == 2, layout.bubble.center.allSatisfy({ $0.isFinite && (0...1).contains($0) }),
              layout.bubble.size.isFinite, (0.05...0.8).contains(layout.bubble.size),
              ["circle", "rounded-square", "squircle"].contains(layout.bubble.shape),
              (0...1).contains(layout.bubble.roundness), ["1:1", "16:9", "4:3", "9:16"].contains(layout.cameraAspect),
              ["source", "16:9", "1:1", "9:16"].contains(layout.canvas),
              captions.fontSize.isFinite, (12...120).contains(captions.fontSize), captions.position.isFinite, (0...1).contains(captions.position)
        else { throw invalid("Layout, caption or audio settings are invalid") }
        for cue in zoomCues {
            guard let clip = clips.first(where: { $0.id == cue.clipId }), cue.sourceStartMs.isFinite, cue.sourceEndMs.isFinite,
                  cue.sourceStartMs >= clip.sourceStartMs, cue.sourceEndMs <= clip.sourceEndMs, cue.sourceEndMs > cue.sourceStartMs,
                  cue.scale.isFinite, (1...4).contains(cue.scale), cue.focus.count == 2,
                  cue.focus.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { throw invalid("Zoom cue must belong to a kept clip") }
        }
    }
    public func sourceTime(at outputMs: Double) -> (clip: EditClip, sourceMs: Double)? {
        var elapsed = 0.0
        for clip in clips {
            if outputMs >= elapsed && outputMs < elapsed + clip.durationMs { return (clip, clip.sourceStartMs + (outputMs - elapsed) * clip.speed) }
            elapsed += clip.durationMs
        }
        return nil
    }
    public mutating func removeRanges(_ ranges: [EditCut]) throws {
        for range in ranges {
            guard range.sourceStartMs.isFinite, range.sourceEndMs.isFinite, range.sourceEndMs > range.sourceStartMs else { throw invalid("Invalid cut interval") }
            var kept: [EditClip] = []
            for clip in clips {
                let start = max(clip.sourceStartMs, range.sourceStartMs), end = min(clip.sourceEndMs, range.sourceEndMs)
                if end <= start { kept.append(clip); continue }
                if start > clip.sourceStartMs { kept.append(EditClip(id: clip.id, sourceStartMs: clip.sourceStartMs, sourceEndMs: start, speed: clip.speed)) }
                if end < clip.sourceEndMs { kept.append(EditClip(sourceStartMs: end, sourceEndMs: clip.sourceEndMs, speed: clip.speed)) }
            }
            guard !kept.isEmpty else { throw invalid("The cut would remove the whole recording") }
            clips = kept; cuts.append(range)
        }
        zoomCues = zoomCues.compactMap { cue in
            guard let clip = clips.first(where: { $0.sourceStartMs <= cue.sourceStartMs && $0.sourceEndMs >= cue.sourceEndMs }) else { return nil }
            var replacement = cue; replacement.clipId = clip.id; return replacement
        }
    }
    public mutating func split(clipId: String, at sourceMs: Double) throws {
        guard let i = clips.firstIndex(where: { $0.id == clipId }), sourceMs > clips[i].sourceStartMs, sourceMs < clips[i].sourceEndMs else { throw invalid("Split must lie within a clip") }
        let original = clips[i]
        clips[i].sourceEndMs = sourceMs
        clips.insert(EditClip(sourceStartMs: sourceMs, sourceEndMs: original.sourceEndMs, speed: original.speed), at: i + 1)
        zoomCues = zoomCues.filter { $0.clipId != clipId }
    }
}
private func invalid(_ message: String) -> ControlFailure { ControlFailure(code: ControlErrorCode.invalidParams, message: message) }

// Decode old equal-schema drafts with defaults; invalid and future schemas are rejected by validate.
extension EditDocument {
    enum CodingKeys: String, CodingKey { case schema, revision, clips, cuts, layout, zoomCues, audio, captions, export, meta, drawCursor }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = try c.decode(String.self, forKey: .schema)
        revision = try c.decodeIfPresent(Int.self, forKey: .revision) ?? 0
        clips = try c.decode([EditClip].self, forKey: .clips)
        cuts = try c.decodeIfPresent([EditCut].self, forKey: .cuts) ?? []
        layout = try c.decodeIfPresent(EditLayout.self, forKey: .layout) ?? EditLayout()
        zoomCues = try c.decodeIfPresent([ZoomCue].self, forKey: .zoomCues) ?? []
        audio = try c.decodeIfPresent(EditAudio.self, forKey: .audio) ?? EditAudio()
        captions = try c.decodeIfPresent(EditCaptions.self, forKey: .captions) ?? EditCaptions()
        export = try c.decodeIfPresent(EditExportSettings.self, forKey: .export) ?? EditExportSettings()
        meta = try c.decodeIfPresent(EditMeta.self, forKey: .meta) ?? EditMeta()
        drawCursor = try c.decodeIfPresent(Bool.self, forKey: .drawCursor) ?? false
    }
}

extension BubbleSettings {
    enum CodingKeys: String, CodingKey { case center, size, shape, roundness, mirror, visible }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        center = try c.decodeIfPresent([Double].self, forKey: .center) ?? [0.88,0.82]
        size = try c.decodeIfPresent(Double.self, forKey: .size) ?? 0.22
        shape = try c.decodeIfPresent(String.self, forKey: .shape) ?? "circle"
        roundness = try c.decodeIfPresent(Double.self, forKey: .roundness) ?? 1
        mirror = try c.decodeIfPresent(Bool.self, forKey: .mirror) ?? true
        visible = try c.decodeIfPresent(Bool.self, forKey: .visible) ?? true
    }
}

extension EditLayout {
    enum CodingKeys: String, CodingKey { case preset, cameraAspect, canvas, bubble }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = try c.decodeIfPresent(LayoutPreset.self, forKey: .preset) ?? .bubble
        cameraAspect = try c.decodeIfPresent(String.self, forKey: .cameraAspect) ?? "1:1"
        canvas = try c.decodeIfPresent(String.self, forKey: .canvas) ?? "source"
        bubble = try c.decodeIfPresent(BubbleSettings.self, forKey: .bubble) ?? BubbleSettings()
    }
}

extension EditAudio {
    enum CodingKeys: String, CodingKey { case micGain, systemGain, micMuted }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        micGain = try c.decodeIfPresent(Double.self, forKey: .micGain) ?? 1
        systemGain = try c.decodeIfPresent(Double.self, forKey: .systemGain) ?? 0.5
        micMuted = try c.decodeIfPresent(Bool.self, forKey: .micMuted) ?? false
    }
}

extension EditCaptions {
    enum CodingKeys: String, CodingKey { case burnIn, style, fontSize, position }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        burnIn = try c.decodeIfPresent(Bool.self, forKey: .burnIn) ?? false
        style = try c.decodeIfPresent(String.self, forKey: .style) ?? "default"
        fontSize = try c.decodeIfPresent(Double.self, forKey: .fontSize) ?? 36
        position = try c.decodeIfPresent(Double.self, forKey: .position) ?? 0.88
    }
}

extension EditMeta {
    enum CodingKeys: String, CodingKey { case title, summary, chapters }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Untitled recording"
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        chapters = try c.decodeIfPresent([EditChapter].self, forKey: .chapters) ?? []
    }
}

extension EditExportSettings {
    enum CodingKeys: String, CodingKey { case preset, lastPath }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        preset = try c.decodeIfPresent(String.self, forKey: .preset) ?? "share"
        lastPath = try c.decodeIfPresent(String.self, forKey: .lastPath)
    }
}
