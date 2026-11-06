@preconcurrency import AVFoundation
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Turns a stretch of an already rendered edit into a looping GIF with ImageIO.
/// Frames come from the composed MP4, so every edit, layout and effect applies.
enum AnimatedGIFWriter {
    struct Output: Equatable { var data: Data; var width: Int; var height: Int; var frames: Int }

    /// Sample times, in milliseconds of the rendered edit, for one GIF frame each.
    static func frameTimes(startMs: Double, durationMs: Double, fps: Int) -> [Double] {
        let step = 1000 / Double(fps), count = max(1, Int((durationMs / step).rounded(.up)))
        return (0..<count).map { startMs + Double($0) * step }
    }

    /// Encodes the range, stepping the width down until the file fits `maxBytes`.
    static func encode(video: URL, startMs: Double, durationMs: Double, fps: Int, width: Int, maxBytes: Int) async throws -> Output {
        var target = width
        while true {
            try Task.checkCancellation()
            let output = try await encodeOnce(video: video, startMs: startMs, durationMs: durationMs, fps: fps, width: target)
            if output.data.count <= maxBytes { return output }
            let smaller = Int((Double(target) * 0.75).rounded(.down))
            guard smaller >= 160 else { throw ControlFailure(code: "gif-too-large", message: "This range makes a GIF over \(maxBytes / 1_048_576) MB; choose a shorter range") }
            target = smaller
        }
    }

    private static func encodeOnce(video: URL, startMs: Double, durationMs: Double, fps: Int, width: Int) async throws -> Output {
        let asset = AVURLAsset(url: video)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw renderFailure("Rendered edit has no video for the GIF") }
        let natural = try await track.load(.naturalSize)
        guard natural.width > 0, natural.height > 0 else { throw renderFailure("Rendered edit has no picture size") }
        // Never upscale; keep even dimensions for predictable palettes and scaling.
        let outWidth = max(2, min(width, Int(natural.width)) & ~1)
        let outHeight = max(2, Int((Double(outWidth) * Double(natural.height) / Double(natural.width)).rounded()) & ~1)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: outWidth, height: outHeight)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 60)
        let times = frameTimes(startMs: startMs, durationMs: durationMs, fps: fps)
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, times.count, nil) else { throw renderFailure("Cannot create GIF encoder") }
        // Loop count 0 asks players to repeat forever.
        CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFLoopCount: 0]] as CFDictionary)
        let delay = 1 / Double(fps)
        let frameProperties = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay, kCGImagePropertyGIFUnclampedDelayTime: delay]] as CFDictionary
        for ms in times {
            try Task.checkCancellation()
            let image = try await generator.image(at: CMTime(seconds: ms / 1000, preferredTimescale: 600_000)).image
            CGImageDestinationAddImage(destination, try fitted(image, width: outWidth, height: outHeight), frameProperties)
        }
        guard CGImageDestinationFinalize(destination) else { throw renderFailure("GIF encoding failed") }
        return Output(data: data as Data, width: outWidth, height: outHeight, frames: times.count)
    }

    /// Draws the frame into an exact canvas so every GIF frame shares one size.
    private static func fitted(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
        if image.width == width && image.height == height { return image }
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { throw renderFailure("Cannot scale GIF frame") }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { throw renderFailure("Cannot scale GIF frame") }
        return scaled
    }
}
