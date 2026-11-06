@preconcurrency import AVFoundation
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import RushCore

/// Decoded GIF facts and RGBA pixels, read back with ImageIO.
private struct DecodedGIF {
    var type: String
    var count: Int
    var loopCount: Int?
    var delays: [Double]
    var width: Int
    var height: Int
    var frames: [[UInt8]]
    init(_ url: URL) throws {
        let source = try #require(CGImageSourceCreateWithURL(url as CFURL, nil))
        type = (CGImageSourceGetType(source) as String?) ?? ""
        count = CGImageSourceGetCount(source)
        let properties = CGImageSourceCopyProperties(source, nil) as? [CFString: Any]
        loopCount = (properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any])?[kCGImagePropertyGIFLoopCount] as? Int
        var delays: [Double] = [], frames: [[UInt8]] = [], width = 0, height = 0
        for index in 0..<count {
            let frame = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let gif = frame?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            delays.append((gif?[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? (gif?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0)
            let image = try #require(CGImageSourceCreateImageAtIndex(source, index, nil))
            width = image.width; height = image.height
            frames.append(try rgba(image))
        }
        self.delays = delays; self.frames = frames; self.width = width; self.height = height
    }
}

private func rgba(_ image: CGImage) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let ok = bytes.withUnsafeMutableBytes { memory -> Bool in
        guard let context = CGContext(data: memory.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height)); return true
    }
    guard ok else { throw renderFailure("Test decode context") }
    return bytes
}

private func posterImage(_ path: String) throws -> CGImage {
    let source = try #require(CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil))
    return try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
}

/// Center pixel (R, G, B) of an RGBA buffer.
private func center(_ data: [UInt8], width: Int, height: Int) -> (Int, Int, Int) {
    let i = ((height / 2) * width + width / 2) * 4
    return (Int(data[i]), Int(data[i + 1]), Int(data[i + 2]))
}

@Suite("GIF export and share poster", .serialized)
struct GIFExportAndPosterTests {
    private func screenOnly(_ service: PostproductionService, _ fixture: SyntheticExportFixture, poster: Double? = nil) async throws {
        var edit = try await service.getEdit(id: fixture.package.id)
        edit.layout.preset = .screenOnly; edit.meta.posterMs = poster
        _ = try await service.setEdit(id: fixture.package.id, edit: edit)
    }

    @Test func gifIsValidLoopingBoundedAndCached() async throws {
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let hashes = try fixture.hashes(), service = PostproductionService(root: fixture.root)
        try await screenOnly(service, fixture)
        let output = fixture.root.appendingPathComponent("clip.gif")
        let result = try await service.export(id: fixture.package.id, options: ExportOptions(preset: .gif), to: output)
        #expect(result.preset == "gif" && !result.cached && result.fps == 10)
        // Default 5 s range clamps to the 2 s edit: 20 frames at 10 fps.
        #expect(result.durationMs == 2000)
        let gif = try DecodedGIF(output)
        #expect(gif.type == UTType.gif.identifier)
        #expect(gif.count == 20)
        #expect(gif.loopCount == 0)
        #expect(gif.delays.allSatisfy { abs($0 - 0.1) < 0.011 })
        // Never upscaled past the 320 px render; always within the 640 px bound.
        #expect(gif.width == 320 && gif.height == 180 && result.width == 320 && result.height == 180)
        #expect(try Data(contentsOf: output).count <= ExportOptions.gifMaxBytes)
        // Source is blue for the first second and green for the second.
        let early = center(gif.frames[2], width: gif.width, height: gif.height), late = center(gif.frames[15], width: gif.width, height: gif.height)
        #expect(early.2 > 150 && early.1 < 80)
        #expect(late.1 > 150 && late.2 < 80)
        let again = try await service.export(id: fixture.package.id, options: ExportOptions(preset: .gif), to: fixture.root.appendingPathComponent("again.gif"))
        #expect(again.cached && again.cacheKey == result.cacheKey)
        #expect(try Data(contentsOf: fixture.root.appendingPathComponent("again.gif")) == Data(contentsOf: output))
        #expect(try fixture.hashes() == hashes)
    }

