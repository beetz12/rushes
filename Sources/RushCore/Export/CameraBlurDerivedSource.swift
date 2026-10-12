@preconcurrency import AVFoundation
import CoreImage
import CryptoKit
import Foundation

protocol CameraBlurFrameProcessing:Sendable {
    func process(_ buffer:CVPixelBuffer,at time:CMTime) async throws -> CameraBlurFrame
    func cancel()
}
extension CameraBlurExportWorker:CameraBlurFrameProcessing {}

struct CameraBlurDerivedResult:Codable,Equatable,Sendable {
    var schema:String = "rushes.camera-blur-source/1"
    var sourceSHA256:String
    var policy:ProductionEffectsPolicy
    var sha256:String
    var width:Int
    var height:Int
    var frames:Int
    var durationMs:Double
}
struct CameraBlurDerivedVideo:Sendable { var url:URL; var result:CameraBlurDerivedResult }

/// Only derived camera pixels enter this cache. Source recordings remain intact.
actor CameraBlurDerivedSource {
    static let shared=CameraBlurDerivedSource()
    typealias Factory = @Sendable(Double) throws -> any CameraBlurFrameProcessing
    private let factory:Factory
    private var active:Set<String>=[]
    init(factory:@escaping Factory = { try CameraBlurExportWorker(radius:$0) }) { self.factory=factory }
    func prepare(package:RecordingPackage,manifest:RecordingManifest,policy:ProductionEffectsPolicy) async throws -> CameraBlurDerivedVideo? {
        try policy.validate(); try Task.checkCancellation()
        guard policy.cameraBlur.enabled,let camera=manifest.tracks.first(where:{$0.kind == .camera && $0.present}) else { return nil }
        let source=try PostproductionPaths.file(camera.file,in:package.folderURL)
        let sourceHash=try Self.hash(source)
        var fingerprint=SHA256(); fingerprint.update(data:Data("rushes.camera-blur-source/1".utf8))
        fingerprint.update(data:Data(sourceHash.utf8)); fingerprint.update(data:try ControlWire.encoder.encode(policy))
        let key=fingerprint.finalize().map{String(format:"%02x",$0)}.joined()
        let admission=package.folderURL.resolvingSymlinksInPath().path+"/"+key
        guard active.insert(admission).inserted else { throw ControlFailure(code:"render-in-progress",message:"This camera effect is already rendering") }
        defer { active.remove(admission) }
        let renders=try PostproductionPaths.managedDirectory("renders",in:package.folderURL,create:true)
        let directory=try PostproductionPaths.managedDirectory("camera_blur",in:renders,create:true)
        let output=try PostproductionPaths.managedFile(key+".mov",in:directory)
        let stamp=try PostproductionPaths.managedFile(key+".json",in:directory)
        if FileManager.default.fileExists(atPath:output.path),FileManager.default.fileExists(atPath:stamp.path) {
            let result=try JSONDecoder().decode(CameraBlurDerivedResult.self,from:Data(contentsOf:stamp))
            guard result.schema == "rushes.camera-blur-source/1",result.sourceSHA256 == sourceHash,result.policy == policy,
                  result.frames>0,result.width>0,result.height>0,try Self.hash(output) == result.sha256 else { throw renderFailure("Derived camera cache does not match its processed content") }
            return .init(url:output,result:result)
        }
        let partialName=".partial-\(UUID().uuidString).mov"
        let partial=try PostproductionPaths.managedFile(partialName,in:directory)
        defer {
            if (try? PostproductionPaths.managedDirectory("renders",in:package.folderURL)) != nil,
               (try? PostproductionPaths.managedDirectory("camera_blur",in:renders)) != nil,
               let own=try? PostproductionPaths.managedFile(partialName,in:directory) {
                try? FileManager.default.removeItem(at:own)
                if let files=try? FileManager.default.contentsOfDirectory(at:directory,includingPropertiesForKeys:nil) {
                    for file in files where file.lastPathComponent.hasPrefix(partialName+".") {
                        if let sidecar=try? PostproductionPaths.managedFile(file.lastPathComponent,in:directory) { try? FileManager.default.removeItem(at:sidecar) }
                    }
                }
            }
        }
        let processor=try factory(policy.cameraBlur.radius)
        let encoding=try await CameraBlurEncoding(source:source,target:partial,processor:processor,fps:camera.fps ?? 30)
        let dimensions=try await withTaskCancellationHandler(operation:{ try await encoding.run() },onCancel:{ processor.cancel() })
        try Task.checkCancellation()
        // Revalidate all managed paths at installation, including the stamp.
        _=try PostproductionPaths.managedDirectory("renders",in:package.folderURL)
        _=try PostproductionPaths.managedDirectory("camera_blur",in:renders)
        _=try PostproductionPaths.managedFile(partialName,in:directory)
        _=try PostproductionPaths.managedFile(output.lastPathComponent,in:directory)
        _=try PostproductionPaths.managedFile(stamp.lastPathComponent,in:directory)
        let result=CameraBlurDerivedResult(sourceSHA256:sourceHash,policy:policy,sha256:try Self.hash(partial),width:dimensions.width,height:dimensions.height,frames:dimensions.frames,durationMs:dimensions.durationMs)
        try AtomicFileWriter.posixRename(from:partial,to:output)
        try AtomicFileWriter.writeEncodable(result,to:stamp,encoder:ControlWire.encoder)
        return .init(url:output,result:result)
    }
    static func hash(_ path:URL) throws -> String {
        let file=try FileHandle(forReadingFrom:path); defer { try? file.close() }
        var hash=SHA256()
        while let bytes=try file.read(upToCount:1_048_576),!bytes.isEmpty { try Task.checkCancellation(); hash.update(data:bytes) }
        return hash.finalize().map{String(format:"%02x",$0)}.joined()
    }
}

