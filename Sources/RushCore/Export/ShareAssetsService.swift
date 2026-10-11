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
    public var editSnapshot:EditDocument
    public var videoSHA256:String
}

/// Local preparation only: providers reserve links and upload these immutable
/// edited-timeline artifacts through the desktop's approved sharing workflow.
public actor ShareAssetsService {
    public let root:URL
    private let postproduction:PostproductionService
    public init(root:URL = RecordingPackage.defaultRoot,postproduction:PostproductionService? = nil) {
        self.root=root; self.postproduction=postproduction ?? PostproductionService(root:root)
    }
    public func assets(id:String,editSnapshot:EditDocument? = nil,publishedVideoPath:String? = nil) async throws -> ShareAssetsResult {
        guard let package=RecordingPackage.resolve(root:root,id:id) else { throw ControlFailure(code:ControlErrorCode.notFound,message:"No recording with ID \(id)") }
        if (editSnapshot == nil) != (publishedVideoPath == nil) { throw shareAssetFailure("re-share-required","Re-share this legacy recording before enriching it; published edit and video identity are required together") }
        let currentEdit=try await postproduction.getEdit(id:id)
        let edit=editSnapshot ?? currentEdit
        let sourceTranscript:TranscriptDocument?
        let transcriptSource=try PostproductionPaths.file("transcript.json",in:package.folderURL,requireExists:false)
        if FileManager.default.fileExists(atPath:transcriptSource.path) { sourceTranscript=try TranscriptFiles.read(from:package.folderURL) }
        else { sourceTranscript=nil }
        let metadataSource=try PostproductionPaths.file("metadata.json",in:package.folderURL,requireExists:false)
        let metadata:RecordingMetadata?
        if FileManager.default.fileExists(atPath:metadataSource.path) { metadata=try MetadataService.read(from:package.folderURL) }
        else { metadata=nil }
        let userMetadata=metadata?.engine == "user"
        let newerEditChapters=editSnapshot != nil && currentEdit.meta.chapters != edit.meta.chapters && !currentEdit.meta.chapters.isEmpty
        let sourceChapters:[RecordingChapter]
        if userMetadata || (editSnapshot != nil && !newerEditChapters) { sourceChapters=metadata?.chapters ?? currentEdit.meta.chapters.map { .init(startMs:$0.startMs,title:$0.title) } }
        else { sourceChapters=currentEdit.meta.chapters.isEmpty ? metadata?.chapters ?? [] : currentEdit.meta.chapters.map { .init(startMs:$0.startMs,title:$0.title) } }
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
        let rendered:ExportResult
        var publishedPoster:URL?
        if let publishedVideoPath {
            let published=try validatePublished(publishedVideoPath,id:id,edit:edit,shared:shared)
            try copy(published.video,to:video)
            publishedPoster=published.poster
            rendered=ExportResult(id:id,path:video.path,preset:"share",cacheKey:published.stamp.cacheKey,cached:true,durationMs:published.stamp.durationMs,width:published.stamp.width,height:published.stamp.height,fps:30)
        } else { rendered=try await postproduction.export(id:id,to:video,editSnapshot:edit) }
        let latestTitle=currentEdit.meta.title
        let newerEditTitle=editSnapshot != nil && latestTitle != edit.meta.title
        let title=(userMetadata || (editSnapshot != nil && !newerEditTitle) || ["Untitled recording","Recording"].contains(latestTitle)) ? metadata?.title ?? latestTitle : latestTitle
        let newerEditSummary=editSnapshot != nil && currentEdit.meta.summary != edit.meta.summary && currentEdit.meta.summary != nil
        let summary=(userMetadata || (editSnapshot != nil && !newerEditSummary)) ? metadata?.summary ?? currentEdit.meta.summary : currentEdit.meta.summary ?? metadata?.summary
        let videoHash=try sha256(video)
        let transcriptData=try timeline.transcript.map { try TranscriptFiles.export($0,format:.json) }
        let captionsData=try timeline.transcript.map { try TranscriptFiles.export($0,format:.vtt) }
        let projectedMetadata=JSONValue.object(["title":.string(title),"summary":.string(summary),"chapters":try JSONValue(encoding:timeline.chapters),"durationMs":.double(rendered.durationMs),"editRevision":.int(Int64(edit.revision))])
        var hash=SHA256(); hash.update(data:Data("rushes.share-assets/2".utf8)); hash.update(data:Data(videoHash.utf8)); hash.update(data:try ControlWire.encoder.encode(projectedMetadata))
        if let transcriptData { hash.update(data:transcriptData) }
        let key=hash.finalize().map { String(format:"%02x",$0) }.joined()
        let expected=shared.appendingPathComponent(key,isDirectory:true)
        let result=ShareAssetsResult(id:id,videoPath:expected.appendingPathComponent("video.mp4").path,posterPath:expected.appendingPathComponent("poster.jpg").path,captionsPath:captionsData == nil ? nil : expected.appendingPathComponent("captions.vtt").path,transcriptPath:transcriptData == nil ? nil : expected.appendingPathComponent("transcript.json").path,durationMs:rendered.durationMs,width:rendered.width,height:rendered.height,title:title,summary:summary,chapters:timeline.chapters,cacheKey:key,cached:rendered.cached,editRevision:edit.revision,editSnapshot:edit,videoSHA256:videoHash)
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
        if let publishedPoster { try copy(publishedPoster,to:poster) }
        else { try await CompositionThumbnail.write(video:video,to:poster,atMs:0,width:1280,height:720) }
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
    private func validatePublished(_ path:String,id:String,edit:EditDocument,shared:URL) throws -> (video:URL,poster:URL,stamp:ShareAssetsResult) {
        guard path.hasPrefix("/"),URL(fileURLWithPath:path).lastPathComponent == "video.mp4" else { throw shareAssetFailure("re-share-required","Published video identity is missing or invalid") }
        let requested=URL(fileURLWithPath:path).standardizedFileURL
        let generation=requested.deletingLastPathComponent().lastPathComponent
        guard generation.count == 64,generation.allSatisfy({$0.isHexDigit && !$0.isUppercase}),requested.deletingLastPathComponent().deletingLastPathComponent().resolvingSymlinksInPath().path == shared.resolvingSymlinksInPath().path else { throw shareAssetFailure("re-share-required","Published video must belong to this recording's shared asset generation") }
        let folder=try PostproductionPaths.managedDirectory(generation,in:shared)
        let video=try PostproductionPaths.managedFile("video.mp4",in:folder)
        let poster=try PostproductionPaths.managedFile("poster.jpg",in:folder)
        let stampURL=try PostproductionPaths.managedFile("assets.json",in:folder)
        let stamp:ShareAssetsResult
        do { stamp=try JSONDecoder().decode(ShareAssetsResult.self,from:Data(contentsOf:stampURL)) }
        catch { throw shareAssetFailure("re-share-required","Published asset snapshot is unavailable; re-share the recording") }
        guard video.resolvingSymlinksInPath().path == requested.resolvingSymlinksInPath().path,stamp.id == id,stamp.cacheKey == generation,stamp.editSnapshot == edit,
              FileManager.default.fileExists(atPath:poster.path),try sha256(video) == stamp.videoSHA256 else { throw shareAssetFailure("re-share-required","Published assets no longer match the saved edit/video identity") }
        return (video,poster,stamp)
    }
    private func sha256(_ url:URL) throws -> String {
        let input=try FileHandle(forReadingFrom:url); defer { try? input.close() }
        var hash=SHA256()
        while let data=try input.read(upToCount:1_048_576),!data.isEmpty { hash.update(data:data) }
        return hash.finalize().map { String(format:"%02x",$0) }.joined()
    }
    private func copy(_ source:URL,to output:URL) throws { try FileManager.default.copyItem(at:source,to:output) }

}

private func shareAssetFailure(_ code:String,_ message:String) -> ControlFailure { ControlFailure(code:code,message:message) }
