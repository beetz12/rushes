import Foundation
import Testing
@testable import RushCore

@Suite("Drawing inclusion without UI")
struct DrawingInclusionTests {
    private func window(_ id: String = "window-42", title: String = "Rushes Drawing", owner: String = "ai.rushes.app") -> WindowSource {
        .init(id: id, title: title, owningApplication: owner, displayID: "display-1")
    }
    @Test("Only the exact dedicated window and shell identity can be excepted")
    func allowedAndRejected() throws {
        #expect(try DrawingCaptureInclusion.validate(windowID: "window-42", windows: [window()], shellBundleID: "ai.rushes.app", mode: "display") == 42)
        for (id, title, owner, mode) in [("window-42","Rushes Bar","ai.rushes.app","display"), ("window-42","Rushes Drawing","other.app","display"), ("window-42","Rushes Drawing","ai.rushes.app","window"), ("window-042","Rushes Drawing","ai.rushes.app","area")] {
            #expect(throws: ControlFailure.self) { try DrawingCaptureInclusion.validate(windowID: id, windows: [window(id,title: title,owner: owner)], shellBundleID: "ai.rushes.app", mode: mode) }
        }
        #expect(throws: ControlFailure.self) { try DrawingCaptureInclusion.validate(windowID: "window-42", windows: [window()], shellBundleID: nil, mode: "area") }
    }
    @Test("Show/hide changes inclusion state without any window or device")
    func state() async throws {
        let service = DrawingCaptureInclusion()
        #expect(try await service.show(windowID: "window-42", windows: [window()], shellBundleID: "ai.rushes.app", mode: "area").enabled)
        #expect(await service.hide().enabled == false)
    }
    @Test("Idle drawing requests never enumerate native content")
    func idleSource() async throws {
        struct Resolver: ScreenSource.ContentResolving {
            func resolve(surface: ScreenSurface, excludingBundleIDs: [String]) async throws -> ScreenSource.ResolvedContent {
                Issue.record("idle drawing must not enumerate native content")
                throw ScreenSourceError.sourceUnavailable("fixture")
            }
        }
        let source = ScreenSource(plan: .init(width: 100, height: 100, capturesSystemAudio: false,
                                            excludesOwnProcessAudio: true, capturesMicrophone: false),
                                  resolver: Resolver(), onStreamFailure: { _ in })
        await #expect(throws: ControlFailure.self) { try await source.setDrawingWindow(windowID: "window-42") }
        await #expect(throws: ControlFailure.self) { try await source.setDrawingWindow(windowID: nil) }
    }
}

private final class TrashTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = Date(timeIntervalSince1970: 1_000)
    func now() -> Date { lock.withLock { instant } }
    func advance(_ seconds: Double) { lock.withLock { instant = instant.addingTimeInterval(seconds) } }
}
private struct ScratchTrashMover: RecordingTrashMoving {
    let root: URL
    func moveToTrash(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let target = root.appendingPathComponent(UUID().uuidString)
        try FileManager.default.moveItem(at: url, to: target)
        return target
    }
    func restore(_ trashedURL: URL, to originalURL: URL) throws { try FileManager.default.moveItem(at: trashedURL, to: originalURL) }
}