    @Test func gifRangeFpsAndCommandParams() async throws {
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service = PostproductionService(root: fixture.root)
        try await screenOnly(service, fixture)
        let output = fixture.root.appendingPathComponent("range.gif")
        let value = try await service.handle(ControlRequest(id: "1", cmd: "export", args: .object([
            "id": .string(fixture.package.id), "preset": .string("gif"), "path": .string(output.path),
            "startMs": .double(1000), "endMs": .double(1500), "fps": .int(12), "width": .int(240)])))
        #expect(value["fps"]?.int == 12 && value["width"]?.int == 240 && value["height"]?.int == 134)
        let gif = try DecodedGIF(output)
        #expect(gif.count == 6 && gif.loopCount == 0 && gif.width == 240)
        let first = center(gif.frames[0], width: gif.width, height: gif.height)
        #expect(first.1 > 150 && first.2 < 80)
    }

    @Test func gifEncodingIsDeterministic() async throws {
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service = PostproductionService(root: fixture.root)
        let video = fixture.root.appendingPathComponent("edit.mp4")
        _ = try await service.export(id: fixture.package.id, to: video)
        let one = try await AnimatedGIFWriter.encode(video: video, startMs: 0, durationMs: 1000, fps: 10, width: 480, maxBytes: ExportOptions.gifMaxBytes)
        let two = try await AnimatedGIFWriter.encode(video: video, startMs: 0, durationMs: 1000, fps: 10, width: 480, maxBytes: ExportOptions.gifMaxBytes)
        #expect(one == two && one.frames == 10)
        // A tight size bound steps the width down instead of failing outright.
        let small = try await AnimatedGIFWriter.encode(video: video, startMs: 0, durationMs: 1000, fps: 10, width: 320, maxBytes: one.data.count - 1)
        #expect(small.width < 320 && small.data.count < one.data.count)
    }

    @Test func gifOptionsValidateAndRangesClamp() throws {
        #expect(throws: ControlFailure.self) { try ExportOptions(preset: .gif, fps: 30).validate() }
        #expect(throws: ControlFailure.self) { try ExportOptions(preset: .gif, gifWidth: 800).validate() }
        #expect(throws: ControlFailure.self) { try ExportOptions(preset: .gif, gifDurationMs: 20_000).validate() }
        #expect(throws: ControlFailure.self) { try ExportOptions(preset: .gif, container: "mp4").validate() }
        try ExportOptions(preset: .gif, fps: 12, gifStartMs: 0, gifDurationMs: 15_000, gifWidth: 640).validate()
        // Non-GIF presets ignore GIF fields so their cache keys stay unchanged.
        #expect(ExportOptions(preset: .share, gifWidth: 480).gifWidth == nil)
        #expect(try ControlWire.encoder.encode(ExportOptions()) == ControlWire.encoder.encode(ExportOptions(gifStartMs: 5)))
        let defaults = PostproductionService.gifRange(options: ExportOptions(preset: .gif), editDurationMs: 60_000)
        #expect(defaults.startMs == 0 && defaults.durationMs == 5_000)
        let late = PostproductionService.gifRange(options: ExportOptions(preset: .gif, gifStartMs: 9_000, gifDurationMs: 5_000), editDurationMs: 10_000)
        #expect(late.startMs == 9_000 && late.durationMs == 1_000)
        let beyond = PostproductionService.gifRange(options: ExportOptions(preset: .gif, gifStartMs: 50_000), editDurationMs: 10_000)
        #expect(beyond.startMs == 9_900 && beyond.durationMs == 100)
        #expect(AnimatedGIFWriter.frameTimes(startMs: 100, durationMs: 500, fps: 10) == [100, 200, 300, 400, 500])
    }

    @Test func posterTimeDefaultsChosenAndClamped() throws {
        var edit = EditDocument(durationMs: 2000)
        #expect(edit.posterTimeMs == 0)
        edit.meta.posterMs = 700
        #expect(edit.posterTimeMs == 700)
        edit.meta.posterMs = 99_999
        #expect(abs(edit.posterTimeMs - (2000 - 1000.0 / 30)) < 0.001)
        edit.meta.posterMs = -5
        #expect(edit.posterTimeMs == 0)
        edit.clips = [EditClip(id: "a", sourceStartMs: 0, sourceEndMs: 600)]
        edit.meta.posterMs = 1500
        #expect(abs(edit.posterTimeMs - (600 - 1000.0 / 30)) < 0.001)
        // Unset posters are omitted, so older documents and caches are unchanged.
        let unset = try String(decoding: ControlWire.encoder.encode(EditDocument(durationMs: 2000)), as: UTF8.self)
        #expect(!unset.contains("posterMs"))
        var chosen = EditDocument(durationMs: 2000); chosen.meta.posterMs = 1200
        let decoded = try JSONDecoder().decode(EditDocument.self, from: ControlWire.encoder.encode(chosen))
        #expect(decoded.meta.posterMs == 1200)
    }

