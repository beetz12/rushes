@preconcurrency import AVFoundation
import CoreImage
import CryptoKit
import Foundation
import ImageIO
import Testing
@testable import RushCore

/// These fixtures are generated media; they are not live camera or screen capture.
struct SyntheticExportFixture {
    let root:URL
    let package:RecordingPackage
    init() async throws {
        root=FileManager.default.temporaryDirectory.appendingPathComponent("rushes-export-\(UUID().uuidString)",isDirectory:true)
        package=try RecordingPackage.create(root:root)
        try await Self.video(to:package.trackURL(for:.screen),camera:false)
        try await Self.video(to:package.trackURL(for:.camera),camera:true)
        try await Self.audio(to:package.trackURL(for:.microphone),frequency:440)
        try await Self.audio(to:package.trackURL(for:.systemAudio),frequency:660)
        try package.writeManifest(RecordingManifest(id:package.id,title:"Synthetic take",status:.complete,clock:.init(epochHostNs:0,durationNs:2_000_000_000,pausesNs:[]),tracks:[
            .init(kind:.screen,codec:"h264",width:320,height:180,fps:30),
            .init(kind:.camera,codec:"h264",width:160,height:160,fps:30,offsetNs:100_000_000),
            .init(kind:.microphone,codec:"aac",sampleRate:48_000,channels:1,latencyMs:120),
            .init(kind:.systemAudio,codec:"aac",sampleRate:48_000,channels:1)
        ]))
    }
    func cleanup() { try? FileManager.default.removeItem(at:root) }
    static func video(to url:URL,camera:Bool,allGreen:Bool = false,frameCount:Int = 60,spatialHalves:Bool = false) async throws {
        let width=camera ? 160 : 320,height=camera ? 160 : 180
        let writer=try AVAssetWriter(outputURL:url,fileType:.mov)
        let input=AVAssetWriterInput(mediaType:.video,outputSettings:fixtureH264Settings(width:width,height:height))
        input.expectsMediaDataInRealTime = true
        let adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:width,kCVPixelBufferHeightKey as String:height])
        writer.add(input); guard writer.startWriting() else { throw renderFailure("Fixture writer failed") }; writer.startSession(atSourceTime:.zero)
        for frame in 0..<frameCount {
            try await waitUntilReadyForMedia(input, writer: writer)
            var pixel:CVPixelBuffer?
            // Fixtures need valid source pixels, independent of the encoder's
            // asynchronously created/managed adaptor pool.
            let allocation = CVPixelBufferCreate(kCFAllocatorDefault,width,height,kCVPixelFormatType_32BGRA,
                [kCVPixelBufferIOSurfacePropertiesKey:[:],kCVPixelBufferMetalCompatibilityKey:true] as CFDictionary,&pixel)
            guard allocation == kCVReturnSuccess,let pixel else {
                throw renderFailure("Fixture pixel allocation CVReturn=\(allocation), writerStatus=\(writer.status.rawValue)")
            }
            CVPixelBufferLockBaseAddress(pixel,[])
            let memory=CVPixelBufferGetBaseAddress(pixel)!,rowBytes=CVPixelBufferGetBytesPerRow(pixel)
            let pixelWord:UInt32 = camera ? 0xFFDC0000 : frame>=30 || allGreen ? 0xFF00DC00 : 0xFF0000DC
            for row in 0..<height {
                let pixels=memory.advanced(by:row*rowBytes).assumingMemoryBound(to:UInt32.self)
                if spatialHalves {
                    pixels.initialize(repeating:0xFF0000DC,count:width/2)
                    pixels.advanced(by:width/2).initialize(repeating:0xFF00DC00,count:width-width/2)
                } else { pixels.initialize(repeating:pixelWord,count:width) }
            }
            CVPixelBufferUnlockBaseAddress(pixel,[])
            guard adaptor.append(pixel,withPresentationTime:CMTime(value:Int64(frame),timescale:30)) else { throw renderFailure("Fixture append") }
        }
        input.markAsFinished(); writer.endSession(atSourceTime:CMTime(value:Int64(frameCount),timescale:30))
        try await finishWriting(writer, within: 90)
    }
    static func audio(to url:URL,frequency:Float,onsetMs:Double = 0) async throws {
        let writer=try AVAssetWriter(outputURL:url,fileType:.mov)
        let input=AVAssetWriterInput(mediaType:.audio,outputSettings:[AVFormatIDKey:kAudioFormatMPEG4AAC,AVSampleRateKey:48_000,AVNumberOfChannelsKey:1,AVEncoderBitRateKey:128_000])
        input.expectsMediaDataInRealTime = true
        writer.add(input); guard writer.startWriting() else { throw renderFailure("Audio fixture writer") }; writer.startSession(atSourceTime:.zero)
        for frame in stride(from:0,to:96_000,by:1024) {
            try await waitUntilReadyForMedia(input, writer: writer)
            let count=min(1024,96_000-frame)
            let sample=try audioSample(frame:frame,count:count,frequency:frequency,onsetFrame:Int(onsetMs*48))
            guard input.append(sample) else { throw renderFailure(writer.error?.localizedDescription ?? "Audio fixture append") }
        }
        input.markAsFinished(); writer.endSession(atSourceTime:CMTime(seconds:2,preferredTimescale:600))
        try await finishWriting(writer, within: 90)
    }
    static func audioSample(frame:Int,count:Int,frequency:Float,onsetFrame:Int = 0) throws -> CMSampleBuffer {
        var asbd=AudioStreamBasicDescription(mSampleRate:48_000,mFormatID:kAudioFormatLinearPCM,mFormatFlags:kAudioFormatFlagIsFloat|kAudioFormatFlagIsPacked,mBytesPerPacket:4,mFramesPerPacket:1,mBytesPerFrame:4,mChannelsPerFrame:1,mBitsPerChannel:32,mReserved:0)
        var format:CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator:kCFAllocatorDefault,asbd:&asbd,layoutSize:0,layout:nil,magicCookieSize:0,magicCookie:nil,extensions:nil,formatDescriptionOut:&format) == noErr,let format else { throw renderFailure("Fixture PCM format") }
        var block:CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator:kCFAllocatorDefault,memoryBlock:nil,blockLength:count*4,blockAllocator:kCFAllocatorDefault,customBlockSource:nil,offsetToData:0,dataLength:count*4,flags:0,blockBufferOut:&block) == noErr,let block else { throw renderFailure("Fixture PCM allocation") }
        let values=(0..<count).map { i in frame+i < onsetFrame ? Float(0) : Float(0.3)*sin(2*Float.pi*frequency*Float(frame+i)/48_000) }
        _=values.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with:$0.baseAddress!,blockBuffer:block,offsetIntoDestination:0,dataLength:count*4) }
        var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:48_000),presentationTimeStamp:CMTime(value:Int64(frame),timescale:48_000),decodeTimeStamp:.invalid)
        var sample:CMSampleBuffer?
        guard CMSampleBufferCreate(allocator:kCFAllocatorDefault,dataBuffer:block,dataReady:true,makeDataReadyCallback:nil,refcon:nil,formatDescription:format,sampleCount:count,sampleTimingEntryCount:1,sampleTimingArray:&timing,sampleSizeEntryCount:0,sampleSizeArray:nil,sampleBufferOut:&sample) == noErr,let sample else { throw renderFailure("Fixture PCM sample") }
        return sample
    }
    func hashes() throws -> [String:String] {
        try Dictionary(uniqueKeysWithValues:[TrackKind.screen,.camera,.microphone,.systemAudio].map { ($0.rawValue,SHA256.hash(data:try Data(contentsOf:package.trackURL(for:$0))).description) })
    }
    static func pixels(_ url:URL,at:Double) async throws -> (width:Int,height:Int,data:[UInt8]) {
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:url)); generator.appliesPreferredTrackTransform=true
        generator.requestedTimeToleranceBefore = .zero; generator.requestedTimeToleranceAfter=CMTime(value:1,timescale:30)
        let image=try await generator.image(at:CMTime(seconds:at,preferredTimescale:600)).image
        var bytes=[UInt8](repeating:0,count:image.width*image.height*4)
        let ok=bytes.withUnsafeMutableBytes { memory -> Bool in
            guard let context=CGContext(data:memory.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,bytesPerRow:image.width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height)); return true
        }
        guard ok else { throw renderFailure("Fixture decode pixel context") }
        return (image.width,image.height,bytes)
    }
    static func audioWindowRMS(_ url:URL,start:Double,end:Double) async throws -> Double {
        let asset=AVURLAsset(url:url),track=try await asset.loadTracks(withMediaType:.audio)[0]
        let reader=try AVAssetReader(asset:asset)
        let output=AVAssetReaderTrackOutput(track:track,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:48_000,AVNumberOfChannelsKey:2,AVLinearPCMBitDepthKey:32,AVLinearPCMIsFloatKey:true,AVLinearPCMIsNonInterleaved:false])
        reader.add(output); guard reader.startReading() else { throw renderFailure("Window reader failed") }
        var sum=0.0,count=0
        while let sample=output.copyNextSampleBuffer(),let block=sample.dataBuffer {
            let length=CMBlockBufferGetDataLength(block)
            var values=[Float](repeating:0,count:length/4)
            _=values.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:$0.baseAddress!) }
            for (index,value) in values.enumerated() {
                let time=sample.presentationTimeStamp.seconds+Double(index/2)/48_000
                if time>=start && time<end { sum += Double(value*value); count += 1 }
            }
        }
        guard reader.status == .completed,count>0 else { throw renderFailure("Window decode failed") }
        return sqrt(sum/Double(count))
    }
    static func audioRMS(_ url:URL) async throws -> Double {
        let asset=AVURLAsset(url:url),tracks=try await asset.loadTracks(withMediaType:.audio)
        guard let track=tracks.first else { throw renderFailure("Export has no audio") }
        let reader=try AVAssetReader(asset:asset)
        let output=AVAssetReaderTrackOutput(track:track,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVLinearPCMBitDepthKey:32,AVLinearPCMIsFloatKey:true,AVLinearPCMIsNonInterleaved:false])
        reader.add(output); guard reader.startReading() else { throw renderFailure("RMS reader did not start") }
        var sum=0.0,count=0
        while let sample=output.copyNextSampleBuffer(),let block=sample.dataBuffer {
            let length=CMBlockBufferGetDataLength(block),floats=length/4
            var data=[Float](repeating:0,count:floats)
            _=data.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block,atOffset:0,dataLength:length,destination:$0.baseAddress!) }
            for value in data { sum += Double(value*value); count += 1 }
        }
        guard reader.status == .completed,count>0 else { throw renderFailure("RMS audio decoding failed") }
        return sqrt(sum/Double(count))
    }
}

