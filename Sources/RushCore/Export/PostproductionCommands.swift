import Foundation

extension PostproductionService {
    public static let commands:Set<String> = ["export","edit.get","edit.set","edit.undo","edit.redo","edit.save","edit.discard","edit.cut","edit.split","thumbnail","layout.frames","share.assets"]
    public func handle(_ request:ControlRequest) async throws -> JSONValue {
        guard let id=request.param("id")?.string,!id.isEmpty else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"A recording ID is required") }
        switch request.cmd {
        case "edit.get": return try JSONValue(encoding:await getEdit(id:id))
        case "share.assets": return try JSONValue(encoding:await ShareAssetsService(root:root,postproduction:self).assets(id:id))
        case "layout.frames":
            let override:EditLayout?
            if let value=request.param("layout") { override=try JSONDecoder().decode(EditLayout.self,from:ControlWire.encoder.encode(value)) }
            else { override=nil }
            return try await layoutFrames(id:id,layout:override,canvasAspect:request.param("canvasAspect")?.double)
        case "edit.undo": return try JSONValue(encoding:await undo(id:id))
        case "edit.redo": return try JSONValue(encoding:await redo(id:id))
        case "edit.save": return try JSONValue(encoding:await save(id:id))
        case "edit.discard": return try JSONValue(encoding:await discard(id:id))
        case "edit.set":
            var edit=try await getEdit(id:id)
            if let document=request.param("edit") {
                let defaults=try JSONValue(encoding:EditDocument(durationMs:edit.durationMs))
                do { edit=try JSONDecoder().decode(EditDocument.self,from:ControlWire.encoder.encode(merge(defaults,document))) }
                catch { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Invalid edit document: \(error)") }
            } else {
                if request.param("startMs") != nil || request.param("endMs") != nil {
                    edit.clips=[EditClip(id:"c1",sourceStartMs:request.param("startMs")?.double ?? 0,sourceEndMs:request.param("endMs")?.double ?? edit.clips.last!.sourceEndMs,speed:request.param("speed")?.double ?? 1)]
                    edit.zoomCues=[]
                }
                if let value=request.param("layout")?.string { guard let preset=LayoutPreset(rawValue:value) else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Unknown layout") }; edit.layout.preset=preset }
                if let value=request.param("micGain")?.double { edit.audio.micGain=value }
                if let value=request.param("systemGain")?.double { edit.audio.systemGain=value }
                if let value=request.param("micMuted")?.bool { edit.audio.micMuted=value }
                if let value=request.param("bubbleVisible")?.bool { edit.layout.bubble.visible=value }
                if let value=request.param("bubbleSize")?.double { edit.layout.bubble.size=value }
                if let value=request.param("bubbleX")?.double { edit.layout.bubble.center[0]=value }
                if let value=request.param("bubbleY")?.double { edit.layout.bubble.center[1]=value }
                if let value=request.param("mirror")?.bool { edit.layout.bubble.mirror=value }
                if let value=request.param("shape")?.string { edit.layout.bubble.shape=value }
                if let value=request.param("title")?.string { edit.meta.title=value }
                if let value=request.param("burnIn")?.bool { edit.captions.burnIn=value }
            }
            return try JSONValue(encoding:await setEdit(id:id,edit:edit))
        case "edit.cut":
            guard let ranges=request.param("cuts") else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"cuts is required") }
            let cuts=try JSONDecoder().decode([EditCut].self,from:ControlWire.encoder.encode(ranges))
            return try JSONValue(encoding:await applyCuts(id:id,cuts:cuts))
        case "edit.split":
            guard let clip=request.param("clipId")?.string,let time=request.param("atMs")?.double else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"clipId and atMs are required") }
            var edit=try await getEdit(id:id); try edit.split(clipId:clip,at:time)
            return try JSONValue(encoding:await setEdit(id:id,edit:edit))
        case "export":
            guard let preset=ExportPreset(rawValue:request.param("preset")?.string ?? "share") else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Unknown export preset") }
            let path=request.param("path")?.string ?? request.param("output")?.string
            guard let path,!path.isEmpty else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Export output path is required") }
            let extensionType=URL(fileURLWithPath:path).pathExtension.lowercased()
            let inferredContainer=(preset == .audio && ["m4a","wav"].contains(extensionType)) || (preset == .full && ["mov","mp4"].contains(extensionType)) ? extensionType : nil
            let options=ExportOptions(preset:preset,codec:request.param("codec")?.string ?? "h264",container:request.param("container")?.string ?? inferredContainer,fps:request.param("fps")?.int.map(Int.init),sourceSize:request.param("sourceSize")?.bool ?? false)
            return try JSONValue(encoding:await export(id:id,options:options,to:URL(fileURLWithPath:path)))
        case "thumbnail":
            guard let path=request.param("path")?.string ?? request.param("output")?.string else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Thumbnail output path is required") }
            return try await thumbnail(id:id,to:URL(fileURLWithPath:path),atMs:request.param("atMs")?.double ?? 0,width:request.param("width")?.int.map(Int.init) ?? 1280,height:request.param("height")?.int.map(Int.init) ?? 720)
        default: throw ControlFailure(code:ControlErrorCode.unknownCommand,message:"Unknown postproduction command")
        }
    }
}
private func merge(_ base:JSONValue,_ update:JSONValue) -> JSONValue {
    guard var object=base.object,let additions=update.object else { return update }
    for (key,value) in additions { object[key]=object[key].map { merge($0,value) } ?? value }
    return .object(object)
}
