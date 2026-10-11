import Foundation

/// An auxiliary projection preserves forward-compatible optional geometry before
/// the capture manifest's typed model gains the same sizeFraction property.
enum RecordingBubbleSeed {
    private struct Envelope:Decodable {
        var bubble:Bubble?
        var capture:Capture?
        struct Capture:Decodable { var pointToPixel:Double? }
        struct Bubble:Decodable {
            var center:[Double]?
            var visible:Bool?
            var size:Double?
            var sizeFraction:Double?
        }
    }
    static func apply(to edit:inout EditDocument,package:RecordingPackage,manifest:RecordingManifest) throws {
        let handle=try FileHandle(forReadingFrom:PostproductionPaths.file("manifest.json",in:package.folderURL))
        defer { try? handle.close() }
        let bytes=try handle.read(upToCount:1_048_577) ?? Data()
        guard bytes.count<=1_048_576 else { throw renderFailure("Recording manifest exceeds geometry projection limit") }
        let projection=try JSONDecoder().decode(Envelope.self,from:bytes)
        guard let bubble=projection.bubble else { return }
        if let center=bubble.center {
            guard center.count == 2,center.allSatisfy({$0.isFinite && (0...1).contains($0)}) else { throw renderFailure("Recorded bubble center is invalid") }
            edit.layout.bubble.center=center
        }
        if let visible=bubble.visible { edit.layout.bubble.visible=visible }
        var fraction=bubble.sizeFraction
        if fraction == nil,let points=bubble.size,let scale=projection.capture?.pointToPixel,
           let pixels=manifest.tracks.first(where:{$0.kind == .screen})?.width,
           scale.isFinite,scale>0,pixels>0,[160.0,200.0,280.0].contains(points) {
            fraction=points*scale/Double(pixels)
        }
        if let fraction {
            guard fraction.isFinite,fraction>0,fraction<=1 else { throw renderFailure("Recorded bubble size fraction is invalid") }
            edit.layout.bubble.size=fraction
        }
    }
}