@Suite("Native exports",.serialized)
struct ExportTests {
    @Test func h264FastStartCutsSpeedCameraAndCache() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let hashes=try fixture.hashes(),service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.clips=[EditClip(id:"first",sourceStartMs:500,sourceEndMs:1000),EditClip(id:"second",sourceStartMs:1500,sourceEndMs:2000,speed:2)]
        edit.layout.bubble.center=[0.75,0.5]; edit.layout.bubble.size=0.25
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let output=fixture.root.appendingPathComponent("edited.mp4")
        let result=try await service.export(id:fixture.package.id,to:output)
        #expect(result.width == 320 && result.height == 180 && result.fps == 30)
        #expect(!result.cached)
        let asset=AVURLAsset(url:output),duration=try await asset.load(.duration).seconds
        #expect(abs(duration-0.75)<0.035)
        let first=try await SyntheticExportFixture.pixels(output,at:0.1),second=try await SyntheticExportFixture.pixels(output,at:0.6)
        #expect(first.width == 320 && first.height == 180)
        let outside=(90*320+30)*4,inside=(90*320+240)*4
        #expect(first.data[outside+2]>170 && first.data[outside]<40)
        #expect(first.data[inside]>170 && first.data[inside+2]<40)
        #expect(second.data[outside+1]>170 && second.data[outside+2]<40)
        #expect(try await SyntheticExportFixture.audioRMS(output)>0.10)
        let bytes=try Data(contentsOf:output)
        var atoms:[String:Int]=[:],position=0
        while position+8<=bytes.count {
            let length=bytes[position..<position+4].reduce(UInt32(0)) { ($0<<8)|UInt32($1) }
            let type=String(data:bytes[position+4..<position+8],encoding:.ascii)!
            atoms[type]=position
            guard length>=8 else { break }; position += Int(length)
        }
        #expect(atoms["moov"] != nil && atoms["mdat"] != nil)
        #expect(atoms["moov"]! < atoms["mdat"]!)
        let again=try await service.export(id:fixture.package.id,to:fixture.root.appendingPathComponent("cached.mp4"))
        #expect(again.cached && again.cacheKey == result.cacheKey)
        #expect(try fixture.hashes() == hashes)
    }
    @Test func audioMixGainsAndEditorOffsetsPreserveMasters() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let hashes=try fixture.hashes(),service=PostproductionService(root:fixture.root)
        let loud=fixture.root.appendingPathComponent("loud.m4a")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.audio),to:loud)
        let energy=try await SyntheticExportFixture.audioRMS(loud)
        var edit=try await service.getEdit(id:fixture.package.id); edit.audio.micMuted=true; edit.audio.systemGain=0
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let quiet=fixture.root.appendingPathComponent("quiet.wav")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.audio,container:"wav"),to:quiet)
        let quietEnergy=try await SyntheticExportFixture.audioRMS(quiet)
        #expect(energy>0.10 && quietEnergy<0.0001)
        let directory=fixture.root.appendingPathComponent("editor",isDirectory:true)
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.editorTracks),to:directory)
        let offsets=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:directory.appendingPathComponent("offsets.json")))
        #expect(offsets["cameraOffsetMs"]?.int == 100)
        let mic=offsets["tracks"]?.array?.first { $0["role"]?.string == "mic" }
        #expect(mic?["offsetMs"]?.int == -120)
        #expect(offsets["editApplied"]?.bool == false)
        for kind in [TrackKind.screen,.camera,.microphone,.systemAudio] { #expect(try Data(contentsOf:directory.appendingPathComponent(RecordingPackage.trackFileName(for:kind))) == Data(contentsOf:fixture.package.trackURL(for:kind))) }
        #expect(try fixture.hashes() == hashes)
    }
    @Test func youtubeFullThumbnailCaptionAndSourceInvalidation() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.layout.preset = .screenOnly
        edit.clips=[EditClip(id:"c1",sourceStartMs:0,sourceEndMs:500)]
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let youtube=fixture.root.appendingPathComponent("youtube.mp4")
        let result=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.youtube),to:youtube)
        #expect(result.width == 1920 && result.height == 1080 && result.fps == 60)
        let tracks=try await AVURLAsset(url:youtube).loadTracks(withMediaType:.video)
        #expect(try await tracks[0].load(.nominalFrameRate) == 60)
        let full=fixture.root.appendingPathComponent("full.mov")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full,codec:"hevc",container:"mov",fps:60),to:full)
        let fullTracks=try await AVURLAsset(url:full).loadTracks(withMediaType:.video)
        let formats=try await fullTracks[0].load(.formatDescriptions)
        #expect(CMFormatDescriptionGetMediaSubType(formats[0]) == kCMVideoCodecType_HEVC)
        let thumbnail=fixture.root.appendingPathComponent("poster.png")
        _=try await service.thumbnail(id:fixture.package.id,to:thumbnail,atMs:100)
        let image=try #require(CGImageSourceCreateWithURL(thumbnail as CFURL,nil))
        let decoded=try #require(CGImageSourceCreateImageAtIndex(image,0,nil))
        #expect(decoded.width == 1280 && decoded.height == 720)
        let plain=try await service.export(id:fixture.package.id,to:fixture.root.appendingPathComponent("plain.mp4"))
        try FileManager.default.removeItem(at:fixture.package.trackURL(for:.screen))
        try await SyntheticExportFixture.video(to:fixture.package.trackURL(for:.screen),camera:false,allGreen:true)
        let changed=try await service.export(id:fixture.package.id,to:fixture.root.appendingPathComponent("changed.mp4"))
        #expect(changed.cacheKey != plain.cacheKey && !changed.cached)
        try AtomicFileWriter.write(Data("{\"words\":[{\"id\":\"w1\",\"text\":\"Hello\",\"startMs\":0,\"endMs\":500}],\"cues\":[{\"startMs\":0,\"endMs\":500,\"wordIds\":[\"w1\"]}]}".utf8),to:fixture.package.folderURL.appendingPathComponent("transcript.json"))
        edit.captions.burnIn=true; edit.captions.fontSize=100
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let caption=fixture.root.appendingPathComponent("caption.mp4")
        _=try await service.export(id:fixture.package.id,to:caption)
        let pixels=try await SyntheticExportFixture.pixels(caption,at:0.1)
        #expect(pixels.data.enumerated().filter { $0.offset%4 != 3 && $0.element>240 }.count>20)
    }
    @Test func cancellationDeletesStagedOutputAndMasterOverwriteRejected() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service=PostproductionService(root:fixture.root),output=fixture.root.appendingPathComponent("cancelled.mp4")
        let (stream,continuation)=AsyncStream<ExportProgress>.makeStream()
        let task=Task {
            defer { continuation.finish() }
            return try await service.export(id:fixture.package.id,options:ExportOptions(preset:.youtube),to:output,progress:{ continuation.yield($0) })
        }
        for await progress in stream { if progress.frames>=1 { task.cancel(); break } }
        do { _=try await task.value; Issue.record("Cancellation unexpectedly finished export") } catch is CancellationError {} catch { Issue.record("Unexpected cancellation error: \(error)") }
        #expect(!FileManager.default.fileExists(atPath:output.path))
        let renders=fixture.package.folderURL.appendingPathComponent("renders")
        let items=(try? FileManager.default.contentsOfDirectory(atPath:renders.path)) ?? []
        #expect(!items.contains(where:{$0.hasPrefix(".partial-")}))
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,to:fixture.package.trackURL(for:.screen)) }
    }
    @Test func everyRenderedLayoutAndAudioLatency() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.clips=[EditClip(id:"c1",sourceStartMs:300,sourceEndMs:500)]
        for preset in LayoutPreset.allCases {
            edit.layout.preset=preset
            _=try await service.setEdit(id:fixture.package.id,edit:edit)
            let output=fixture.root.appendingPathComponent("layout-\(preset.rawValue).mp4")
            _=try await service.export(id:fixture.package.id,to:output)
            let pixels=try await SyntheticExportFixture.pixels(output,at:0.1)
            let red=stride(from:0,to:pixels.data.count,by:4).filter { pixels.data[$0]>160 && pixels.data[$0+2]<50 }.count
            let blue=stride(from:0,to:pixels.data.count,by:4).filter { pixels.data[$0+2]>160 && pixels.data[$0]<50 }.count
            #expect(preset == .screenOnly ? red == 0 : red > 100)
            #expect(preset == .cameraOnly ? blue == 0 : blue > 100)
        }
        try FileManager.default.removeItem(at:fixture.package.trackURL(for:.microphone))
        try await SyntheticExportFixture.audio(to:fixture.package.trackURL(for:.microphone),frequency:440,onsetMs:500)
        edit.clips=[EditClip(id:"c1",sourceStartMs:250,sourceEndMs:1750)]
        edit.audio.systemGain=0
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let audio=fixture.root.appendingPathComponent("latency.wav")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.audio,container:"wav"),to:audio)
        // Onset 500ms minus latency 120ms minus trim 250ms = 130ms.
        #expect(try await SyntheticExportFixture.audioWindowRMS(audio,start:0.025,end:0.075)<0.005)
        #expect(try await SyntheticExportFixture.audioWindowRMS(audio,start:0.19,end:0.24)>0.12)
    }
    @Test func unsafeSourcePathsAndOtherTakeOverwriteRejected() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let second=try RecordingPackage.create(root:fixture.root,date:Date().addingTimeInterval(1))
        let secondManifest=RecordingManifest(id:second.id,status:.complete,tracks:[.init(kind:.screen)])
        try second.writeManifest(secondManifest)
        try AtomicFileWriter.write(Data("original".utf8),to:second.trackURL(for:.screen))
        let service=PostproductionService(root:fixture.root)
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,to:second.trackURL(for:.screen)) }
        #expect(try String(contentsOf:second.trackURL(for:.screen),encoding:.utf8) == "original")
        var manifest=try fixture.package.readManifest()
        manifest.tracks[0].file="../outside.mov"
        try fixture.package.writeManifest(manifest)
        await #expect(throws:ControlFailure.self) { try await PostproductionService(root:fixture.root).export(id:fixture.package.id,to:fixture.root.appendingPathComponent("unsafe.mp4")) }
        manifest=try fixture.package.readManifest(); manifest.tracks[0].file="screen.mov"; manifest.input = .init(file:"../outside.ndjson")
        try fixture.package.writeManifest(manifest)
        await #expect(throws:ControlFailure.self) { try await PostproductionService(root:fixture.root).getEdit(id:fixture.package.id) }
    }

    @Test func arbitraryTrimStartsWithPreviousDecodedFrameAndFullContainerRemux() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.clips=[EditClip(id:"c1",sourceStartMs:125,sourceEndMs:425)]
        edit.layout.preset = .screenOnly
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let mp4=fixture.root.appendingPathComponent("full.mp4")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full),to:mp4)
        let first=try await SyntheticExportFixture.pixels(mp4,at:0)
        #expect(first.data[(90*320+160)*4+2]>170)
        let mov=fixture.root.appendingPathComponent("remux.mov")
        _=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full,container:"mov"),to:mov)
        let before=try await AVURLAsset(url:mp4).loadTracks(withMediaType:.video),after=try await AVURLAsset(url:mov).loadTracks(withMediaType:.video)
        let beforeFormats=try await before[0].load(.formatDescriptions),afterFormats=try await after[0].load(.formatDescriptions)
        #expect(CMFormatDescriptionGetMediaSubType(beforeFormats[0]) == CMFormatDescriptionGetMediaSubType(afterFormats[0]))
        #expect(try await SyntheticExportFixture.pixels(mov,at:0).data == first.data)
    }

    @Test func shorterCameraKeepsItsLastFrameAcrossLaterCuts() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        try FileManager.default.removeItem(at:fixture.package.trackURL(for:.camera))
        try await SyntheticExportFixture.video(to:fixture.package.trackURL(for:.camera),camera:true,frameCount:12)
        let service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.clips=[EditClip(id:"c1",sourceStartMs:1500,sourceEndMs:1800)]
        edit.layout.bubble.center=[0.75,0.5]; edit.layout.bubble.size=0.25
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let output=fixture.root.appendingPathComponent("short-camera.mp4")
        _=try await service.export(id:fixture.package.id,to:output)
        let pixels=try await SyntheticExportFixture.pixels(output,at:0)
        #expect(pixels.data[(90*320+240)*4]>170)
        #expect(pixels.data[(90*320+30)*4+1]>170)
    }

    @Test func inputTelemetryChangesZoomCacheWithBakedCursor() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        try FileManager.default.removeItem(at:fixture.package.trackURL(for:.screen))
        try await SyntheticExportFixture.video(to:fixture.package.trackURL(for:.screen),camera:false,spatialHalves:true)
        let service=PostproductionService(root:fixture.root)
        var edit=try await service.getEdit(id:fixture.package.id)
        edit.layout.preset = .screenOnly; edit.drawCursor=false
        edit.zoomCues=[ZoomCue(clipId:"c1",sourceStartMs:0,sourceEndMs:2000,scale:2,focus:[0.25,0.5],origin:"manual")]
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let first=fixture.root.appendingPathComponent("no-pointer.mp4")
        let initial=try await service.export(id:fixture.package.id,to:first)
        let left=try await SyntheticExportFixture.pixels(first,at:0.7),center=(90*320+160)*4
        #expect(left.data[center+2]>left.data[center+1]+100)
        // Presence is a cache input as well as bytes: manual cues work before
        // the optional input file exists.
        try AtomicFileWriter.write(Data("{\"t\":0,\"k\":\"move\",\"x\":0.75,\"y\":0.5}\n".utf8),to:fixture.package.inputURL)
        let second=fixture.root.appendingPathComponent("new-pointer.mp4")
        let changed=try await service.export(id:fixture.package.id,to:second)
        let right=try await SyntheticExportFixture.pixels(second,at:0.7)
        #expect(changed.cacheKey != initial.cacheKey && !changed.cached)
        #expect(Int(right.data[center+1])>Int(right.data[center+2])+100)
        let unchanged=try await service.export(id:fixture.package.id,to:fixture.root.appendingPathComponent("unchanged.mp4"))
        #expect(unchanged.cached && unchanged.cacheKey == changed.cacheKey)
        try AtomicFileWriter.write(Data("{\"t\":0,\"k\":\"move\",\"x\":0.25,\"y\":0.5}\n".utf8),to:fixture.package.inputURL)
        let third=fixture.root.appendingPathComponent("mutated-pointer.mp4")
        let mutated=try await service.export(id:fixture.package.id,to:third)
        let back=try await SyntheticExportFixture.pixels(third,at:0.7)
        #expect(!mutated.cached && mutated.cacheKey != changed.cacheKey)
        #expect(Int(back.data[center+2])>Int(back.data[center+1])+100)
        edit.meta.title="Equivalent fresh-render control"
        _=try await service.setEdit(id:fixture.package.id,edit:edit)
        let control=fixture.root.appendingPathComponent("forced-fresh.mp4")
        _=try await service.export(id:fixture.package.id,to:control)
        let fresh=try await SyntheticExportFixture.pixels(control,at:0.7)
        let deltas=zip(fresh.data,back.data).map { abs(Int($0)-Int($1)) }
        let meanDifference=Double(deltas.reduce(0,+))/Double(deltas.count)
        // Separate H264 encodes have small edge quantization differences. The
        // spatial pan oracle is exact at the flat-color center, while an average
        // below one intensity step checks the complete decoded composition.
        let sameCenter=Array(fresh.data[center..<center+4]) == Array(back.data[center..<center+4])
        #expect(sameCenter)
        #expect(meanDifference<1)

    }
    @Test func managedRenderDirectoriesStampsAndRemuxRejectSymlinkEscapes() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let outside=fixture.root.appendingPathComponent("outside-package",isDirectory:true)
        try FileManager.default.createDirectory(at:outside,withIntermediateDirectories:false)
        let marker=outside.appendingPathComponent("marker.txt")
        try AtomicFileWriter.write(Data("outside negative control".utf8),to:marker)
        let service=PostproductionService(root:fixture.root),renders=fixture.package.rendersDirectory
        try FileManager.default.createSymbolicLink(at:renders,withDestinationURL:outside)
        let output=fixture.root.appendingPathComponent("refused.mp4")
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,to:output) }
        await #expect(throws:ControlFailure.self) { try await service.thumbnail(id:fixture.package.id,to:fixture.root.appendingPathComponent("refused.png")) }
        #expect(try FileManager.default.contentsOfDirectory(atPath:outside.path) == ["marker.txt"])
        #expect(try String(contentsOf:marker,encoding:.utf8) == "outside negative control")
        #expect(!FileManager.default.fileExists(atPath:output.path))
        try FileManager.default.removeItem(at:renders)
        let good=try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full),to:fixture.root.appendingPathComponent("positive.mp4"))
        #expect(!good.cached && FileManager.default.fileExists(atPath:fixture.root.appendingPathComponent("positive.mp4").path))
        let cache=renders.appendingPathComponent(good.cacheKey+".mp4"),stamp=renders.appendingPathComponent(good.cacheKey+".json")
        let originalStamp=try Data(contentsOf:stamp),originalCache=try Data(contentsOf:cache)
        let outsideStamp=outside.appendingPathComponent("outside.json")
        try AtomicFileWriter.write(originalStamp,to:outsideStamp)
        try FileManager.default.removeItem(at:stamp)
        try FileManager.default.createSymbolicLink(at:stamp,withDestinationURL:outsideStamp)
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full),to:output) }
        // A MOV cache miss must validate the sibling MP4 stamp before remux.
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full,container:"mov"),to:fixture.root.appendingPathComponent("refused.mov")) }
        #expect(try Data(contentsOf:outsideStamp) == originalStamp)
        try FileManager.default.removeItem(at:stamp); try AtomicFileWriter.write(originalStamp,to:stamp)
        let outsideVideo=outside.appendingPathComponent("outside.mp4")
        try AtomicFileWriter.write(originalCache,to:outsideVideo)
        try FileManager.default.removeItem(at:cache)
        try FileManager.default.createSymbolicLink(at:cache,withDestinationURL:outsideVideo)
        await #expect(throws:ControlFailure.self) { try await service.export(id:fixture.package.id,options:ExportOptions(preset:.full),to:output) }
        #expect(try Data(contentsOf:outsideVideo) == originalCache)
        #expect(!(try FileManager.default.contentsOfDirectory(atPath:outside.path)).contains(where:{$0.hasPrefix(".partial-")}))
        #expect(!(try FileManager.default.contentsOfDirectory(atPath:renders.path)).contains(where:{$0.hasPrefix(".partial-")}))
    }

}
