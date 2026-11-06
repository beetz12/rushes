@preconcurrency import AVFoundation
import CryptoKit
import Foundation
import Testing
@testable import RushCore

/// Import fixtures are generated media written as MP4 like a Loom download;
/// nothing here touches a live camera, screen or microphone.
@Suite("VideoImport", .serialized)
struct VideoImportTests {

    private static func scratch(_ label: String) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("rushes-import-\(label)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// A two-second H.264 MP4, with interleaved AAC audio when `audio`.
    static func makeMP4(at url: URL, audio: Bool) async throws {
        // Generate the elementary tracks, then mux them into one MP4 without
        // re-encoding, the shape of a Loom download.
        let parts = url.deletingLastPathComponent().appendingPathComponent("parts-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: parts, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: parts) }
        let videoURL = parts.appendingPathComponent("v.mov"), audioURL = parts.appendingPathComponent("a.mov")
        try await SyntheticExportFixture.video(to: videoURL, camera: false)
        let composition = AVMutableComposition()
        let videoAsset = AVURLAsset(url: videoURL)
        let videoTrack = try #require(try await videoAsset.loadTracks(withMediaType: .video).first)
        let range = CMTimeRange(start: .zero, duration: try await videoAsset.load(.duration))
        try composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)?
            .insertTimeRange(range, of: videoTrack, at: .zero)
        if audio {
            try await SyntheticExportFixture.audio(to: audioURL, frequency: 440)
            // Keep the asset alive: a track whose asset is released cannot be inserted.
            let audioAsset = AVURLAsset(url: audioURL)
            let audioTrack = try #require(try await audioAsset.loadTracks(withMediaType: .audio).first)
            let audioRange = try await audioTrack.load(.timeRange)
            try composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)?
                .insertTimeRange(CMTimeRange(start: .zero, duration: min(range.duration, audioRange.end)), of: audioTrack, at: .zero)
            withExtendedLifetime(audioAsset) {}
        }
        let export = try #require(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough))
        try await export.export(to: url, as: .mp4)
    }

    private static func fingerprint(_ url: URL) throws -> (String, Date?) {
        let digest = SHA256.hash(data: try Data(contentsOf: url)).description
        let modified = try FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
        return (digest, modified)
    }

    private static func visibleEntries(_ root: URL) throws -> [String] {
        guard FileManager.default.fileExists(atPath: root.path) else { return [] }
        return try FileManager.default.contentsOfDirectory(atPath: root.path)
    }

    private static func roomy(_ root: URL) -> VideoImporter {
        VideoImporter(root: root, volumeProvider: { _ in VolumeInfo(availableBytes: 100 * 1_073_741_824) })
    }

    private static func failureCode(_ body: () async throws -> Void) async -> String? {
        do { try await body(); return nil }
        catch let failure as ControlFailure { return failure.payload.code }
        catch { return "unexpected: \(error)" }
    }

