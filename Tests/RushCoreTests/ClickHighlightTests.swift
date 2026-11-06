@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import RushCore

/// Generated media only: a synthetic screen track and a hand-written input log.
@Suite("Click highlight", .serialized)
struct ClickHighlightTests {
    /// Mean absolute RGB difference in a square around (x, y).
    private func difference(_ a: (width: Int, height: Int, data: [UInt8]), _ b: (width: Int, height: Int, data: [UInt8]), x: Int, y: Int, half: Int) -> Double {
        var total = 0, count = 0
        for row in max(0, y - half)..<min(a.height, y + half) {
            for column in max(0, x - half)..<min(a.width, x + half) {
                let index = (row * a.width + column) * 4
                for channel in 0..<3 { total += abs(Int(a.data[index + channel]) - Int(b.data[index + channel])) }
                count += 3
            }
        }
        return Double(total) / Double(max(1, count))
    }

    @Test func ringAppearsAtTheClickThenFadesAndIsOffByDefault() async throws {
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let hashes = try fixture.hashes(), service = PostproductionService(root: fixture.root)
        try AtomicFileWriter.write(Data("""
            {"t":0,"k":"move","x":0.5,"y":0.5}
            {"t":900,"k":"move","x":0.25,"y":0.5}
            {"t":1000,"k":"down","x":0.25,"y":0.5,"b":0}
            {"t":1080,"k":"up","x":0.25,"y":0.5,"b":0}

            """.utf8), to: fixture.package.inputURL)
        var edit = try await service.getEdit(id: fixture.package.id)
        edit.layout.preset = .screenOnly
        _ = try await service.setEdit(id: fixture.package.id, edit: edit)
        #expect(!String(decoding: try ControlWire.encoder.encode(edit), as: UTF8.self).contains("clickHighlight"))
        let plainURL = fixture.root.appendingPathComponent("plain.mp4")
        let plain = try await service.export(id: fixture.package.id, to: plainURL)

        edit = try await service.getEdit(id: fixture.package.id)
        edit.clickHighlight = true
        _ = try await service.setEdit(id: fixture.package.id, edit: edit)
        let ringURL = fixture.root.appendingPathComponent("ring.mp4")
        let ring = try await service.export(id: fixture.package.id, to: ringURL)
        #expect(ring.cacheKey != plain.cacheKey && !ring.cached)

        let shortlyAfter = (try await SyntheticExportFixture.pixels(plainURL, at: 1.1), try await SyntheticExportFixture.pixels(ringURL, at: 1.1))
        let width = shortlyAfter.0.width, height = shortlyAfter.0.height
        let clickX = width / 4, clickY = height / 2
        let near = difference(shortlyAfter.0, shortlyAfter.1, x: clickX, y: clickY, half: 16)
        let far = difference(shortlyAfter.0, shortlyAfter.1, x: width * 3 / 4, y: clickY, half: 16)
        #expect(near > 8)
        #expect(far < 2)

        // The ring lives 600 ms; 800 ms after the click the frames match again.
        let later = (try await SyntheticExportFixture.pixels(plainURL, at: 1.8), try await SyntheticExportFixture.pixels(ringURL, at: 1.8))
        #expect(difference(later.0, later.1, x: clickX, y: clickY, half: 16) < 2)
        // Before the click there is no ring either.
        let before = (try await SyntheticExportFixture.pixels(plainURL, at: 0.5), try await SyntheticExportFixture.pixels(ringURL, at: 0.5))
        #expect(difference(before.0, before.1, x: clickX, y: clickY, half: 16) < 2)
        #expect(try fixture.hashes() == hashes)
    }

    @Test func ringLifetimeAndSizeAreBounded() {
        #expect(ClickHighlight.ring(ageMs: -1, canvasWidth: 1920) == nil)
        #expect(ClickHighlight.ring(ageMs: 600, canvasWidth: 1920) == nil)
        let early = ClickHighlight.ring(ageMs: 0, canvasWidth: 1920), late = ClickHighlight.ring(ageMs: 590, canvasWidth: 1920)
        #expect((early?.width ?? 0) > 0 && (late?.width ?? 0) > (early?.width ?? 0))
        #expect((late?.width ?? 0) < 1920 / 10)
    }
}
