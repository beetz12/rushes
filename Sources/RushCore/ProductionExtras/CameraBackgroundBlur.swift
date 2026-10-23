import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Synchronization
import Vision

public struct CameraBlurFrame: @unchecked Sendable {
    public let pixelBuffer: CVPixelBuffer
    public let presentationTime: CMTime
    public let personDetected: Bool
    public let foregroundCoverage: Double
    public let processingMs: Double
    public let disposition: String
    public let errorCode: String?
    public let message: String?
}
private struct OwnedBlurInput: @unchecked Sendable {
    let pixelBuffer: CVPixelBuffer
    let time: CMTime
}

/// Optional camera effect operating on caller-provided frames only. No camera session is created.
public final class CameraBackgroundBlur: @unchecked Sendable {
    public typealias Completion = @Sendable (CameraBlurFrame) -> Void
    private let radius: Double
    private let queue = DispatchQueue(label: "rushes.camera.background-blur", qos: .utility)
    private let lock = NSLock()
    private var busy = false
    private var cancelled = false
    private var processed = 0
    private let dropped = Atomic<Int>(0)
    private let context: CIContext
    private var pool: CVPixelBufferPool?
    private var poolWidth = 0
    private var poolHeight = 0
    public init(radius: Double = 18) throws {
        guard radius.isFinite, (1...80).contains(radius) else {
            throw ControlFailure(code: "invalid-params", message: "Background blur radius must be 1–80 pixels.")
        }
        self.radius = radius
        context = CIContext(options: [.cacheIntermediates: false])
    }

    /// For capture: returns immediately. false means caller must account for/fallback from a skipped optional effect.
    @discardableResult public func submit(_ pixelBuffer: CVPixelBuffer, at time: CMTime, completion: @escaping Completion) -> Bool {
        guard claimWork() else { return false }
        let input = OwnedBlurInput(pixelBuffer: pixelBuffer, time: time)
        queue.async { [self, input] in
            let result = render(input.pixelBuffer, at: input.time)
            completeWork(); completion(result)
        }
        return true
    }

