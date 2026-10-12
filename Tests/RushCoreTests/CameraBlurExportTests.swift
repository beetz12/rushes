@preconcurrency import AVFoundation
import CoreImage
import Foundation
import ImageIO
import Testing
@testable import RushCore

private final class FailingCameraProcessor:CameraBlurFrameProcessing,@unchecked Sendable {
    func process(_ buffer:CVPixelBuffer,at time:CMTime) async throws -> CameraBlurFrame {
        throw ControlFailure(code:"fixture-blur-failed",message:"Synthetic processor failure")
    }
    func cancel() {}
}

@Suite("Strict composed camera blur",.serialized)
struct CameraBlurExportTests {
    private func patternedCamera(to target:URL,rotate:Bool = false) async throws {
        try FileManager.default.removeItem(at:target)
        let width=160,height=rotate ? 120 : 160
        let writer=try AVAssetWriter(outputURL:target,fileType:.mov)
        let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:width,AVVideoHeightKey:height])
        input.expectsMediaDataInRealTime = true
        if rotate { input.transform=CGAffineTransform(a:0,b:1,c:-1,d:0,tx:CGFloat(height),ty:0) }
        writer.add(input)
        let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:nil)
        guard writer.startWriting() else { throw renderFailure("Pattern fixture writer") }; writer.startSession(atSourceTime:.zero)
        for frame in 0..<60 {
            try await waitUntilReadyForMedia(input, writer: writer)
            var buffer:CVPixelBuffer?
            let status=CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,[kCVPixelBufferIOSurfacePropertiesKey:[:]] as CFDictionary,&buffer)
            guard status == kCVReturnSuccess,let buffer else { throw renderFailure("Pattern fixture pixel allocation status\(status)") }
            CVPixelBufferLockBaseAddress(buffer,[])
            let memory=CVPixelBufferGetBaseAddress(buffer)!,stride=CVPixelBufferGetBytesPerRow(buffer)
            for y in 0..<height {
                let row=memory.advanced(by:y*stride).assumingMemoryBound(to:UInt32.self)
                for x in 0..<width {
                    let gray:UInt32=(x/4+y/4+frame/30)%2 == 0 ? 0 : 255
                    row[x]=0xFF000000 | gray<<16 | gray<<8 | gray
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer,[])
            guard adaptor.append(buffer,withPresentationTime:CMTime(value:Int64(frame),timescale:30)) else { throw renderFailure("Pattern fixture append") }
        }
        input.markAsFinished(); writer.endSession(atSourceTime:CMTime(seconds:2,preferredTimescale:600))
        try await finishWriting(writer, within: 20)
    }
    private func detail(_ pixels:(Int,Int,[UInt8])) -> Double {
        let (width,height,bytes)=pixels
        var total=0.0,count=0
        for y in (height/4)..<(height*3/4) {
            for x in (width/4)..<(width*3/4-1) {
                let position=(y*width+x)*4
                total += abs(Double(bytes[position])-Double(bytes[position+4])); count += 1
            }
        }
        return total/Double(count)
    }
    private func stillPixels(_ path:URL) throws -> (Int,Int,[UInt8]) {
        let source=try #require(CGImageSourceCreateWithURL(path as CFURL,nil))
        let image=try #require(CGImageSourceCreateImageAtIndex(source,0,nil))
        var bytes=[UInt8](repeating:0,count:image.width*image.height*4)
        let rendered=bytes.withUnsafeMutableBytes { memory in
            guard let context=CGContext(data:memory.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height)); return true
        }
        #expect(rendered); return (image.width,image.height,bytes)
    }
    @Test func realBlurredVideoThumbnailAndSharePreserveRawMasters() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        try await patternedCamera(to:fixture.package.trackURL(for:.camera))
        var manifest=try fixture.package.readManifest()
        let camera=try #require(manifest.tracks.firstIndex(where:{$0.kind == .camera}))
        manifest.tracks[camera].offsetNs=0; manifest.tracks[camera].offsetMs=0
        try fixture.package.writeManifest(manifest)
        let masters=try fixture.hashes(),service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.layout.preset = .cameraOnly; edit.clips=[EditClip(sourceStartMs:0,sourceEndMs:400)]
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let raw=fixture.root.appendingPathComponent("raw-composition.mp4")
        let first=try await service.export(id:fixture.package.id,to:raw)
        let rawPixels=try await SyntheticExportFixture.pixels(raw,at:0.2)
        let rawThumb=fixture.root.appendingPathComponent("raw-thumbnail.png")
        _=try await service.thumbnail(id:fixture.package.id,to:rawThumb,atMs:200)
        let rawThumbPixels=try stillPixels(rawThumb)
        try ProductionEffectsPolicy(cameraBlur:.init(enabled:true,radius:18)).write(to:fixture.package.folderURL)
        let processed=fixture.root.appendingPathComponent("protected-composition.mp4")
        let second=try await service.export(id:fixture.package.id,to:processed)
        let protectedPixels=try await SyntheticExportFixture.pixels(processed,at:0.2)
        #expect(!second.cached && second.cacheKey != first.cacheKey)
        #expect(detail(rawPixels)>20 && detail(protectedPixels)<detail(rawPixels)/4)
        let reused=try await service.export(id:fixture.package.id,to:fixture.root.appendingPathComponent("protected-reused.mp4"))
        #expect(reused.cached && reused.cacheKey == second.cacheKey)
        let source=try #require(try await CameraBlurDerivedSource.shared.prepare(package:fixture.package,manifest:fixture.package.readManifest(),policy:ProductionEffectsPolicy.read(from:fixture.package.folderURL)))
        #expect(source.result.frames == 60 && source.result.width == 160 && source.result.height == 160)
        #expect(source.result.sha256 == (try CameraBlurDerivedSource.hash(source.url)))
        let thumb=fixture.root.appendingPathComponent("protected-thumbnail.png")
        _=try await service.thumbnail(id:fixture.package.id,to:thumb,atMs:200)
        let decoded=try #require(CGImageSourceCreateWithURL(thumb as CFURL,nil))
        #expect(CGImageSourceCreateImageAtIndex(decoded,0,nil)?.width == 1280)
        #expect(detail(try stillPixels(thumb))<detail(rawThumbPixels)/4)
        let sharing=ShareAssetsService(root:fixture.root,postproduction:service)
        let shared=try await sharing.assets(id:fixture.package.id)
        #expect(shared.videoSHA256 == (try CameraBlurDerivedSource.hash(URL(fileURLWithPath:shared.videoPath))))
        #expect(detail(try await SyntheticExportFixture.pixels(URL(fileURLWithPath:shared.videoPath),at:0.2))<detail(rawPixels)/4)
        #expect(detail(try stillPixels(URL(fileURLWithPath:shared.posterPath)))<detail(rawThumbPixels)/4)
        try ProductionEffectsPolicy(cameraBlur:.init(enabled:false,radius:18)).write(to:fixture.package.folderURL)
        let enriched=try await sharing.assets(id:fixture.package.id,editSnapshot:shared.editSnapshot,publishedVideoPath:shared.videoPath)
        #expect(enriched.videoSHA256 == shared.videoSHA256)
        #expect(try CameraBlurDerivedSource.hash(URL(fileURLWithPath:enriched.posterPath)) == CameraBlurDerivedSource.hash(URL(fileURLWithPath:shared.posterPath)))
        #expect(try fixture.hashes() == masters)
    }
    @Test func policyOrientationAndFailureAreStrict() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        try await patternedCamera(to:fixture.package.trackURL(for:.camera),rotate:true)
        let masters=try fixture.hashes(),policy=ProductionEffectsPolicy(cameraBlur:.init(enabled:true,radius:12))
        let generator=CameraBlurDerivedSource()
        let derived=try #require(try await generator.prepare(package:fixture.package,manifest:fixture.package.readManifest(),policy:policy))
        #expect(derived.result.width == 120 && derived.result.height == 160 && derived.result.frames == 60)
        let video=AVURLAsset(url:derived.url)
        #expect(try await video.load(.duration).seconds == 2)
        let media=try #require(try await video.loadTracks(withMediaType:.video).first)
        #expect(try await media.load(.preferredTransform) == .identity)
        let reader=try AVAssetReader(asset:video),decoded=AVAssetReaderTrackOutput(track:media,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
        reader.add(decoded); #expect(reader.startReading())
        var decodedFrames=0
        while decoded.copyNextSampleBuffer() != nil { decodedFrames += 1 }
        #expect(reader.status == .completed && decodedFrames == 60)
        var changed=policy; changed.cameraBlur.radius=6
        let failed=CameraBlurDerivedSource(factory:{_ in FailingCameraProcessor()})
        await #expect(throws:ControlFailure.self) { try await failed.prepare(package:fixture.package,manifest:fixture.package.readManifest(),policy:changed) }
        #expect(try fixture.hashes() == masters)
        let folder=fixture.package.folderURL.appendingPathComponent("renders/camera_blur")
        #expect(try FileManager.default.contentsOfDirectory(atPath:folder.path).allSatisfy{!$0.hasPrefix(".partial-")})
        let bad=fixture.package.folderURL.appendingPathComponent("production-effects.json")
        try AtomicFileWriter.write(Data("{\"schema\":\"rushes.production-effects/1\",\"cameraBlur\":{\"enabled\":true,\"radius\":999}}".utf8),to:bad)
        let output=fixture.root.appendingPathComponent("must-not-fall-back.mp4")
        let service=PostproductionService(root:fixture.root)
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,to:output) }
        #expect(!FileManager.default.fileExists(atPath:output.path))
        let originals=fixture.root.appendingPathComponent("raw-editor-handoff",isDirectory:true)
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.editorTracks),to:originals)
        #expect(try CameraBlurDerivedSource.hash(originals.appendingPathComponent("camera.mov")) == CameraBlurDerivedSource.hash(fixture.package.trackURL(for:.camera)))
        let audio=fixture.root.appendingPathComponent("camera-independent.m4a")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.audio),to:audio)
        #expect(try await SyntheticExportFixture.audioRMS(audio)>0.01)
    }
    @Test func derivedDirectoryEscapeCannotWriteOutsidePackage() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let renders=try PostproductionPaths.managedDirectory("renders",in:fixture.package.folderURL,create:true)
        let outside=fixture.root.appendingPathComponent("outside-effect",isDirectory:true)
        try FileManager.default.createDirectory(at:outside,withIntermediateDirectories:false)
        try FileManager.default.createSymbolicLink(at:renders.appendingPathComponent("camera_blur"),withDestinationURL:outside)
        let policy=ProductionEffectsPolicy(cameraBlur:.init(enabled:true,radius:18))
        await #expect(throws:ControlFailure.self) { try await CameraBlurDerivedSource.shared.prepare(package:fixture.package,manifest:fixture.package.readManifest(),policy:policy) }
        #expect(try FileManager.default.contentsOfDirectory(atPath:outside.path).isEmpty)
    }
}