    @Test func sharePosterUsesChosenFrameWithoutRerendering() async throws {
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service = PostproductionService(root: fixture.root), shares = ShareAssetsService(root: fixture.root, postproduction: service)
        try await screenOnly(service, fixture)
        let first = try await shares.assets(id: fixture.package.id)
        let firstPoster = try posterImage(first.posterPath)
        let blue = center(try rgba(firstPoster), width: firstPoster.width, height: firstPoster.height)
        #expect(blue.2 > 150 && blue.1 < 80)
        // Choose a frame in the green second via the engine command.
        _ = try await service.handle(ControlRequest(id: "2", cmd: "edit.set", args: .object(["id": .string(fixture.package.id), "posterMs": .double(1500)])))
        let chosen = try await shares.assets(id: fixture.package.id)
        #expect(chosen.cacheKey != first.cacheKey)
        #expect(chosen.videoSHA256 == first.videoSHA256)
        let image = try posterImage(chosen.posterPath)
        let green = center(try rgba(image), width: image.width, height: image.height)
        #expect(image.width == 1280 && green.1 > 150 && green.2 < 80)
        // Beyond the edit clamps to the last frame instead of failing.
        _ = try await service.handle(ControlRequest(id: "3", cmd: "edit.set", args: .object(["id": .string(fixture.package.id), "posterMs": .double(60_000)])))
        let clamped = try await shares.assets(id: fixture.package.id)
        let last = try posterImage(clamped.posterPath)
        #expect(center(try rgba(last), width: last.width, height: last.height).1 > 150)
        // Null restores the first-frame default.
        let reset = try await service.handle(ControlRequest(id: "4", cmd: "edit.set", args: .object(["id": .string(fixture.package.id), "posterMs": .null])))
        #expect(reset["meta"]?["posterMs"] == nil)
        let restored = try await shares.assets(id: fixture.package.id)
        let again = try posterImage(restored.posterPath)
        #expect(center(try rgba(again), width: again.width, height: again.height).2 > 150)
        // The poster never invalidates the rendered video cache.
        let video = try await service.export(id: fixture.package.id, to: fixture.root.appendingPathComponent("v.mp4"))
        #expect(video.cached)
    }

    @Test func shareAssetsIncludeLoopingPreviewGIF() async throws {
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service = PostproductionService(root: fixture.root), shares = ShareAssetsService(root: fixture.root, postproduction: service)
        try await screenOnly(service, fixture)
        let first = try await shares.assets(id: fixture.package.id)
        let path = try #require(first.previewPath)
        #expect(URL(fileURLWithPath: path).deletingLastPathComponent().path == URL(fileURLWithPath: first.videoPath).deletingLastPathComponent().path)
        let gif = try DecodedGIF(URL(fileURLWithPath: path))
        // The 2 s edit is shorter than the 3 s preview: 20 frames at 10 fps, looping.
        #expect(gif.type == UTType.gif.identifier && gif.count == 20 && gif.loopCount == 0 && gif.width <= ShareAssetsResult.previewWidth)
        #expect(try Data(contentsOf: URL(fileURLWithPath: path)).count <= ShareAssetsResult.previewMaxBytes)
        let cached = try await shares.assets(id: fixture.package.id)
        #expect(cached.cached && cached.previewPath == path)
        // Enrichment of a published generation carries its preview along.
        _ = try await service.handle(ControlRequest(id: "5", cmd: "edit.set", args: .object(["id": .string(fixture.package.id), "title": .string("Renamed")])))
        let enriched = try await shares.assets(id: fixture.package.id, editSnapshot: first.editSnapshot, publishedVideoPath: first.videoPath)
        let carried = try #require(enriched.previewPath)
        #expect(try Data(contentsOf: URL(fileURLWithPath: carried)) == Data(contentsOf: URL(fileURLWithPath: path)))
        // Stamps written before previews existed still decode.
        var legacy = try JSONDecoder().decode(JSONValue.self, from: ControlWire.encoder.encode(first)).object!
        legacy.removeValue(forKey: "previewPath")
        #expect(try JSONDecoder().decode(ShareAssetsResult.self, from: ControlWire.encoder.encode(JSONValue.object(legacy))).previewPath == nil)
    }
}
