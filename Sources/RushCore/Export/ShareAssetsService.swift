import CryptoKit
import Foundation

public struct ShareAssetsResult:Codable,Equatable,Sendable {
    public var id:String
    public var videoPath:String
    public var posterPath:String
    public var captionsPath:String?
    public var transcriptPath:String?
    public var durationMs:Double
    public var width:Int
    public var height:Int
    public var title:String
    public var summary:String?
    public var chapters:[RecordingChapter]
    public var cacheKey:String
    public var cached:Bool
    public var editRevision:Int
}

/// Local preparation only: providers reserve links and upload these immutable
/// edited-timeline artifacts through the desktop's approved sharing workflow.
public actor ShareAssetsService {
    public let root:URL
    private let postproduction:PostproductionService
    public init(root:URL = RecordingPackage.defaultRoot,postproduction:PostproductionService? = nil) {
        self.root=root; self.postproduction=postproduction ?? PostproductionService(root:root)
    }
    public func assets(id:String) async throws -> ShareAssetsResult {
        guard let package=RecordingPackage.resolve(root:root,id:id) else { throw ControlFailure(code:ControlErrorCode.notFound,message:"No recording with ID \(id)") }
        let edit=try await postproduction.getEdit(id:id)
        let sourceTranscript:TranscriptDocument?
        let transcriptSource=try PostproductionPaths.file("transcript.json",in:package.folderURL,requireExists:false)
        if FileManager.default.fileExists(atPath:transcriptSource.path) { sourceTranscript=try TranscriptFiles.read(from:package.folderURL) }
        else { sourceTranscript=nil }
        let metadataSource=try PostproductionPaths.file("metadata.json",in:package.folderURL,requireExists:false)
        let metadata:RecordingMetadata?
        if FileManager.default.fileExists(atPath:metadataSource.path) { metadata=try MetadataService.read(from:package.folderURL) }
        else { metadata=nil }
        let sourceChapters=edit.meta.chapters.isEmpty ? metadata?.chapters ?? [] : edit.meta.chapters.map { RecordingChapter(startMs:$0.startMs,title:$0.title) }
        let timeline=try ShareTimelineProjection.project(edit:edit,transcript:sourceTranscript,chapters:sourceChapters)
        let renders=try PostproductionPaths.managedDirectory("renders",in:package.folderURL,create:true)
        let shared=try PostproductionPaths.managedDirectory("shared_assets",in:renders,create:true)
        let stageName=".partial-\(UUID().uuidString)"
        let stage=try PostproductionPaths.managedDirectory(stageName,in:shared,create:true)
        defer {
            if (try? PostproductionPaths.managedDirectory("renders",in:package.folderURL)) != nil,
               (try? PostproductionPaths.managedDirectory("shared_assets",in:renders)) != nil,
               let own=try? PostproductionPaths.managedDirectory(stageName,in:shared) { try? FileManager.default.removeItem(at:own) }
        }
        let video=try PostproductionPaths.managedFile("video.mp4",in:stage)
        let rendered=try await postproduction.export(id:id,to:video,editSnapshot:edit)
        let title=edit.meta.title,summary=edit.meta.summary ?? metadata?.summary
        let transcriptData=try timeline.transcript.map { try TranscriptFiles.export($0,format:.json) }
        let captionsData=try timeline.transcript.map { try TranscriptFiles.export($0,format:.vtt) }
        let projectedMetadata=JSONValue.object(["title":.string(title),"summary":.string(summary),"chapters":try JSONValue(encoding:timeline.chapters),"durationMs":.double(rendered.durationMs),"editRevision":.int(Int64(edit.revision))])
        var hash=SHA256(); hash.update(data:Data("rushes.share-assets/1".utf8)); hash.update(data:Data(rendered.cacheKey.utf8)); hash.update(data:try ControlWire.encoder.encode(projectedMetadata))
        if let transcriptData { hash.update(data:transcriptData) }
        let key=hash.finalize().map { String(format:"%02x",$0) }.joined()
        let expected=shared.appendingPathComponent(key,isDirectory:true)
        let result=ShareAssetsResult(id:id,videoPath:expected.appendingPathComponent("video.mp4").path,posterPath:expected.appendingPathComponent("poster.jpg").path,captionsPath:captionsData == nil ? nil : expected.appendingPathComponent("captions.vtt").path,transcriptPath:transcriptData == nil ? nil : expected.appendingPathComponent("transcript.json").path,durationMs:rendered.durationMs,width:rendered.width,height:rendered.height,title:title,summary:summary,chapters:timeline.chapters,cacheKey:key,cached:rendered.cached,editRevision:edit.revision)
        if FileManager.default.fileExists(atPath:expected.path) {
            let existing=try PostproductionPaths.managedDirectory(key,in:shared)
            let stamp=try PostproductionPaths.managedFile("assets.json",in:existing)
            if let data=try? Data(contentsOf:stamp),let stored=try? JSONDecoder().decode(ShareAssetsResult.self,from:data),stored.id == id,stored.cacheKey == key {
                let names=["video.mp4","poster.jpg"]+(transcriptData == nil ? [] : ["transcript.json","captions.vtt"])
                for name in names {
                    let file=try PostproductionPaths.managedFile(name,in:existing)
                    guard FileManager.default.fileExists(atPath:file.path) else { throw renderFailure("Incomplete shared asset generation") }
                }
                var reused=result; reused.cached=true; return reused
            }
            throw renderFailure("Shared asset generation has no readable stamp")
        }
        let poster=try PostproductionPaths.managedFile("poster.jpg",in:stage)
        try await CompositionThumbnail.write(video:video,to:poster,atMs:0,width:1280,height:720)
        if let transcriptData { try AtomicFileWriter.write(transcriptData,to:PostproductionPaths.managedFile("transcript.json",in:stage)) }
        if let captionsData { try AtomicFileWriter.write(captionsData,to:PostproductionPaths.managedFile("captions.vtt",in:stage)) }

        try AtomicFileWriter.writeEncodable(result,to:PostproductionPaths.managedFile("assets.json",in:stage),encoder:ControlWire.encoder)
        _=try PostproductionPaths.managedDirectory("renders",in:package.folderURL)
        _=try PostproductionPaths.managedDirectory("shared_assets",in:renders)
        _=try PostproductionPaths.managedDirectory(stageName,in:shared)
        try Task.checkCancellation()
        try AtomicFileWriter.posixRename(from:stage,to:expected)
        return result
    }
}