    @Test("MP4 with audio becomes a verified package; source untouched; list returns it")
    func importWithAudio() async throws {
        let scratch = try Self.scratch("audio")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let source = scratch.appendingPathComponent("Weekly sync – Loom.mp4")
        try await Self.makeMP4(at: source, audio: true)
        let before = try Self.fingerprint(source)
        let root = scratch.appendingPathComponent("library")
        let controller = try EngineController(config: .init(
            recordingsRoot: root, indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"),
            catalog: DiagnosticSourceCatalog(),
            volumeProvider: { _ in VolumeInfo(availableBytes: 100 * 1_073_741_824) },
            captureRigs: StubCaptureRigFactory(), capturePreflightMode: .generated))
        let exchange = ControlExchange()
        await controller.handle(ControlRequest(id: "imp", cmd: "library.import",
            args: .object(["path": .string(source.path)])), context: exchange.context)
        let response = try #require(exchange.lastResponse)
        #expect(response.ok, "import failed: \(String(describing: response.error))")
        let id = try #require(response.result?["id"]?.string)
        #expect(response.result?["title"]?.string == "Weekly sync – Loom")

        let package = try #require(RecordingPackage.resolve(root: root, id: id))
        let manifest = try package.readManifest()
        #expect(manifest.status == .complete)
        #expect(manifest.imported?.originalFilename == "Weekly sync – Loom.mp4")
        #expect(manifest.imported?.hasAudio == true)
        #expect(manifest.tracks.map(\.kind) == [.screen, .microphone])
        #expect(manifest.tracks.first?.width == 320 && manifest.tracks.first?.height == 180)
        let screen = AVURLAsset(url: package.trackURL(for: .screen))
        #expect(try await screen.loadTracks(withMediaType: .video).count == 1)
        #expect(try await screen.loadTracks(withMediaType: .audio).isEmpty)
        let mic = AVURLAsset(url: package.trackURL(for: .microphone))
        #expect(try await mic.loadTracks(withMediaType: .audio).count == 1)

        let report = await PackageVerifier().verify(package)
        #expect(report.ok, "verify: \(report.issues) \(report.trackChecks.flatMap(\.issues))")

        await controller.handle(ControlRequest(id: "list", cmd: "list"), context: exchange.context)
        let rows = exchange.lastResponse?.result?["recordings"]?.array ?? []
        #expect(rows.contains { $0["id"]?.string == id && $0["title"]?.string == "Weekly sync – Loom" })
        let ledger = try String(contentsOf: package.jobsURL, encoding: .utf8)
        #expect(ledger.contains("transcribe") && ledger.contains("metadata"))
        await controller.shutdown()

        let after = try Self.fingerprint(source)
        #expect(after.0 == before.0)
        #expect(after.1 == before.1)
        #expect(!(try Self.visibleEntries(root)).contains { $0.hasPrefix(".import-") })
    }

    @Test("MP4 without audio imports a screen-only package that verifies")
    func importWithoutAudio() async throws {
        let scratch = try Self.scratch("silent")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let source = scratch.appendingPathComponent("demo.MP4")
        try await Self.makeMP4(at: source, audio: false)
        let before = try Self.fingerprint(source)
        let root = scratch.appendingPathComponent("library")
        let imported = try await Self.roomy(root).importVideo(at: source)
        #expect(imported.manifest.title == "demo")
        #expect(imported.manifest.tracks.map(\.kind) == [.screen])
        #expect(!FileManager.default.fileExists(atPath: imported.package.trackURL(for: .microphone).path))
        let report = await PackageVerifier().verify(imported.package)
        #expect(report.ok, "verify: \(report.issues) \(report.trackChecks.flatMap(\.issues))")
        let scanned = try RecordingPackage.scanManifests(root: root)
        #expect(scanned.map(\.manifest.id) == [imported.manifest.id])
        #expect(try Self.fingerprint(source).0 == before.0)
    }