    /// Explicit synchronous fixture/offline API. Do not call on a real-time capture callback.
    public func process(_ pixelBuffer: CVPixelBuffer, at time: CMTime) -> CameraBlurFrame {
        guard claimWork() else { return fallback(pixelBuffer, time: time, disposition: "busy", code: nil, message: "The bounded blur worker is busy or disabled.") }
        defer { completeWork() }
        return render(pixelBuffer, at: time)
    }
    public func cancel() { lock.withLock { cancelled = true } }
    public func statistics() -> (processed: Int, dropped: Int, busy: Bool) {
        lock.withLock { (processed, dropped.load(ordering: .relaxed), busy) }
    }
    private func claimWork() -> Bool {
        guard lock.try() else { dropped.wrappingAdd(1, ordering: .relaxed); return false }
        defer { lock.unlock() }
        guard !busy, !cancelled else { dropped.wrappingAdd(1, ordering: .relaxed); return false }
        busy = true; return true
    }
    private func completeWork() { lock.withLock { busy = false; processed += 1 } }
    private func fallback(_ buffer: CVPixelBuffer, time: CMTime, disposition: String, code: String?, message: String?) -> CameraBlurFrame {
        .init(pixelBuffer: buffer, presentationTime: time, personDetected: false, foregroundCoverage: 0,
              processingMs: 0, disposition: disposition, errorCode: code, message: message)
    }
    private func render(_ buffer: CVPixelBuffer, at time: CMTime) -> CameraBlurFrame {
        guard !lock.withLock({ cancelled }) else { return fallback(buffer, time: time, disposition: "cancelled", code: nil, message: nil) }
        let start = Date()
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        guard CMTimeGetSeconds(time).isFinite, CMTimeGetSeconds(time) >= 0 else {
            return fallback(buffer, time: time, disposition: "failed", code: "blur-frame-time", message: "A valid nonnegative source timestamp is required.")
        }
        guard width > 0, height > 0, width <= 4096, height <= 4096 else {
            return fallback(buffer, time: time, disposition: "failed", code: "blur-frame-size", message: "Background blur supports camera frames up to 4096 pixels per side.")
        }
        do {
            // A new request avoids retaining a person matte across unrelated fixture/scene changes.
            let request = VNGeneratePersonSegmentationRequest()
            request.qualityLevel = .balanced
            request.outputPixelFormat = kCVPixelFormatType_OneComponent8
            try VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .up, options: [:]).perform([request])
            let source = CIImage(cvPixelBuffer: buffer)
            let extent = CGRect(x: 0, y: 0, width: width, height: height)
            let blurred = source.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: radius]).cropped(to: extent)
            var mask = CIImage(color: CIColor(red: 0, green: 0, blue: 0)).cropped(to: extent)
            var coverage = 0.0
            if let matte = request.results?.first?.pixelBuffer {
                coverage = try foregroundCoverage(matte)
                if coverage >= 0.002 {
                    let matteImage = CIImage(cvPixelBuffer: matte)
                    mask = matteImage.transformed(by: CGAffineTransform(scaleX: CGFloat(width) / matteImage.extent.width,
                                                                     y: CGFloat(height) / matteImage.extent.height)).cropped(to: extent)
                }
            }
            let personDetected = coverage >= 0.002
            let image = source.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: blurred, kCIInputMaskImageKey: mask])
            let output = try allocate(width: width, height: height)
            context.render(image, to: output, bounds: extent, colorSpace: CGColorSpaceCreateDeviceRGB())
            guard !lock.withLock({ cancelled }) else { return fallback(buffer, time: time, disposition: "cancelled", code: nil, message: nil) }
            return .init(pixelBuffer: output, presentationTime: time, personDetected: personDetected,
                         foregroundCoverage: coverage, processingMs: Date().timeIntervalSince(start) * 1000,
                         disposition: personDetected ? "processed" : "no-person", errorCode: nil, message: nil)
        } catch {
            return fallback(buffer, time: time, disposition: "failed", code: (error as? ControlFailure)?.payload.code ?? "blur-processing-failed", message: (error as? ControlFailure)?.payload.message ?? error.localizedDescription)
        }
    }
    private func foregroundCoverage(_ buffer: CVPixelBuffer) throws -> Double {
        guard CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_OneComponent8,
              CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { throw ControlFailure(code: "blur-mask-format") }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else { throw ControlFailure(code: "blur-mask-buffer") }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
        var foreground = 0
        for y in 0..<height { for x in 0..<width where base[y * stride + x] >= 128 { foreground += 1 } }
        return Double(foreground) / Double(width * height)
    }
    private func allocate(width: Int, height: Int) throws -> CVPixelBuffer {
        if pool == nil || poolWidth != width || poolHeight != height {
            let attributes: [CFString: Any] = [kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey: true]
            let status = CVPixelBufferPoolCreate(kCFAllocatorDefault, [kCVPixelBufferPoolMinimumBufferCountKey: 2] as CFDictionary,
                                                 attributes as CFDictionary, &pool)
            guard status == kCVReturnSuccess else { throw ControlFailure(code: "blur-pool-allocation", message: "Cannot allocate the bounded camera effect pool.") }
            poolWidth = width; poolHeight = height
        }
        guard let pool else { throw ControlFailure(code: "blur-pool-allocation") }
        var output: CVPixelBuffer?
        let status = CVPixelBufferPoolCreatePixelBufferWithAuxAttributes(kCFAllocatorDefault, pool,
            [kCVPixelBufferPoolAllocationThresholdKey: 3] as CFDictionary, &output)
        guard status == kCVReturnSuccess, let output else {
            throw ControlFailure(code: "blur-pool-busy", message: "Three processed camera buffers are still retained; skipped optional blur for this frame.")
        }
        return output
    }
}
