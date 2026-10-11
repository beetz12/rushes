@preconcurrency import AVFoundation
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// A poster uses the exact rendered video, including every applied edit.
enum CompositionThumbnail {
    static func write(video:URL,to output:URL,atMs:Double,width:Int,height:Int) async throws {
        let generator=AVAssetImageGenerator(asset:AVURLAsset(url:video)); generator.appliesPreferredTrackTransform=true
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
    }
}