    @Test("Missing, non-video and wrong-extension files are refused without debris")
    func rejections() async throws {
        let scratch = try Self.scratch("reject")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let root = scratch.appendingPathComponent("library")
        let importer = Self.roomy(root)
        #expect(await Self.failureCode { _ = try await importer.importVideo(at: scratch.appendingPathComponent("gone.mp4")) } == "not-found")
        let text = scratch.appendingPathComponent("notes.txt")
        try Data("hello".utf8).write(to: text)
        #expect(await Self.failureCode { _ = try await importer.importVideo(at: text) } == "unsupported-file")
        let fake = scratch.appendingPathComponent("fake.mp4")
        try Data("not a movie at all".utf8).write(to: fake)
        #expect(await Self.failureCode { _ = try await importer.importVideo(at: fake) } == "unsupported-file")
        let folder = scratch.appendingPathComponent("folder.mov", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        #expect(await Self.failureCode { _ = try await importer.importVideo(at: folder) } == "unsupported-file")
        let soundOnly = scratch.appendingPathComponent("voice.mov")
        try await SyntheticExportFixture.audio(to: soundOnly, frequency: 440)
        #expect(await Self.failureCode { _ = try await importer.importVideo(at: soundOnly) } == "no-video")
        #expect(try Self.visibleEntries(root).isEmpty)
    }

    @Test("Low disk and a failure at the last step leave no package behind")
    func atomicFailure() async throws {
        let scratch = try Self.scratch("atomic")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let source = scratch.appendingPathComponent("talk.m4v")
        try await Self.makeMP4(at: source, audio: true)
        let before = try Self.fingerprint(source)
        let root = scratch.appendingPathComponent("library")
        let tight = VideoImporter(root: root, volumeProvider: { _ in VolumeInfo(availableBytes: 1_000_000) })
        #expect(await Self.failureCode { _ = try await tight.importVideo(at: source) } == "low-disk")
        let failing = VideoImporter(root: root, volumeProvider: { _ in VolumeInfo(availableBytes: 100 * 1_073_741_824) },
                                    beforeCommit: { staging in
            #expect(FileManager.default.fileExists(atPath: staging.appendingPathComponent("manifest.json").path))
            throw CocoaError(.fileWriteOutOfSpace)
        })
        #expect(await Self.failureCode { _ = try await failing.importVideo(at: source) } == "import-failed")
        #expect(try Self.visibleEntries(root).isEmpty)
        #expect(try RecordingPackage.scanManifests(root: root).isEmpty)
        #expect(try Self.fingerprint(source).0 == before.0)
    }

    @Test("A killed import's staging folder is never listed and is deleted at launch")
    func abandonedStaging() async throws {
        let scratch = try Self.scratch("abandoned")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let source = scratch.appendingPathComponent("talk.mp4")
        try await Self.makeMP4(at: source, audio: true)
        let root = scratch.appendingPathComponent("library")
        let done = try await Self.roomy(root).importVideo(at: source)
        // A kill between writeManifest and rename leaves a complete package
        // under the hidden staging name.
        let stale = RecordingPackage.canonicalRoot(root).appendingPathComponent("\(VideoImporter.stagingPrefix)killed", isDirectory: true)
        try FileManager.default.copyItem(at: done.package.folderURL, to: stale)
        try FileManager.default.removeItem(at: done.package.folderURL)
        #expect(try RecordingPackage.scanManifests(root: root).isEmpty)
        let controller = try EngineController(config: .init(
            recordingsRoot: root, indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"),
            catalog: DiagnosticSourceCatalog(), captureRigs: StubCaptureRigFactory(), capturePreflightMode: .generated))
        await controller.prepare()
        #expect(!FileManager.default.fileExists(atPath: stale.path))
    }

    @Test("library.import is never offered to MCP clients")
    func notAnMCPTool() async throws {
        let scratch = try Self.scratch("mcp")
        defer { try? FileManager.default.removeItem(at: scratch) }
        let controller = try EngineController(config: .init(
            recordingsRoot: scratch.appendingPathComponent("library"), indexDatabaseURL: scratch.appendingPathComponent("index.sqlite"),
            catalog: DiagnosticSourceCatalog(), captureRigs: StubCaptureRigFactory(), capturePreflightMode: .generated))
        let names = await controller.automationTools().map(\.command)
        #expect(names.contains("list"))
        #expect(!names.contains("library.import"))
    }

    @Test("Missing-file errors do not echo the path")
    func genericMissingError() async throws {
        let secret = "/private/var/nonexistent-\(UUID().uuidString)/payroll.mp4"
        do {
            _ = try await Self.roomy(FileManager.default.temporaryDirectory.appendingPathComponent("unused-\(UUID().uuidString)"))
                .importVideo(at: URL(fileURLWithPath: secret))
            Issue.record("import of a missing file succeeded")
        } catch let failure as ControlFailure {
            #expect(failure.payload.code == "not-found")
            #expect(!(failure.payload.message ?? "").contains("payroll"))
        }
    }

    @Test("Guide lists library.import with the rushes import spelling")
    func guideEntry() {
        let doc = ControlGuide.make(version: "test", socketPath: "/tmp/x.sock").commands.first { $0.name == "library.import" }
        #expect(doc?.cli == ["import"])
        #expect(doc?.params.first?.name == "path")
    }
}