@Suite("Five-second library Trash (owned fixtures only)")
struct RecordingTrashTests {
    private func fixture() throws -> (URL, RecordingPackage, RecordingTrashService, TrashTestClock) {
        let scratch = FileManager.default.temporaryDirectory.appendingPathComponent("trash-fixture-\(UUID().uuidString)")
        let root = scratch.appendingPathComponent("recordings")
        let package = try RecordingPackage.create(root: root)
        try package.writeManifest(.init(id: package.id, status: .complete))
        try Data("owned fixture footage".utf8).write(to: package.trackURL(for: .screen))
        let clock = TrashTestClock()
        let service = RecordingTrashService(root: root, mover: ScratchTrashMover(root: scratch.appendingPathComponent("scratch-trash")), now: { clock.now() })
        return (scratch,package,service,clock)
    }
    @Test("Package and bytes survive move and timely undo")
    func undo() async throws {
        let (scratch,package,service,clock) = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let receipt = try await service.trash(id: package.id)
        #expect(receipt.undoWindowMs == 5000)
        #expect(!FileManager.default.fileExists(atPath: package.folderURL.path))
        clock.advance(4.999)
        #expect(try await service.undo(token: receipt.undoToken) == package.id)
        #expect(try String(contentsOf: package.trackURL(for: .screen), encoding: .utf8) == "owned fixture footage")
    }
    @Test("Expiry never deletes footage and active packages never move")
    func expiredAndActive() async throws {
        let (scratch,package,service,clock) = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        await #expect(throws: ControlFailure.self) { try await service.trash(id: package.id, activeRecordingID: package.id) }
        let receipt = try await service.trash(id: package.id)
        clock.advance(5)
        await #expect(throws: ControlFailure.self) { try await service.undo(token: receipt.undoToken) }
        #expect(FileManager.default.fileExists(atPath: receipt.trashedPath))
    }
    @Test("Undo refuses collisions rather than overwriting the replacement")
    func collision() async throws {
        let (scratch,package,service,_) = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let receipt = try await service.trash(id: package.id)
        try FileManager.default.createDirectory(at: package.folderURL, withIntermediateDirectories: false)
        await #expect(throws: ControlFailure.self) { try await service.undo(token: receipt.undoToken) }
        #expect(FileManager.default.fileExists(atPath: receipt.trashedPath))
        #expect(FileManager.default.fileExists(atPath: package.folderURL.path))
    }
    @Test("Interrupted packages and symlink escapes do not move")
    func unsafeAndInterrupted() async throws {
        let (scratch,package,service,_) = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        try package.writeManifest(.init(id: package.id, status: .recording))
        await #expect(throws: ControlFailure.self) { try await service.trash(id: package.id) }
        let outside = scratch.appendingPathComponent("outside")
        try FileManager.default.moveItem(at: package.folderURL, to: outside)
        try FileManager.default.createSymbolicLink(at: package.folderURL, withDestinationURL: outside)
        await #expect(throws: ControlFailure.self) { try await service.trash(id: package.id) }
        #expect(FileManager.default.fileExists(atPath: outside.appendingPathComponent("screen.mov").path))
    }
    @Test("Undo refuses replaced Trash items and dangling original links")
    func replacedPaths() async throws {
        let (scratch,package,service,_) = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let receipt = try await service.trash(id: package.id)
        let held = scratch.appendingPathComponent("held-footage")
        try FileManager.default.moveItem(atPath: receipt.trashedPath, toPath: held.path)
        try FileManager.default.createDirectory(atPath: receipt.trashedPath, withIntermediateDirectories: false)
        await #expect(throws: ControlFailure.self) { try await service.undo(token: receipt.undoToken) }
        try FileManager.default.removeItem(atPath: receipt.trashedPath)
        try FileManager.default.moveItem(atPath: held.path, toPath: receipt.trashedPath)
        try FileManager.default.createSymbolicLink(at: package.folderURL, withDestinationURL: scratch.appendingPathComponent("missing"))
        await #expect(throws: ControlFailure.self) { try await service.undo(token: receipt.undoToken) }
        #expect(FileManager.default.fileExists(atPath: receipt.trashedPath))
    }
    @Test("Undo refuses a redirected library root and preserves both paths")
    func redirectedRoot() async throws {
        let (scratch,package,service,_) = try fixture()
        defer { try? FileManager.default.removeItem(at: scratch) }
        let receipt = try await service.trash(id: package.id)
        let root = package.folderURL.deletingLastPathComponent()
        let movedRoot = scratch.appendingPathComponent("held-library")
        try FileManager.default.moveItem(at: root, to: movedRoot)
        let other = scratch.appendingPathComponent("other-library")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: root, withDestinationURL: other)
        await #expect(throws: ControlFailure.self) { try await service.undo(token: receipt.undoToken) }
        #expect(FileManager.default.fileExists(atPath: receipt.trashedPath))
        #expect(try FileManager.default.contentsOfDirectory(atPath: other.path).isEmpty)
    }
}
