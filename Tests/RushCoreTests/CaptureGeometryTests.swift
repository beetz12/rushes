import CoreGraphics
import Foundation
import Testing
@testable import RushCore

@Suite("Read-only capture source geometry")
struct CaptureGeometryTests {
    @Test("Display coordinates preserve negative origins and logical points")
    func display() throws {
        let request = SessionRequest(screen: .display(id: "display-7"), screenDimensions: .init(width: 2560, height: 1600))
        let geometry = try #require(CaptureGeometry.resolve(for: request, displayRect: { id in
            #expect(id == "display-7")
            return CGRect(x: -1280, y: -800, width: 1280, height: 800)
        }, windowRect: { _ in Issue.record("display must not query a window"); return nil }))
        #expect(geometry.rect == .init(x: -1280, y: -800, width: 1280, height: 800))
        #expect(geometry.displayID == "display-7")
        #expect(geometry.mode == "display")
        let data = try JSONEncoder().encode(geometry)
        #expect(try JSONDecoder().decode(CaptureGeometry.self, from: data) == geometry)
    }
    @Test("Area uses the exact preflight-selected global rectangle without enumeration")
    func area() throws {
        let rect = CaptureArea(x: -1100, y: 50, width: 400, height: 300)
        let geometry = try #require(CaptureGeometry.resolve(for: .init(screen: .area(displayID: "display-7", rect: rect)),
                                                           displayRect: { _ in Issue.record("area must not enumerate displays"); return nil },
                                                           windowRect: { _ in Issue.record("area must not enumerate windows"); return nil }))
        #expect(geometry.rect == rect)
        #expect(geometry.mode == "area")
        #expect(geometry.jsonValue["rect"]?["width"]?.double == 400)
    }
    @Test("Window bounds are fresh after moving and resizing; vanished windows return nil")
    func window() throws {
        let request = SessionRequest(screen: .window(id: "window-42"))
        let display: (String) -> CGRect? = { _ in Issue.record("window must not substitute a display"); return nil }
        let first = try #require(CaptureGeometry.resolve(for: request, displayRect: display,
                                                       windowRect: { _ in CGRect(x: 100, y: 200, width: 400, height: 300) }))
        let second = try #require(CaptureGeometry.resolve(for: request, displayRect: display,
                                                        windowRect: { _ in CGRect(x: 160, y: 240, width: 500, height: 320) }))
        #expect(first.rect != second.rect)
        #expect(second.rect == .init(x: 160, y: 240, width: 500, height: 320))
        #expect(second.mode == "window")
        #expect(second.displayID == nil)
        #expect(CaptureGeometry.resolve(for: request, displayRect: display, windowRect: { _ in nil }) == nil)
    }
    @Test("Camera-only and diagnostic geometry require no native metadata")
    func cameraAndSynthetic() {
        #expect(CaptureGeometry.resolve(for: .init(cameraId: "fixture"),
                                        displayRect: { _ in Issue.record("camera-only must not enumerate displays"); return nil },
                                        windowRect: { _ in Issue.record("camera-only must not enumerate windows"); return nil }) == nil)
        let synthetic = CaptureGeometry.synthetic(for: .init(screen: .window(id: "fixture-window"), screenDimensions: .init(width: 320, height: 240)))
        #expect(synthetic?.rect == .init(x: 0, y: 0, width: 320, height: 240))
    }
    @Test("Nonfinite and empty source bounds are not exposed on the wire")
    func invalidBounds() {
        let request = SessionRequest(screen: .window(id: "window-42"))
        for rect in [CGRect(x: CGFloat.infinity, y: 0, width: 100, height: 100), .zero] {
            #expect(CaptureGeometry.resolve(for: request, displayRect: { _ in nil }, windowRect: { _ in rect }) == nil)
        }
    }
}
