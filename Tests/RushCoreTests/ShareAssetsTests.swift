@preconcurrency import AVFoundation
import CryptoKit
import Foundation
import ImageIO
import Testing
@testable import RushCore

@Suite("Edited share assets",.serialized)
struct ShareAssetsTests {
    private func transcript() throws -> TranscriptDocument {
        try TranscriptDocument(locale:"en-US",inputFile:"mic.mov",durationMs:2000,words:[
            .init(id:"cut",text:"Deleted",startMs:100,endMs:200),
            .init(id:"edge",text:"Boundary",startMs:350,endMs:450),
            .init(id:"fast",text:"Faster",startMs:500,endMs:700),
            .init(id:"middle",text:"Removed",startMs:900,endMs:1000),
            .init(id:"later",text:"Later",startMs:1300,endMs:1500)
        ])
    }
    private func edited() -> EditDocument {
        var edit=EditDocument(durationMs:2000)
        edit.layout.preset = .screenOnly
        edit.clips=[EditClip(id:"late",sourceStartMs:1200,sourceEndMs:1800),EditClip(id:"early",sourceStartMs:400,sourceEndMs:800,speed:2)]
        return edit
    }
    @Test func wordsAndSectionsProjectThroughTrimSpeedAndReorder() throws {
        let source=try transcript(),edit=edited()
        let projection=try ShareTimelineProjection.project(edit:edit,transcript:source,chapters:[.init(startMs:0,title:"Intro"),.init(startMs:800,title:"Cut only"),.init(startMs:1000,title:"Later section")])
        let projected=try #require(projection.transcript)
        #expect(projected.durationMs == 800)
        #expect(projected.words.map(\.text) == ["Later","Boundary","Faster"])
        #expect(projected.words.map(\.startMs) == [100,600,650])
        #expect(projected.words.map(\.endMs) == [300,625,750])
        #expect(projection.chapters == [.init(startMs:0,title:"Later section"),.init(startMs:600,title:"Intro")])
        #expect(projected.cues.allSatisfy { $0.startMs>=0 && $0.endMs<=800 })
        #expect(!projected.text.contains("Deleted") && !projected.text.contains("Removed"))
        #expect(source.words.map(\.id) == ["cut","edge","fast","middle","later"])
        var repeated=edit
        repeated.clips.append(EditClip(id:"replay",sourceStartMs:1200,sourceEndMs:1800))
        let replay=try #require(ShareTimelineProjection.project(edit:repeated,transcript:source,chapters:[]).transcript)
        #expect(replay.words.filter{$0.text == "Later"}.count == 2)
        #expect(Set(replay.words.map(\.id)).count == replay.words.count)
        #expect(replay.words.last?.startMs == 900)
    }
    @Test func generatedAssetsDecodeAndKeepRawMastersAndTranscriptUnchanged() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        try TranscriptFiles.write(transcript(),to:fixture.package.folderURL)
        try MetadataService.write(.init(title:"Source title",summary:"Source summary",chapters:[.init(startMs:0,title:"Intro"),.init(startMs:800,title:"Cut only"),.init(startMs:1000,title:"Later section")]),to:fixture.package.folderURL)
        let rawHashes=try fixture.hashes(),sourceData=try Data(contentsOf:fixture.package.transcriptURL)
        let postproduction=PostproductionService(root:fixture.root)
        _=try await postproduction.setEdit(id:fixture.package.id,edit:edited())
        let service=ShareAssetsService(root:fixture.root,postproduction:postproduction)
        let result=try await service.assets(id:fixture.package.id)
        let prefix=fixture.package.folderURL.appendingPathComponent("renders/shared_assets").resolvingSymlinksInPath().path+"/"
        let canonicalPaths=[result.videoPath,result.posterPath,try #require(result.captionsPath),try #require(result.transcriptPath)].map { URL(fileURLWithPath:$0).resolvingSymlinksInPath().path }
        #expect(canonicalPaths.allSatisfy{$0.hasPrefix(prefix)})
        #expect(result.durationMs == 800 && result.width == 320 && result.height == 180)
        let asset=AVURLAsset(url:URL(fileURLWithPath:result.videoPath))
        #expect(abs(try await asset.load(.duration).seconds-0.8)<0.035)
        #expect(try await SyntheticExportFixture.audioRMS(URL(fileURLWithPath:result.videoPath))>0.10)
        let first=try await SyntheticExportFixture.pixels(URL(fileURLWithPath:result.videoPath),at:0.1),second=try await SyntheticExportFixture.pixels(URL(fileURLWithPath:result.videoPath),at:0.7)
        let center=(90*320+160)*4
        #expect(first.data[center+1]>170 && second.data[center+2]>170)
        let imageSource=try #require(CGImageSourceCreateWithURL(URL(fileURLWithPath:result.posterPath) as CFURL,nil))
        let image=try #require(CGImageSourceCreateImageAtIndex(imageSource,0,nil))
        #expect(image.width == 1280 && image.height == 720)
        let projected=try JSONDecoder().decode(TranscriptDocument.self,from:Data(contentsOf:URL(fileURLWithPath:try #require(result.transcriptPath))))
        #expect(projected.words.map(\.text) == ["Later","Boundary","Faster"])
        #expect(projected.words[0].startMs == 100 && projected.words[1].startMs == 600)
        let vtt=try String(contentsOf:URL(fileURLWithPath:try #require(result.captionsPath)),encoding:.utf8)
        #expect(vtt.contains("00:00:00.100 --> 00:00:00.300") && !vtt.contains("Removed"))
        #expect(result.chapters.map(\.startMs) == [0,600])
        let again=try await service.assets(id:fixture.package.id)
        #expect(again.cached && again.cacheKey == result.cacheKey && again.videoPath == result.videoPath)
        #expect(try fixture.hashes() == rawHashes)
        #expect(try Data(contentsOf:fixture.package.transcriptURL) == sourceData)
    }
    @Test func newEditInheritsRecordedBubbleAndExistingDraftWins() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        var manifest=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:fixture.package.manifestURL))
        var fields=try #require(manifest.object)
        fields["bubble"] = .object(["center":.array([.double(0.4),.double(0.35)]),"visible":.bool(true),"size":.int(200),"sizeFraction":.double(0.125)])
        manifest = .object(fields)
        try AtomicFileWriter.writeEncodable(manifest,to:fixture.package.manifestURL,encoder:ControlWire.encoder)
        let service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        #expect(edit.layout.bubble.center == [0.4,0.35] && edit.layout.bubble.visible)
        #expect(abs(edit.layout.bubble.size-0.125)<0.001)
        let frames=try await service.layoutFrames(id:fixture.package.id,canvasAspect:16/9)
        #expect(abs(try #require(frames["camera"]?["width"]?.double)-0.125)<0.001)
        #expect(abs(try #require(frames["camera"]?["x"]?.double)+0.0625-0.4)<0.001)
        let output=fixture.root.appendingPathComponent("bubble.mp4")
        _=try await service.export(id:fixture.package.id,to:output)
        let pixels=try await SyntheticExportFixture.pixels(output,at:0.2)
        var xs:[Int]=[]
        for y in 0..<pixels.height { for x in 0..<pixels.width {
            let i=(y*pixels.width+x)*4
            if pixels.data[i]>160 && pixels.data[i+1]<60 && pixels.data[i+2]<60 { xs.append(x) }
        } }
        #expect(abs(Double(try #require(xs.max()))-Double(try #require(xs.min()))+1-40)<3)
        #expect(abs(Double(try #require(xs.max())+xs.min()!)/2-128)<2)
        edit.layout.bubble.center=[0.75,0.5]; edit.layout.bubble.size=0.25
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let fresh=PostproductionService(root:fixture.root)
        #expect(try await fresh.getEdit(id:fixture.package.id).layout.bubble.center == [0.75,0.5])
        #expect(try await fresh.getEdit(id:fixture.package.id).layout.bubble.size == 0.25)
    }
    @Test func lateTranscriptEnrichmentAndManagedDirectoryContainment() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let postproduction=PostproductionService(root:fixture.root)
        _=try await postproduction.setEdit(id:fixture.package.id,edit:edited())
        let service=ShareAssetsService(root:fixture.root,postproduction:postproduction)
        let initial=try await service.assets(id:fixture.package.id)
        #expect(initial.transcriptPath == nil && initial.captionsPath == nil)
        try TranscriptFiles.write(transcript(),to:fixture.package.folderURL)
        let enriched=try await service.assets(id:fixture.package.id)
        #expect(enriched.cacheKey != initial.cacheKey && enriched.transcriptPath != nil)
        #expect(try Data(contentsOf:URL(fileURLWithPath:initial.videoPath)) == Data(contentsOf:URL(fileURLWithPath:enriched.videoPath)))
        let outside=fixture.root.appendingPathComponent("outside",isDirectory:true)
        try FileManager.default.createDirectory(at:outside,withIntermediateDirectories:false)
        let shared=fixture.package.rendersDirectory.appendingPathComponent("shared_assets")
        try FileManager.default.removeItem(at:shared)
        try FileManager.default.createSymbolicLink(at:shared,withDestinationURL:outside)
        await #expect(throws:ControlFailure.self) { try await service.assets(id:fixture.package.id) }
        #expect(try FileManager.default.contentsOfDirectory(atPath:outside.path).isEmpty)
    }
    // Two encoders at once never finish on GitHub-hosted macOS
    // (AppleM2ScalerParavirtDriver is missing). One preparation at a time
    // does. The test still runs outside CI.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CI"] != "true"))
    func concurrentEditedPreparationsDecodeBothAudioTracks() async throws {
        let first=try await SyntheticExportFixture(),second=try await SyntheticExportFixture()
        defer { first.cleanup(); second.cleanup() }
        let one=PostproductionService(root:first.root),two=PostproductionService(root:second.root)
        _=try await one.setEdit(id:first.package.id,edit:edited())
        _=try await two.setEdit(id:second.package.id,edit:edited())
        async let resultOne=ShareAssetsService(root:first.root,postproduction:one).assets(id:first.package.id)
        async let resultTwo=ShareAssetsService(root:second.root,postproduction:two).assets(id:second.package.id)
        let outputs=try await [resultOne,resultTwo]
        for output in outputs {
            #expect(output.durationMs == 800)
            #expect(try await SyntheticExportFixture.audioRMS(URL(fileURLWithPath:output.videoPath))>0.10)
        }
    }

    @Test func lateMetadataUsesPublishedEditAndExactVideoAfterDraftChanges() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let production=PostproductionService(root:fixture.root)
        _=try await production.setEdit(id:fixture.package.id,edit:edited())
        let service=ShareAssetsService(root:fixture.root,postproduction:production)
        let published=try await service.assets(id:fixture.package.id)
        let originalVideo=try Data(contentsOf:URL(fileURLWithPath:published.videoPath)),originalPoster=try Data(contentsOf:URL(fileURLWithPath:published.posterPath))
        var current=EditDocument(durationMs:2000,title:"Current different draft")
        current.layout.preset = .cameraOnly; current.clips=[EditClip(id:"new",sourceStartMs:0,sourceEndMs:1500)]
        _=try await production.setEdit(id:fixture.package.id,edit:current)
        try TranscriptFiles.write(transcript(),to:fixture.package.folderURL)
        try MetadataService.write(.init(title:"Explicit user title",summary:"Explicit user summary",chapters:[.init(startMs:0,title:"Intro"),.init(startMs:1000,title:"Later section")],engine:"user"),to:fixture.package.folderURL)
        let enriched=try await service.assets(id:fixture.package.id,editSnapshot:published.editSnapshot,publishedVideoPath:published.videoPath)
        #expect(enriched.editSnapshot == published.editSnapshot && enriched.durationMs == 800)
        #expect(enriched.title == "Explicit user title" && enriched.summary == "Explicit user summary")
        #expect(try Data(contentsOf:URL(fileURLWithPath:enriched.videoPath)) == originalVideo)
        #expect(try Data(contentsOf:URL(fileURLWithPath:enriched.posterPath)) == originalPoster)
        let captions=try JSONDecoder().decode(TranscriptDocument.self,from:Data(contentsOf:URL(fileURLWithPath:try #require(enriched.transcriptPath))))
        #expect(captions.words.map(\.text) == ["Later","Boundary","Faster"] && captions.durationMs == 800)
        await #expect(throws:ControlFailure.self) { try await service.assets(id:fixture.package.id,editSnapshot:published.editSnapshot) }
        let outside=fixture.root.appendingPathComponent("foreign.mp4")
        try AtomicFileWriter.write(originalVideo,to:outside)
        await #expect(throws:ControlFailure.self) { try await service.assets(id:fixture.package.id,editSnapshot:published.editSnapshot,publishedVideoPath:outside.path) }
        let other=try await SyntheticExportFixture(); defer { other.cleanup() }
        let otherAsset=try await ShareAssetsService(root:other.root).assets(id:other.package.id)
        await #expect(throws:ControlFailure.self) { try await service.assets(id:fixture.package.id,editSnapshot:published.editSnapshot,publishedVideoPath:otherAsset.videoPath) }
    }

}
