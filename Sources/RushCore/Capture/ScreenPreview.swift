import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

internal struct ScreenPreviewImage: Sendable {
    static let maximumJPEGBytes = 262_144
    let jpeg: Data
    let width: Int
    let height: Int

    func validated() throws -> Self {
        guard !jpeg.isEmpty, jpeg.count <= Self.maximumJPEGBytes,
              (1...640).contains(width), (1...640).contains(height) else {
            throw ControlFailure(code: "preview-too-large", message: "The screen preview exceeded its memory limit.")
        }
        return self
    }

    static func encode(_ image: CGImage) throws -> Self {
        guard image.width <= 640, image.height <= 640 else {
            throw ControlFailure(code: "preview-too-large", message: "The screen preview exceeded its dimensions.")
        }
        let bytes = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(bytes, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw ControlFailure(code: "preview-unavailable", message: "The screen preview could not be encoded.")
        }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.65] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ControlFailure(code: "preview-unavailable", message: "The screen preview could not be encoded.")
        }
        return try Self(jpeg: bytes as Data, width: image.width, height: image.height).validated()
    }
}

/// Pure production geometry, also used for generated surfaces and unit tests.
internal struct ScreenPreviewGeometry: Equatable, Sendable {
    var width: Int
    var height: Int
    var sourceRect: CGRect?

    static func make(surface: ScreenSurface, displayFrame: CGRect, windowFrame: CGRect?,
                     windowBundleID: String?, excluding: [String]) throws -> Self {
        let bounds: CGRect
        var crop: CGRect?
        switch surface {
        case .display: bounds = displayFrame
        case .window:
            guard let windowFrame, !excluding.contains(windowBundleID ?? "") else {
                throw ControlFailure(code: "source-unavailable", message: "Choose an available window outside Rushes.")
            }
            bounds = windowFrame
        case .area(_, let selected):
            guard [selected.minX, selected.minY, selected.width, selected.height].allSatisfy(\.isFinite),
                  selected.width > 0, selected.height > 0,
                  let clamped = AreaRectMath.clamp(selected, toDisplay: displayFrame) else {
                throw ControlFailure(code: "invalid-area", message: "The selected area is outside its display.")
            }
            bounds = clamped
            crop = clamped.offsetBy(dx: -displayFrame.minX, dy: -displayFrame.minY)
        }
        guard bounds.width.isFinite, bounds.height.isFinite, bounds.width > 0, bounds.height > 0 else {
            throw ControlFailure(code: "source-unavailable", message: "The selected source has no visible area.")
        }
        let scale = min(1, 640 / max(bounds.width, bounds.height))
        return .init(width: max(1, Int((bounds.width * scale).rounded())),
                     height: max(1, Int((bounds.height * scale).rounded())), sourceRect: crop)
    }
}

internal enum NativeScreenPreview {
    static func snapshot(surface: ScreenSurface, excluding: [String]) async throws -> ScreenPreviewImage {
        let resolved = try await SystemScreenContentResolver().resolve(surface: surface, excludingBundleIDs: excluding)
        let geometry = try ScreenPreviewGeometry.make(surface: surface, displayFrame: resolved.displayFrame,
            windowFrame: resolved.window?.frame, windowBundleID: resolved.window?.owningApplication?.bundleIdentifier,
            excluding: excluding)
        let filter = ScreenSource.makeFilter(resolved: resolved, surface: surface)
        let configuration = SCStreamConfiguration()
        configuration.width = geometry.width; configuration.height = geometry.height
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false; configuration.capturesAudio = false
        configuration.captureMicrophone = false; configuration.excludesCurrentProcessAudio = true
        if let crop = geometry.sourceRect { configuration.sourceRect = crop }
        let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        return try ScreenPreviewImage.encode(image)
    }

    /// Only the explicit generated-capture mode uses this image source.
    static func generated(surface: ScreenSurface) throws -> ScreenPreviewImage {
        let geometry = try ScreenPreviewGeometry.make(surface: surface,
            displayFrame: CGRect(x: 0, y: 0, width: 640, height: 480),
            windowFrame: CGRect(x: 80, y: 80, width: 320, height: 240),
            windowBundleID: "generated.example", excluding: [])
        guard let context = CGContext(data: nil, width: geometry.width, height: geometry.height,
            bitsPerComponent: 8, bytesPerRow: geometry.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else {
            throw ControlFailure(code: "preview-unavailable")
        }
        switch surface {
        case .display: context.setFillColor(CGColor(red: 0.12, green: 0.48, blue: 0.42, alpha: 1))
        case .window: context.setFillColor(CGColor(red: 0.15, green: 0.3, blue: 0.7, alpha: 1))
        case .area: context.setFillColor(CGColor(red: 0.8, green: 0.35, blue: 0.12, alpha: 1))
        }
        context.fill(CGRect(x: 0, y: 0, width: geometry.width, height: geometry.height))
        guard let image = context.makeImage() else { throw ControlFailure(code: "preview-unavailable") }
        return try ScreenPreviewImage.encode(image)
    }
}
