@preconcurrency import AVFoundation
import CoreImage
import CryptoKit
import Darwin
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Owns all writes to each edit document and exports; UI and CLI share this facade.
public actor PostproductionService {
    public let root:URL
    private struct History { var current:EditDocument; var undo:[EditDocument]=[]; var redo:[EditDocument]=[] }
    private var histories:[String:History]=[:]
    private var activeExports:Set<String>=[]
    private var pendingDrafts:[String:UUID]=[:]
    public init(root:URL = RecordingPackage.defaultRoot) { self.root=root }
    private func package(_ id:String) throws -> RecordingPackage {
        guard let package=RecordingPackage.resolve(root:root,id:id) else { throw ControlFailure(code:ControlErrorCode.notFound,message:"No recording with ID \(id)") }
        return package
    }
    private func duration(_ package:RecordingPackage,manifest:RecordingManifest) async throws -> Double {
        if let ns=manifest.clock?.durationNs,ns>0 { return Double(ns)/1_000_000 }
        guard let track=manifest.tracks.first(where:{$0.present && ($0.kind == .screen || $0.kind == .camera || $0.kind == .microphone || $0.kind == .systemAudio)}) else { throw renderFailure("Recording has no masters") }
        let renderer=NativeRenderer(package:package,manifest:manifest,edit:EditDocument(durationMs:1),options:ExportOptions())
        let value=try await AVURLAsset(url:renderer.safeTrackURL(track.file)).load(.duration).seconds*1000
        guard value.isFinite,value>0 else { throw renderFailure("Recording has no playable duration") }; return value
    }
    public func getEdit(id:String) async throws -> EditDocument {
        if let current=histories[id]?.current { return current }
        let package=try package(id),manifest=try package.readManifest()
        let length=try await duration(package,manifest:manifest)
        let draft=try PostproductionPaths.file("edit.draft.json",in:package.folderURL,requireExists:false),saved=try PostproductionPaths.file("edit.json",in:package.folderURL,requireExists:false)
        var edit:EditDocument
        if FileManager.default.fileExists(atPath:draft.path) { edit=try JSONDecoder().decode(EditDocument.self,from:Data(contentsOf:draft)) }
        else if FileManager.default.fileExists(atPath:saved.path) { edit=try JSONDecoder().decode(EditDocument.self,from:Data(contentsOf:saved)) }
        else {
            edit=EditDocument(durationMs:length,title:manifest.title)
            if !manifest.tracks.contains(where:{$0.kind == .screen && $0.present}) && manifest.tracks.contains(where:{$0.kind == .camera && $0.present}) { edit.layout.preset = .cameraOnly }
            let input=try PostproductionPaths.file(manifest.input?.file ?? "input.ndjson",in:package.folderURL,requireExists:false)
            if let data=try? Data(contentsOf:input),let text=String(data:data,encoding:.utf8) {
                let samples=text.split(separator:"\n").compactMap { try? JSONDecoder().decode(PointerSample.self,from:Data($0.utf8)) }
                edit.zoomCues=AutoZoomPlanner.plan(clips:edit.clips,input:samples)
            }
        }
        try edit.validate(sourceDurationMs:length)
        histories[id]=History(current:edit); return edit
    }
    public func setEdit(id:String,edit:EditDocument) async throws -> EditDocument {
        let package=try package(id),manifest=try package.readManifest()
        try edit.validate(sourceDurationMs:try await duration(package,manifest:manifest))
        let old=try await getEdit(id:id)
        var history=histories[id] ?? History(current:old)
        history.undo.append(old); if history.undo.count>100 { history.undo.removeFirst() }; history.redo=[]
        var next=edit; next.revision=old.revision+1
        history.current=next; histories[id]=history
        let autosaveToken=UUID()
        pendingDrafts[id]=autosaveToken
        // Coalesce overlapping slider/typing requests; completion of the latest
        // request confirms its atomic write. Explicit save cancels a pending draft.
        do { try await Task.sleep(for:.milliseconds(250)) }
        catch { if pendingDrafts[id] == autosaveToken { try writeDraft(next,package:package); pendingDrafts.removeValue(forKey:id) }; throw error }
        if pendingDrafts[id] == autosaveToken { try writeDraft(next,package:package); pendingDrafts.removeValue(forKey:id) }
        return next
    }
    public func applyCuts(id:String,cuts:[EditCut]) async throws -> EditDocument {
        var edit=try await getEdit(id:id); try edit.removeRanges(cuts); return try await setEdit(id:id,edit:edit)
    }
    public func undo(id:String) async throws -> EditDocument {
        _=try await getEdit(id:id)
        guard var history=histories[id],var prior=history.undo.popLast() else { throw ControlFailure(code:"nothing-to-undo",message:"No earlier draft") }
        pendingDrafts.removeValue(forKey:id)
        history.redo.append(history.current); prior.revision=history.current.revision+1
        try writeDraft(prior,package:package(id)); history.current=prior; histories[id]=history; return prior
    }
    public func redo(id:String) async throws -> EditDocument {
        _=try await getEdit(id:id)
        guard var history=histories[id],var next=history.redo.popLast() else { throw ControlFailure(code:"nothing-to-redo",message:"No later draft") }
        pendingDrafts.removeValue(forKey:id)
        history.undo.append(history.current); next.revision=history.current.revision+1
        try writeDraft(next,package:package(id)); history.current=next; histories[id]=history; return next
    }
    public func save(id:String) async throws -> EditDocument {
        let edit=try await getEdit(id:id),package=try package(id)
        pendingDrafts.removeValue(forKey:id)
        try writeWithBackup(edit,to:package.folderURL.appendingPathComponent("edit.json"))
        try removeDraft(package); return edit
    }
    public func discard(id:String) async throws -> EditDocument {
        let package=try package(id); pendingDrafts.removeValue(forKey:id); try removeDraft(package); histories.removeValue(forKey:id)
        return try await getEdit(id:id)
    }
    private func removeDraft(_ package:RecordingPackage) throws {
        let url=package.folderURL.appendingPathComponent("edit.draft.json")
        if FileManager.default.fileExists(atPath:url.path) { try FileManager.default.removeItem(at:url) }
    }
    private func writeDraft(_ edit:EditDocument,package:RecordingPackage) throws { try writeWithBackup(edit,to:package.folderURL.appendingPathComponent("edit.draft.json")) }
    private func writeWithBackup(_ edit:EditDocument,to url:URL) throws {
        if FileManager.default.fileExists(atPath:url.path) { try AtomicFileWriter.write(Data(contentsOf:url),to:url.appendingPathExtension("bak")) }
        try AtomicFileWriter.writeEncodable(edit,to:url,encoder:ControlWire.encoder)
    }
    public func export(id:String,options:ExportOptions = ExportOptions(),to output:URL,progress:(@Sendable (ExportProgress)->Void)? = nil) async throws -> ExportResult {
        try options.validate()
        let package=try package(id),manifest=try package.readManifest(),edit=try await getEdit(id:id)
        guard manifest.status == .complete || manifest.status == .recovered else { throw renderFailure("Finalize the recording before exporting it") }
        try protect(output,package:package,manifest:manifest)
        let renderer=NativeRenderer(package:package,manifest:manifest,edit:edit,options:options)
        let key=try cacheKey(package:package,manifest:manifest,edit:edit,options:options)
        guard activeExports.insert(key).inserted else { throw ControlFailure(code:"render-in-progress",message:"This export is already running") }
        defer { activeExports.remove(key) }
        if options.preset == .editorTracks { return try editorTracks(package:package,manifest:manifest,edit:edit,key:key,to:output) }
        let renders=package.folderURL.appendingPathComponent("renders",isDirectory:true)
        try FileManager.default.createDirectory(at:renders,withIntermediateDirectories:true)
        let cache=renders.appendingPathComponent("\(key).\(options.container)"),stamp=renders.appendingPathComponent("\(key).json")
        if let data=try? Data(contentsOf:stamp),var result=try? JSONDecoder().decode(ExportResult.self,from:data),
           FileManager.default.fileExists(atPath:cache.path) {
            try Task.checkCancellation(); try install(cache,to:output)
            result.path=output.path; result.cached=true; return result
        }
        let partial=renders.appendingPathComponent(".partial-\(UUID().uuidString).\(options.container)")
        defer {
            try? FileManager.default.removeItem(at:partial)
            // AVFoundation fast-start rewriting may allocate a same-directory
            // sidecar named after our unique staging file. Remove only our prefix.
            if let files=try? FileManager.default.contentsOfDirectory(at:renders,includingPropertiesForKeys:nil) {
                for file in files where file.lastPathComponent.hasPrefix(partial.lastPathComponent+".") { try? FileManager.default.removeItem(at:file) }
            }
        }
        let dimensions:(Int,Int)
        if options.preset == .full {
            var siblingOptions=options; siblingOptions.container=options.container == "mov" ? "mp4" : "mov"
            let siblingKey=try cacheKey(package:package,manifest:manifest,edit:edit,options:siblingOptions)
            let sibling=renders.appendingPathComponent("\(siblingKey).\(siblingOptions.container)")
            if let data=try? Data(contentsOf:renders.appendingPathComponent("\(siblingKey).json")),
               let prior=try? JSONDecoder().decode(ExportResult.self,from:data),FileManager.default.fileExists(atPath:sibling.path) {
                guard let session=AVAssetExportSession(asset:AVURLAsset(url:sibling),presetName:AVAssetExportPresetPassthrough) else { throw renderFailure("Cannot create container remux") }
                session.shouldOptimizeForNetworkUse=true
                try await session.export(to:partial,as:options.container == "mov" ? .mov : .mp4)
                dimensions=(prior.width,prior.height)
            } else { dimensions=try await renderer.render(to:partial,progress:progress) }
        } else { dimensions=try await renderer.render(to:partial,progress:progress) }
        try Task.checkCancellation()
        try AtomicFileWriter.posixRename(from:partial,to:cache)
        let result=ExportResult(id:id,path:output.path,preset:options.preset.rawValue,cacheKey:key,cached:false,durationMs:edit.durationMs,width:dimensions.0,height:dimensions.1,fps:options.preset == .audio ? 0 : options.fps)
        try AtomicFileWriter.writeEncodable(result,to:stamp,encoder:ControlWire.encoder)
        try install(cache,to:output); return result
    }
    private func cacheKey(package:RecordingPackage,manifest:RecordingManifest,edit:EditDocument,options:ExportOptions) throws -> String {
        var hasher=SHA256()
        var canonical=edit; canonical.revision=0; canonical.export.lastPath=nil
        hasher.update(data:Data("rushes.native-render/1".utf8)); hasher.update(data:try ControlWire.encoder.encode(canonical)); hasher.update(data:try ControlWire.encoder.encode(options))
        hasher.update(data:try ControlWire.encoder.encode(manifest.tracks))
        let renderer=NativeRenderer(package:package,manifest:manifest,edit:edit,options:options)
        for track in manifest.tracks where track.present {
            let file=try FileHandle(forReadingFrom:renderer.safeTrackURL(track.file)); defer { try? file.close() }
            while let bytes=try file.read(upToCount:1_048_576),!bytes.isEmpty { hasher.update(data:bytes) }
        }
        if edit.captions.burnIn { hasher.update(data:try Data(contentsOf:PostproductionPaths.file("transcript.json",in:package.folderURL))) }
        if edit.drawCursor { hasher.update(data:try Data(contentsOf:PostproductionPaths.file(manifest.input?.file ?? "input.ndjson",in:package.folderURL))) }
        return hasher.finalize().map { String(format:"%02x",$0) }.joined()
    }
    private func protect(_ output:URL,package:RecordingPackage,manifest:RecordingManifest) throws {
        let path=output.resolvingSymlinksInPath().path
        let originals=manifest.tracks.map { package.folderURL.appendingPathComponent($0.file).resolvingSymlinksInPath().path }
        let metadata=["manifest.json","edit.json","edit.draft.json","input.ndjson","transcript.json"].map { package.folderURL.appendingPathComponent($0).path }
        let packages=try RecordingPackage.scanManifests(root:root)
        for entry in packages {
            let folder=entry.package.folderURL.resolvingSymlinksInPath().path
            if path.hasPrefix(folder+"/") && !path.hasPrefix(folder+"/renders/") {
                throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Export inside a recording must use its renders folder")
            }
        }
        guard !originals.contains(path),!metadata.contains(path),path != package.folderURL.path,path != root.path else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"An export cannot overwrite a recording master or metadata") }
    }
    private func install(_ source:URL,to output:URL) throws {
        if source.resolvingSymlinksInPath() == output.resolvingSymlinksInPath() { return }
        try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
        let staged=output.deletingLastPathComponent().appendingPathComponent(".partial-\(UUID().uuidString)-\(output.lastPathComponent)")
        defer { try? FileManager.default.removeItem(at:staged) }
        try cloneOrCopy(source,to:staged)
        try AtomicFileWriter.posixRename(from:staged,to:output)
    }
    private func cloneOrCopy(_ source:URL,to target:URL) throws {
        if clonefile(source.path,target.path,0) != 0 { try FileManager.default.copyItem(at:source,to:target) }
    }
    private func editorTracks(package:RecordingPackage,manifest:RecordingManifest,edit:EditDocument,key:String,to output:URL) throws -> ExportResult {
        guard !FileManager.default.fileExists(atPath:output.path) else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Choose a new folder for editor tracks") }
        try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
        let staged=output.deletingLastPathComponent().appendingPathComponent(".partial-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:staged,withIntermediateDirectories:false)
        defer { try? FileManager.default.removeItem(at:staged) }
        let base=manifest.tracks.first { $0.kind == .screen }?.offsetMs ?? 0
        let renderer=NativeRenderer(package:package,manifest:manifest,edit:edit,options:ExportOptions(preset:.editorTracks))
        var entries:[JSONValue]=[]
        for track in manifest.tracks where track.present {
            try Task.checkCancellation()
            let source=try renderer.safeTrackURL(track.file)
            // Export flat names, so imported nested masters cannot traverse the destination.
            let name=RecordingPackage.trackFileName(for:track.kind)
            try cloneOrCopy(source,to:staged.appendingPathComponent(name))
            entries.append(.object(["role":.string(RecordingManifest.RecordingTrack.roleString(for:track.kind)),"file":.string(name),"offsetMs":.int(Int64(track.offsetMs-base-(track.latencyMs ?? 0)))]))
        }
        let offsets=JSONValue.object(["schema":.string("rushes.offsets/1"),"cameraOffsetMs":manifest.cameraOffsetMs.map { .int(Int64($0)) } ?? .null,"tracks":.array(entries),"editApplied":.bool(false)])
        try AtomicFileWriter.writeEncodable(offsets,to:staged.appendingPathComponent("offsets.json"),encoder:ControlWire.encoder)
        try AtomicFileWriter.writeEncodable(edit,to:staged.appendingPathComponent("edit.json"),encoder:ControlWire.encoder)
        try AtomicFileWriter.posixRename(from:staged,to:output)
        return ExportResult(id:manifest.id,path:output.path,preset:"editor-tracks",cacheKey:key,cached:false,durationMs:edit.durationMs,width:0,height:0,fps:0)
    }
    public func layoutFrames(id:String,layout override:EditLayout? = nil,canvasAspect:Double? = nil) async throws -> JSONValue {
        let package=try package(id),manifest=try package.readManifest(),edit=try await getEdit(id:id)
        let layout=override ?? edit.layout
        var candidate=edit; candidate.layout=layout
        try candidate.validate(sourceDurationMs:try await duration(package,manifest:manifest))
        let track=manifest.tracks.first { $0.kind == .screen && $0.present } ?? manifest.tracks.first { $0.kind == .camera && $0.present }
        var aspect=Double(track?.width ?? 1920)/Double(track?.height ?? 1080)
        if layout.canvas == "16:9" { aspect=16/9 }
        if layout.canvas == "1:1" { aspect=1 }
        if layout.canvas == "9:16" { aspect=9/16 }
        if let value=canvasAspect { aspect=value }
        guard aspect.isFinite,aspect>0,aspect<=20 else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Invalid canvas aspect ratio") }
        let hasCamera=manifest.tracks.contains { $0.kind == .camera && $0.present }
        let frames=LayoutPlanner.frames(layout:layout,canvasAspect:aspect,hasCamera:hasCamera)
        func rectangle(_ rect:CGRect?) -> JSONValue {
            guard let rect else { return .null }
            return .object(["x":.double(rect.minX),"y":.double(rect.minY),"width":.double(rect.width),"height":.double(rect.height)])
        }
        return .object(["screen":rectangle(frames.screen),"camera":rectangle(frames.camera),"roundCamera":.bool(frames.roundCamera),"canvasAspect":.double(aspect)])
    }
    public func thumbnail(id:String,to output:URL,atMs:Double = 0,width:Int = 1280,height:Int = 720) async throws -> JSONValue {
        guard [(1280,720),(1920,1080)].contains(where:{$0.0 == width && $0.1 == height}),atMs.isFinite,atMs>=0,["png","jpg","jpeg"].contains(output.pathExtension.lowercased()) else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Thumbnail must be PNG/JPG, 1280x720 or 1920x1080, with a nonnegative timestamp") }
        let package=try package(id),manifest=try package.readManifest(); try protect(output,package:package,manifest:manifest)
        let edit=try await getEdit(id:id)
        guard atMs < edit.durationMs else { throw ControlFailure(code:ControlErrorCode.invalidParams,message:"Thumbnail time lies beyond the edit") }
        let preview=package.folderURL.appendingPathComponent("renders/thumbnail-source.mp4")
        _=try await export(id:id,to:preview)
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:preview)); generator.appliesPreferredTrackTransform=true
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter = CMTime(value:1,timescale:30)
        let source=try await generator.image(at:CMTime(seconds:atMs/1000,preferredTimescale:600_000)).image
        let context=CIContext(); let input=CIImage(cgImage:source),scale=min(CGFloat(width)/input.extent.width,CGFloat(height)/input.extent.height)
        let bounds=CGRect(x:0,y:0,width:width,height:height)
        let scaled=input.transformed(by:CGAffineTransform(scaleX:scale,y:scale)).transformed(by:CGAffineTransform(translationX:(CGFloat(width)-input.extent.width*scale)/2,y:(CGFloat(height)-input.extent.height*scale)/2))
        let image=scaled.composited(over:CIImage(color:.black).cropped(to:bounds))
        guard let cg=context.createCGImage(image,from:bounds) else { throw renderFailure("Cannot create thumbnail image") }
        let data=NSMutableData(),type=output.pathExtension.lowercased() == "png" ? UTType.png.identifier : UTType.jpeg.identifier
        guard let destination=CGImageDestinationCreateWithData(data,type as CFString,1,nil) else { throw renderFailure("Cannot create thumbnail encoder") }
        CGImageDestinationAddImage(destination,cg,[kCGImageDestinationLossyCompressionQuality:0.9] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw renderFailure("Thumbnail encoding failed") }
        try FileManager.default.createDirectory(at:output.deletingLastPathComponent(),withIntermediateDirectories:true)
        try AtomicFileWriter.write(data as Data,to:output)
        return .object(["id":.string(id),"path":.string(output.path),"width":.int(Int64(width)),"height":.int(Int64(height)),"atMs":.double(atMs)])
    }
}
