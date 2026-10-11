import Foundation
import CoreGraphics

public struct LayoutFrames: Equatable, Sendable {
    public var screen: CGRect?
    public var camera: CGRect?
    public var roundCamera: Bool
}
public enum LayoutPlanner {
    /// Fractions use top-left coordinates, shared with the desktop preview.
    public static func frames(layout: EditLayout, canvasAspect: Double, hasCamera: Bool, zoomScale: Double = 1) -> LayoutFrames {
        let full = CGRect(x: 0, y: 0, width: 1, height: 1)
        guard hasCamera && layout.bubble.visible && layout.preset != .screenOnly else { return LayoutFrames(screen: full, camera: nil, roundCamera: false) }
        let aspect = layout.cameraAspect.split(separator: ":").compactMap { Double($0) }
        let cameraAspect = aspect.count == 2 ? aspect[0] / aspect[1] : 1
        switch layout.preset {
        case .screenOnly: return LayoutFrames(screen: full, camera: nil, roundCamera: false)
        case .cameraOnly: return LayoutFrames(screen: nil, camera: full, roundCamera: false)
        case .sideBySide:
            return LayoutFrames(screen: CGRect(x: 0.02, y: 0.04, width: 0.64, height: 0.92), camera: CGRect(x: 0.68, y: 0.04, width: 0.30, height: 0.92), roundCamera: false)
        case .presenter:
            return LayoutFrames(screen: CGRect(x: 0.36, y: 0.06, width: 0.62, height: 0.88), camera: CGRect(x: 0.02, y: 0.04, width: 0.32, height: 0.92), roundCamera: false)
        case .overlap:
            return LayoutFrames(screen: CGRect(x: 0.02, y: 0.03, width: 0.92, height: 0.92), camera: CGRect(x: 0.68, y: 0.56, width: 0.30, height: 0.41), roundCamera: false)
        case .bubble:
            let width = min(0.8, layout.bubble.size / (layout.bubble.shape == "squircle" ? sqrt(max(1, zoomScale)) : 1))
            let height = min(0.9, width * canvasAspect / cameraAspect)
            let center = layout.bubble.center
            return LayoutFrames(screen: full, camera: CGRect(x: min(1-width, max(0, center[0]-width/2)), y: min(1-height, max(0, center[1]-height/2)), width: width, height: height), roundCamera: true)
        }
    }
}
public struct PointerSample: Codable, Equatable, Sendable {
    public var t: Double
    public var k: String
    public var x: Double?
    public var y: Double?
    public var b: Int?
    public init(t: Double, k: String, x: Double? = nil, y: Double? = nil, b: Int? = nil) { self.t=t; self.k=k; self.x=x; self.y=y; self.b=b }
}
public enum AutoZoomPlanner {
    public static func plan(clips: [EditClip], input: [PointerSample], existing: [ZoomCue] = []) -> [ZoomCue] {
        var result = existing.filter { $0.origin != "auto" }
        for clip in clips {
            var pointer = [0.5, 0.5]
            var clicks: [(Double, [Double])] = []
            for sample in input.sorted(by: { $0.t < $1.t }) {
                if let x=sample.x, let y=sample.y { pointer = [max(0,min(1,x)),max(0,min(1,y))] }
                if sample.k == "down", sample.t >= clip.sourceStartMs + 2500 * clip.speed,
                   sample.t < clip.sourceEndMs - 1000 * clip.speed { clicks.append((sample.t,pointer)) }
            }
            var groups: [[(Double,[Double])]] = []
            for click in clicks {
                if let last=groups.last?.last, click.0-last.0 <= 3000 * clip.speed,
                   abs(click.1[0]-last.1[0]) < 0.30, abs(click.1[1]-last.1[1]) < 0.30 { groups[groups.count-1].append(click) }
                else { groups.append([click]) }
            }
            var previousEnd = clip.sourceStartMs + 1000 * clip.speed
            for group in groups {
                guard let first=group.first, let last=group.last else { continue }
                let start=max(clip.sourceStartMs+2500*clip.speed, max(first.0-500*clip.speed, previousEnd+1500*clip.speed))
                let end=min(clip.sourceEndMs-1000*clip.speed,max(last.0+1500*clip.speed,start+1800*clip.speed))
                guard end-start >= 1800*clip.speed, !result.contains(where:{ $0.clipId == clip.id && $0.sourceStartMs < end && $0.sourceEndMs > start }) else { continue }
                let xs=group.map { $0.1[0] }, ys=group.map { $0.1[1] }
                let spread=max((xs.max()!-xs.min()!)+0.24,(ys.max()!-ys.min()!)+0.24)
                result.append(ZoomCue(clipId: clip.id, sourceStartMs: start, sourceEndMs: end, scale: min(1.8,max(1.25,1/spread)), focus: [(xs.max()!+xs.min()!)/2,(ys.max()!+ys.min()!)/2]))
                previousEnd=end
            }
        }
        return result
    }
}
public struct ViewportState: Equatable, Sendable {
    public var scale: Double = 1
    public var x: Double = 0.5
    public var y: Double = 0.5
    public init() {}
}
public struct ViewportTimeline: Sendable {
    public private(set) var state = ViewportState()
    private var velocity = [0.0,0.0,0.0]
    private var activeCue:String?
    private var panFocus=[0.5,0.5]
    public init() {}
    public mutating func tick(clip: EditClip, sourceMs: Double, cues: [ZoomCue], pointer: [Double]?, dt: Double) -> ViewportState {
        let cue = cues.first { $0.clipId == clip.id && $0.sourceStartMs <= sourceMs && $0.sourceEndMs > sourceMs }
        if activeCue != cue?.id { activeCue=cue?.id; panFocus=cue?.focus ?? [0.5,0.5] }
        var target=[cue?.scale ?? 1,panFocus[0],panFocus[1]]
        if cue != nil, let pointer, pointer.count == 2 {
            // A quarter of the viewport width is the inner-box half width.
            // Retain the chosen focus while the pointer stays inside that box.
            let safeHalf=0.25/target[0]
            if abs(pointer[0]-panFocus[0]) > safeHalf { panFocus[0]=pointer[0] }
            if abs(pointer[1]-panFocus[1]) > safeHalf { panFocus[1]=pointer[1] }
            target[1]=panFocus[0]; target[2]=panFocus[1]
        }
        let half=0.5/target[0]
        target[1]=max(half,min(1-half,target[1])); target[2]=max(half,min(1-half,target[2]))
        var current=[state.scale,state.x,state.y]
        let substeps=max(1,Int(ceil(dt*120))), step=dt/Double(substeps)
        for _ in 0..<substeps { for i in 0..<3 {
            velocity[i] += (80*(target[i]-current[i])-18*velocity[i])*step
            current[i] += velocity[i]*step
        } }
        state.scale=max(1,current[0]); state.x=current[1]; state.y=current[2]
        return state
    }
}