/// Executes only on export work. A processor error aborts before any raw camera
/// sample can reach the derived writer or composed output.
private final class CameraBlurEncoding:@unchecked Sendable {
    let reader:AVAssetReader
    let output:AVAssetReaderTrackOutput
    let writer:AVAssetWriter
    let input:AVAssetWriterInput
    let adaptor:AVAssetWriterInputPixelBufferAdaptor
    let processor:any CameraBlurFrameProcessing
    let transform:CGAffineTransform
    let width:Int
    let height:Int
    let duration:CMTime
    let context=CIContext(options:[.cacheIntermediates:false])
    init(source:URL,target:URL,processor:any CameraBlurFrameProcessing,fps:Int) async throws {
        self.processor=processor
        let asset=AVURLAsset(url:source)
        guard let track=try await asset.loadTracks(withMediaType:.video).first else { throw renderFailure("Camera master has no video stream") }
        transform=try await track.load(.preferredTransform)
        let extent=CGRect(origin:.zero,size:try await track.load(.naturalSize)).applying(transform)
        guard extent.width.isFinite,extent.height.isFinite,extent.width>=2,extent.height>=2,extent.width<=4096,extent.height<=4096 else { throw ControlFailure(code:"blur-frame-size",message:"Requested camera blur requires frames from2 through4096 pixels per side") }
        width=Int(extent.width)/2*2; height=Int(extent.height)/2*2
        duration=try await asset.load(.duration)
        guard duration.seconds.isFinite,duration.seconds>0 else { throw renderFailure("Camera master has no positive duration") }
        reader=try AVAssetReader(asset:asset)
        output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
        output.alwaysCopiesSampleData=false
        guard reader.canAdd(output) else { throw renderFailure("Cannot decode camera for requested blur") }; reader.add(output)
        writer=try AVAssetWriter(outputURL:target,fileType:.mov)
        input=AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:width,AVVideoHeightKey:height,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:max(1_000_000,width*height*8),AVVideoExpectedSourceFrameRateKey:min(120,max(1,fps))]])
        guard writer.canAdd(input) else { throw renderFailure("Cannot encode processed camera") }; writer.add(input)
        adaptor=AVAssetWriterInputPixelBufferAdaptor(assetWriterInput:input,sourcePixelBufferAttributes:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferWidthKey as String:width,kCVPixelBufferHeightKey as String:height,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
    }
    func run() async throws -> (width:Int,height:Int,frames:Int,durationMs:Double) {
        guard reader.startReading(),writer.startWriting() else { throw renderFailure("Processed camera reader/writer could not start") }
        writer.startSession(atSourceTime:.zero)
        var frames=0
        do {
            while let sample=output.copyNextSampleBuffer() {
                try Task.checkCancellation()
                let time=sample.presentationTimeStamp
                guard time.seconds.isFinite,time.seconds>=0,let raw=CMSampleBufferGetImageBuffer(sample) else { throw renderFailure("Camera source frame is invalid") }
                let deadline=ContinuousClock.now.advanced(by:.seconds(30))
                while !input.isReadyForMoreMediaData {
                    try Task.checkCancellation()
                    guard writer.status == .writing,ContinuousClock.now<deadline else { throw renderFailure("Processed camera writer stalled") }
                    try await Task.sleep(for:.milliseconds(2))
                }
                // Normalize orientation before person segmentation. The writer
                // stores this orientation directly and leaves transform identity.
                let image=CIImage(cvPixelBuffer:raw).transformed(by:transform)
                let normalized=image.transformed(by:CGAffineTransform(translationX:-image.extent.minX,y:-image.extent.minY))
                let oriented=try allocate()
                context.render(normalized,to:oriented,bounds:CGRect(x:0,y:0,width:width,height:height),colorSpace:CGColorSpaceCreateDeviceRGB())
                let processed=try await processor.process(oriented,at:time)
                try Task.checkCancellation()
                guard ["processed","no-person"].contains(processed.disposition),processed.presentationTime == time,
                      CVPixelBufferGetWidth(processed.pixelBuffer) == width,CVPixelBufferGetHeight(processed.pixelBuffer) == height else { throw renderFailure("Camera processor did not return a valid protected frame") }
                // Copy out of the bounded effect pool before encoder ownership.
                let encoded=try allocate()
                context.render(CIImage(cvPixelBuffer:processed.pixelBuffer),to:encoded,bounds:CGRect(x:0,y:0,width:width,height:height),colorSpace:CGColorSpaceCreateDeviceRGB())
                guard adaptor.append(encoded,withPresentationTime:time) else { throw renderFailure(writer.error?.localizedDescription ?? "Processed camera append failed") }
                frames += 1
            }
            guard reader.status == .completed,frames>0 else { throw renderFailure("Camera source did not decode to completion") }
            input.markAsFinished(); writer.endSession(atSourceTime:duration)
            try await finishWriting(writer, within: 90)
            try Task.checkCancellation()
            return (width,height,frames,duration.seconds*1000)
        } catch { processor.cancel(); reader.cancelReading(); writer.cancelWriting(); throw error }
    }
    private func allocate() throws -> CVPixelBuffer {
        guard let pool=adaptor.pixelBufferPool else { throw renderFailure("Processed camera buffer pool unavailable") }
        var buffer:CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil,pool,&buffer) == kCVReturnSuccess,let buffer else { throw renderFailure("Processed camera buffer allocation failed") }
        return buffer
    }
}
