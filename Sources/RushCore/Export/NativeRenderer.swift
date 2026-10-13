@preconcurrency import AVFoundation
import CoreImage
import CryptoKit
import Foundation

final class NativeRenderer: @unchecked Sendable {
    let package: RecordingPackage
    let manifest: RecordingManifest
    let edit: EditDocument
    let options: ExportOptions
    let derivedCamera:URL?
    let context = CIContext(options: [.cacheIntermediates: false])
    init(package: RecordingPackage, manifest: RecordingManifest, edit: EditDocument, options: ExportOptions,derivedCamera:URL? = nil) {
        self.package=package; self.manifest=manifest; self.edit=edit; self.options=options
        self.derivedCamera=derivedCamera
    }
    private struct VideoSource {
        let asset: AVURLAsset
        let track: AVAssetTrack
        let offsetMs: Double
        let transform: CGAffineTransform
        let durationMs:Double
    }
    private final class FrameReader {
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        var current: CMSampleBuffer?
        var next: CMSampleBuffer?
        let source: VideoSource
        var seed:CIImage?
        init(source: VideoSource, startMs: Double, endMs: Double) async throws {
            self.source=source
            reader=try AVAssetReader(asset: source.asset)
            output=AVAssetReaderTrackOutput(track: source.track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
            output.alwaysCopiesSampleData=false
            reader.add(output)
            let start=min(max(0,startMs-source.offsetMs),max(0,source.durationMs-1))
            let end=min(source.durationMs,max(start+1,endMs-source.offsetMs))
            reader.timeRange=CMTimeRange(start: CMTime(seconds:start/1000,preferredTimescale:600_000),end:CMTime(seconds:end/1000,preferredTimescale:600_000))
            guard reader.startReading() else { throw renderFailure(reader.error?.localizedDescription ?? "Video reader could not start") }
            next=output.copyNextSampleBuffer()
            // Seed the cut with the actual previous frame. A static screen can
            // have no sample near the trim point, so starting its reader there
            // alone would create a black first frame.
            let generator=AVAssetImageGenerator(asset:source.asset)
            generator.appliesPreferredTrackTransform=true
            generator.requestedTimeToleranceBefore = .positiveInfinity
            generator.requestedTimeToleranceAfter = .zero
            let requestMs=min(max(0,startMs-source.offsetMs),max(0,source.durationMs-1))
            let frame=try await generator.image(at:CMTime(seconds:requestMs/1000,preferredTimescale:600_000)).image
            seed=CIImage(cgImage:frame)
        }
        func image(at sourceMs: Double) throws -> CIImage? {
            let time=(sourceMs-source.offsetMs)/1000
            guard time >= 0 else { return nil }
            while let sample=next, sample.presentationTimeStamp.seconds <= time+0.00001 {
                current=sample; next=output.copyNextSampleBuffer()
            }
            if reader.status == .failed { throw renderFailure(reader.error?.localizedDescription ?? "Video decoding failed") }
            guard let sample=current, let buffer=CMSampleBufferGetImageBuffer(sample) else { return seed }
            let image=CIImage(cvPixelBuffer:buffer).transformed(by:source.transform)
            return image.transformed(by:CGAffineTransform(translationX:-image.extent.minX,y:-image.extent.minY))
        }
        deinit { reader.cancelReading() }
    }
    /// One task reads bounded PCM file blocks and owns the audio writer input.
    /// No final AVAssetReader or compressed composition is involved. The video
    /// task owns its distinct input; finalization follows the audio task join.
    private final class AudioPump: @unchecked Sendable {
        let file:AVAudioFile
        let buffer:AVAudioPCMBuffer
        let input:AVAssetWriterInput
        let writer:AVAssetWriter
        let renderer:NativeRenderer
        init(file:AVAudioFile,buffer:AVAudioPCMBuffer,input:AVAssetWriterInput,writer:AVAssetWriter,renderer:NativeRenderer) {
            self.file=file; self.buffer=buffer; self.input=input; self.writer=writer; self.renderer=renderer
        }
        func run() async throws {
            defer { if writer.status == .writing { input.markAsFinished() } }
            var frame:Int64=0
            while frame<file.length {
                try Task.checkCancellation()
                let count=AVAudioFrameCount(min(Int64(PCMEditingAudioRenderer.block),file.length-frame))
                try file.read(into:buffer,frameCount:count)
                guard buffer.frameLength == count else { throw renderFailure("Edited PCM file ended before its expected frame count") }
                var timing=CMSampleTimingInfo(duration:CMTime(value:1,timescale:48_000),presentationTimeStamp:CMTime(value:frame,timescale:48_000),decodeTimeStamp:.invalid)
                var sample:CMSampleBuffer?
                guard CMSampleBufferCreate(allocator:kCFAllocatorDefault,dataBuffer:nil,dataReady:false,makeDataReadyCallback:nil,refcon:nil,formatDescription:buffer.format.formatDescription,sampleCount:Int(count),sampleTimingEntryCount:1,sampleTimingArray:&timing,sampleSizeEntryCount:0,sampleSizeArray:nil,sampleBufferOut:&sample) == noErr,let sample else { throw renderFailure("Cannot create an edited PCM sample") }
                // Copy the bounded PCM block: the writer can retain this sample
                // while the file buffer is reused for the next block.
                guard CMSampleBufferSetDataBufferFromAudioBufferList(sample,blockBufferAllocator:kCFAllocatorDefault,blockBufferMemoryAllocator:kCFAllocatorDefault,flags:0,bufferList:buffer.audioBufferList) == noErr,
                      CMSampleBufferSetDataReady(sample) == noErr else { throw renderFailure("Cannot copy edited PCM sample data") }
                try await renderer.wait(input,writer:writer)
                guard input.append(sample) else { throw renderFailure(writer.error?.localizedDescription ?? "Audio append failed") }
                frame += Int64(count)
            }
            guard frame == file.length else { throw renderFailure("PCM writer did not reach the end of the edited timeline") }
        }
    }
    private func source(_ kind: TrackKind) async throws -> VideoSource? {
        guard let track=manifest.tracks.first(where:{$0.kind == kind && $0.present}) else { return nil }
        let url:URL
        if kind == .camera,let derivedCamera { url=derivedCamera }
        else { url=try safeTrackURL(track.file) }
        let asset=AVURLAsset(url:url)
        guard let media=try await asset.loadTracks(withMediaType:.video).first else { throw renderFailure("No video stream in \(track.file)") }
        return VideoSource(asset:asset,track:media,offsetMs:Double(track.offsetMs-(manifest.tracks.first(where:{$0.kind == .screen})?.offsetMs ?? 0)),transform:try await media.load(.preferredTransform),durationMs:try await asset.load(.duration).seconds*1000)
    }
    func safeTrackURL(_ file: String) throws -> URL {
        try PostproductionPaths.file(file,in:package.folderURL)
    }
    func dimensions() async throws -> (Int,Int) {
        let screen=try await source(.screen)
        let camera=try await source(.camera)
        let source=screen ?? camera
        guard let source else { throw renderFailure("The recording has no video track") }
        let native=try await source.track.load(.naturalSize).applying(source.transform)
        var width=abs(native.width),height=abs(native.height)
        if edit.layout.canvas == "16:9" { height=width*9/16 }
        if edit.layout.canvas == "1:1" { height=width }
        if edit.layout.canvas == "9:16" { width=height*9/16 }
        if options.preset == .share { let factor=min(1,1920/max(width,height)); width *= factor; height *= factor }
        if options.preset == .youtube && !options.sourceSize { width=1920; height=1080 }
        return (max(2,Int(width)/2*2),max(2,Int(height)/2*2))
    }
    private func prepareAudioPCM() async throws -> (AVAudioFile,AVAudioPCMBuffer,URL)? {
        let screenOffset=manifest.tracks.first(where:{$0.kind == .screen})?.offsetMs ?? 0
        var sources:[PCMEditingAudioInput]=[]
        for info in manifest.tracks where info.present && (info.kind == .microphone || info.kind == .systemAudio) {
            let decoded=try await PCMAudioSourceCache.shared.prepare(package:package,track:info)
            let offset=Double(info.offsetMs-screenOffset-(info.latencyMs ?? 0))
            let gain=info.kind == .microphone ? (edit.audio.micMuted ? 0 : edit.audio.micGain) : edit.audio.systemGain
            sources.append(.init(url:decoded.url,frameCount:decoded.frameCount,offsetMs:offset,gain:gain))
        }
        guard !sources.isEmpty else { return nil }
        let directory=try PostproductionPaths.managedDirectory("renders",in:package.folderURL,create:true)
        let mixed=try PostproductionPaths.managedFile(".pcm-mix-\(UUID().uuidString).caf",in:directory)
        do {
            _=try await PCMEditingAudioRenderer(inputs:sources,clips:edit.clips).render(to:mixed)
            try Task.checkCancellation()
            _=try PostproductionPaths.managedDirectory("renders",in:package.folderURL)
            _=try PostproductionPaths.managedFile(mixed.lastPathComponent,in:directory)
            let file=try AVAudioFile(forReading:mixed,commonFormat:.pcmFormatFloat32,interleaved:false)
            guard file.length>0,let buffer=AVAudioPCMBuffer(pcmFormat:file.processingFormat,frameCapacity:PCMEditingAudioRenderer.block) else { throw renderFailure("Edited PCM has no audio frames") }
            return (file,buffer,mixed)
        } catch {
            if let own=try? PostproductionPaths.managedFile(mixed.lastPathComponent,in:directory) { try? FileManager.default.removeItem(at:own) }
            throw error
        }
    }
    func render(to target: URL, progress: (@Sendable (ExportProgress) -> Void)? = nil) async throws -> (Int,Int) {
        try Task.checkCancellation()
        let audio=try await prepareAudioPCM()
        defer {
            if let audio,let directory=try? PostproductionPaths.managedDirectory("renders",in:package.folderURL),
               let own=try? PostproductionPaths.managedFile(audio.2.lastPathComponent,in:directory) { try? FileManager.default.removeItem(at:own) }
        }
        let audioOnly=options.preset == .audio
        let dimensions=audioOnly ? (0,0) : try await dimensions()
        let fileType:AVFileType=options.container == "mov" ? .mov : options.container == "wav" ? .wav : options.container == "m4a" ? .m4a : .mp4
        let writer=try AVAssetWriter(outputURL:target,fileType:fileType)
        writer.shouldOptimizeForNetworkUse=true
        var videoInput:AVAssetWriterInput?
        var adaptor:AVAssetWriterInputPixelBufferAdaptor?
        if !audioOnly {
            let bitrate=options.preset == .youtube ? Double(dimensions.0*dimensions.1)*16_000_000/(1920*1080) : Double(dimensions.0*dimensions.1*options.fps)*0.15
            var compression:[String:Any]=[AVVideoAverageBitRateKey:Int(bitrate),AVVideoExpectedSourceFrameRateKey:options.fps,AVVideoMaxKeyFrameIntervalKey:options.fps*2]
            if options.codec == "h264" { compression[AVVideoProfileLevelKey]=AVVideoProfileLevelH264HighAutoLevel }
            let input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:options.codec == "hevc" ? AVVideoCodecType.hevc : .h264,AVVideoWidthKey:dimensions.0,AVVideoHeightKey:dimensions.1,AVVideoCompressionPropertiesKey:compression])
            guard writer.canAdd(input) else { throw renderFailure("Cannot encode video") }
            writer.add(input); videoInput=input
            adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:dimensions.0,kCVPixelBufferHeightKey as String:dimensions.1,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
        }
        var audioInput:AVAssetWriterInput?
        if audio != nil {
            var settings:[String:Any]=[AVFormatIDKey:options.container == "wav" ? kAudioFormatLinearPCM : kAudioFormatMPEG4AAC,AVSampleRateKey:48_000,AVNumberOfChannelsKey:2]
            if options.container == "wav" { settings[AVLinearPCMBitDepthKey]=16; settings[AVLinearPCMIsFloatKey]=false; settings[AVLinearPCMIsBigEndianKey]=false; settings[AVLinearPCMIsNonInterleaved]=false }
            else { settings[AVEncoderBitRateKey]=160_000 }
            let input=AVAssetWriterInput(mediaType:.audio,outputSettings:settings)
            guard writer.canAdd(input) else { throw renderFailure("Cannot encode audio") }
            writer.add(input); audioInput=input
        } else if audioOnly { throw renderFailure("The recording has no audio track") }
        guard writer.startWriting() else { throw renderFailure(writer.error?.localizedDescription ?? "Writer could not start") }
        writer.startSession(atSourceTime:.zero)
        // Each writer input must make independent progress. Serial audio/video
        // readiness waits can deadlock the muxer when one input needs the other
        // to drain or signal its end of stream.
        let audioTask:Task<Void,Error>?
        if let audio,let input=audioInput {
            let pump=AudioPump(file:audio.0,buffer:audio.1,input:input,writer:writer,renderer:self)
            audioTask=Task { try await pump.run() }
        } else { audioTask=nil }
        do {
            if let input=videoInput, let adaptor {
                let screen=try await source(.screen), camera=try await source(.camera)
                let pointers=try readPointers()
                let captions=try CaptionOverlay.load(package:package,settings:edit.captions,width:dimensions.0,height:dimensions.1)
                let frameCount=Int(ceil(edit.durationMs/1000*Double(options.fps)))
                var lastClip="", screenReader:FrameReader?, cameraReader:FrameReader?
                var viewport=ViewportTimeline(), pointerIndex=0, pointer:[Double]?
                var lastSource = -1.0
                for frame in 0..<frameCount {
                    try Task.checkCancellation()
                    let outputMs=Double(frame)*1000/Double(options.fps)
                    guard let mapped=edit.sourceTime(at:outputMs) else { break }
                    if mapped.clip.id != lastClip {
                        if let screen { screenReader=try await FrameReader(source:screen,startMs:mapped.clip.sourceStartMs,endMs:mapped.clip.sourceEndMs) }
                        if let camera { cameraReader=try await FrameReader(source:camera,startMs:mapped.clip.sourceStartMs,endMs:mapped.clip.sourceEndMs) }
                        lastClip=mapped.clip.id
                    }
                    if mapped.sourceMs < lastSource { pointerIndex=0; pointer=nil }
                    while pointerIndex < pointers.count && pointers[pointerIndex].t <= mapped.sourceMs {
                        if let x=pointers[pointerIndex].x,let y=pointers[pointerIndex].y { pointer=[x,y] }
                        pointerIndex += 1
                    }
                    lastSource=mapped.sourceMs
                    let state=viewport.tick(clip:mapped.clip,sourceMs:mapped.sourceMs,cues:edit.zoomCues,pointer:pointer,dt:1/Double(options.fps))
                    let composite=try compose(screen:screenReader?.image(at:mapped.sourceMs),camera:cameraReader?.image(at:mapped.sourceMs),viewport:state,pointer:edit.drawCursor ? pointer : nil,width:dimensions.0,height:dimensions.1)
                    let image=captions.image(at:mapped.sourceMs)?.composited(over:composite) ?? composite
                    try await wait(input,writer:writer)
                    guard let pool=adaptor.pixelBufferPool else { throw renderFailure("Missing render buffer pool") }
                    var buffer:CVPixelBuffer?
                    guard CVPixelBufferPoolCreatePixelBuffer(nil,pool,&buffer) == kCVReturnSuccess,let buffer else { throw renderFailure("Pixel allocation failed") }
                    context.render(image,to:buffer,bounds:CGRect(x:0,y:0,width:dimensions.0,height:dimensions.1),colorSpace:CGColorSpaceCreateDeviceRGB())
                    guard adaptor.append(buffer,withPresentationTime:CMTime(value:Int64(frame),timescale:Int32(options.fps))) else { throw renderFailure(writer.error?.localizedDescription ?? "Video append failed") }
                    if frame % options.fps == 0 || frame == frameCount-1 { progress?(ExportProgress(frames:frame+1,totalFrames:frameCount)) }
                }
                input.markAsFinished()
            }
            try await withTaskCancellationHandler(operation:{ try await audioTask?.value },onCancel:{ audioTask?.cancel() })
            writer.endSession(atSourceTime:CMTime(seconds:edit.durationMs/1000,preferredTimescale:600_000))
            await writer.finishWriting()
            guard writer.status == .completed else { throw renderFailure(writer.error?.localizedDescription ?? "Writer failed during finalize") }
            try Task.checkCancellation()
        } catch {
            audioTask?.cancel(); writer.cancelWriting()
            _=await audioTask?.result
            try? FileManager.default.removeItem(at:target); throw error
        }
        return dimensions
    }
    private func wait(_ input: AVAssetWriterInput,writer: AVAssetWriter) async throws {
        let deadline=ContinuousClock.now.advanced(by:.seconds(30))
        while !input.isReadyForMoreMediaData {
            try Task.checkCancellation()
            guard writer.status == .writing else { throw renderFailure(writer.error?.localizedDescription ?? "Encoder stopped") }
            guard ContinuousClock.now < deadline else { throw renderFailure("\(input.mediaType.rawValue) encoder stalled for 30 seconds") }
            try await Task.sleep(for:.milliseconds(2))
        }
    }
    private func readPointers() throws -> [PointerSample] {
        let url=try PostproductionPaths.file(manifest.input?.file ?? "input.ndjson",in:package.folderURL,requireExists:false)
        guard FileManager.default.fileExists(atPath:url.path) else { return [] }
        let data=try Data(contentsOf:url)
        guard let text=String(data:data,encoding:.utf8) else { throw renderFailure("Input timeline is not UTF-8") }
        return text.split(separator:"\n").compactMap { try? JSONDecoder().decode(PointerSample.self,from:Data($0.utf8)) }.sorted { $0.t < $1.t }
    }
    private func compose(screen: CIImage?,camera: CIImage?,viewport: ViewportState,pointer: [Double]?,width: Int,height: Int) throws -> CIImage {
        let bounds=CGRect(x:0,y:0,width:width,height:height)
        var image=CIImage(color:CIColor(red:0.06,green:0.07,blue:0.09)).cropped(to:bounds)
        let hasScreen=manifest.tracks.contains { $0.kind == .screen && $0.present }
        let frames=LayoutPlanner.frames(layout:edit.layout,canvasAspect:Double(width)/Double(height),hasCamera:camera != nil,zoomScale:viewport.scale,hasScreen:hasScreen)
        func rect(_ fraction:CGRect) -> CGRect { CGRect(x:fraction.minX*Double(width),y:(1-fraction.maxY)*Double(height),width:fraction.width*Double(width),height:fraction.height*Double(height)) }
        if let screen,let region=frames.screen {
            let extent=screen.extent
            let cropWidth=extent.width/viewport.scale,cropHeight=extent.height/viewport.scale
            let crop=CGRect(x:min(extent.width-cropWidth,max(0,viewport.x*extent.width-cropWidth/2)),y:min(extent.height-cropHeight,max(0,(1-viewport.y)*extent.height-cropHeight/2)),width:cropWidth,height:cropHeight)
            image=fit(screen.cropped(to:crop),to:rect(region),fill:false).composited(over:image)
            if let pointer {
                let px=(pointer[0]*extent.width-crop.minX)/crop.width,py=((1-pointer[1])*extent.height-crop.minY)/crop.height
                let region=rect(region)
                if (0...1).contains(px),(0...1).contains(py),let cursor=OverlayArtwork.cursor(size:CGFloat(max(16,width/64))) {
                    image=CIImage(cgImage:cursor).transformed(by:CGAffineTransform(translationX:region.minX+px*region.width,y:region.minY+py*region.height-CGFloat(cursor.height))).composited(over:image)
                }
            }
        }
        if var camera,let region=frames.camera {
            if edit.layout.bubble.mirror { camera=camera.transformed(by:CGAffineTransform(translationX:camera.extent.width,y:0).scaledBy(x:-1,y:1)) }
            let destination=rect(region)
            var layer=fit(camera,to:destination,fill:true)
            if frames.roundCamera {
                let radius=edit.layout.bubble.shape == "circle" ? min(destination.width,destination.height)/2 : min(destination.width,destination.height)*CGFloat(0.12+edit.layout.bubble.roundness*0.20)
                let mask=CIImage.empty().applyingFilter("CIRoundedRectangleGenerator",parameters:["inputExtent":CIVector(cgRect:destination),"inputRadius":radius,"inputColor":CIColor.white])
                layer=layer.applyingFilter("CIBlendWithMask",parameters:[kCIInputBackgroundImageKey:CIImage.empty(),kCIInputMaskImageKey:mask])
            }
            image=layer.composited(over:image)
        }
        return image.cropped(to:bounds)
    }
    private func fit(_ image: CIImage,to rect: CGRect,fill: Bool) -> CIImage {
        let scale=fill ? max(rect.width/image.extent.width,rect.height/image.extent.height) : min(rect.width/image.extent.width,rect.height/image.extent.height)
        let normalized=image.transformed(by:CGAffineTransform(translationX:-image.extent.minX,y:-image.extent.minY))
        return normalized.transformed(by:CGAffineTransform(scaleX:scale,y:scale)).transformed(by:CGAffineTransform(translationX:rect.midX-image.extent.width*scale/2,y:rect.midY-image.extent.height*scale/2)).cropped(to:rect)
    }
}
func renderFailure(_ message: String) -> ControlFailure { ControlFailure(code:"render-failed",message:message) }
