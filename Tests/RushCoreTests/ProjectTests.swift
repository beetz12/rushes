import AVFoundation
import CoreMedia
import Foundation
import Testing

@testable import RushCore

@Suite("Project")
struct ProjectTests {

    // A host-time epoch far from zero, the way real capture timestamps look.
    private let epochNs: Int64 = 2_000_000_000_000

    private let fixedDate = Calendar(identifier: .gregorian)
        .date(
            from: DateComponents(
                timeZone: TimeZone(identifier: "UTC"), year: 2026, month: 10, day: 11,
                hour: 9, minute: 41, second: 7))
        ?? Date(timeIntervalSince1970: 0)

    private func tempDir(_ label: String) -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("project-\(label)-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func cleanup(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }

    private func hiddenTempFiles(in dir: URL) -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: dir.path))?.filter {
            $0.hasPrefix(".") && $0.contains(".tmp-")
        } ?? []
    }

    // MARK: - Manifest

    private func sampleManifest(id: String, status: RecordingManifest.Status = .complete)
        -> RecordingManifest
    {
        var clock = SessionClock(epochNs: epochNs)
        try? clock.beginPause(nowNs: epochNs + 60_000_000_000)
        try? clock.endPause(nowNs: epochNs + 72_500_000_000)

        return RecordingManifest(
            id: id,
            title: "Checkout bug repro",
            createdAt: "2026-10-11T09:41:07Z",
            createdHostNs: epochNs - 1_000_000_000,
            startedHostNs: epochNs,
            endedHostNs: epochNs + 190_400_000_000,
            status: status,
            app: .init(version: "0.1.0", build: 12),
            clock: .init(clock: clock, durationNs: 182_400_000_000),
            sources: .init(
                mode: "display",
                displayId: "display-1",
                cameraId: "dev-faceTime",
                microphoneId: "dev-mac-mic",
                systemAudio: true),
            tracks: [
                .init(
                    kind: .screen, codec: "hevc", width: 3024, height: 1964, fps: 60,
                    droppedFrames: 3),
                .init(
                    kind: .camera, codec: "hevc", width: 1920, height: 1080, fps: 30,
                    device: .init(uniqueId: "cam-0", modelId: "UVC", name: "FaceTime HD Camera")),
                .init(
                    kind: .microphone, codec: "aac", sampleRate: 48_000, channels: 1,
                    firstSampleNs: 21_000_000, latencyMs: 0,
                    device: .init(uniqueId: "mic-0", name: "MacBook Pro Microphone")),
                .init(kind: .systemAudio, codec: "aac", sampleRate: 48_000, channels: 2, latencyMs: 120),
            ],
            input: .init(pointer: true, keys: false),
            warnings: [.init(code: "camera-lost", atMs: 151_200)],
            verified: .init(at: "2026-10-11T09:44:12Z", ok: true))
    }

    @Test("Manifest round-trips through JSON with the plan's key names")
    func manifestRoundTrip() throws {
        let manifest = sampleManifest(id: "01JA3K7Q2V9W8X6Y5Z4T3S2R1P")
        let data = try JSONEncoder().encode(manifest)
        let decoded = try RecordingManifest.parse(data)
        #expect(decoded == manifest)

        // The plan-facing key names and role strings.
        let object = try #require(
            try JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["schema"] as? String == "rushes.recording/1")
        #expect(object["createdAt"] as? String == "2026-10-11T09:41:07Z")
        let clock = try #require(object["clock"] as? [String: Any])
        #expect(clock["epochHostNs"] as? Int64 == epochNs)
        #expect(
            clock["pausesNs"] as? [[Int64]]
                == [[epochNs + 60_000_000_000, epochNs + 72_500_000_000]])
        let tracks = try #require(object["tracks"] as? [[String: Any]])
        #expect(tracks.map { $0["role"] as? String } == ["screen", "camera", "mic", "system"])
        #expect(tracks.map { $0["file"] as? String } == ["screen.mov", "camera.mov", "mic.mov", "system.mov"])
        #expect(tracks.allSatisfy { ($0["offsetNs"] as? Int64) == 0 })
        #expect(tracks.allSatisfy { ($0["offsetMs"] as? Int) == 0 })
        #expect(tracks[0]["present"] as? Bool == true)

        // The camera offset the editor consumes.
        #expect(decoded.cameraOffsetMs == 0)
    }

    @Test("A nanosecond offset rounds to whole milliseconds on the track")
    func offsetMilliseconds() throws {
        let track = RecordingManifest.RecordingTrack(kind: .camera, offsetNs: 2_500_000)
        #expect(track.offsetMs == 3)
        let encoded = try JSONEncoder().encode(track)
        let object = try #require(
            try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        #expect(object["offsetNs"] as? Int64 == 2_500_000)
        #expect(object["offsetMs"] as? Int == 3)
    }

    @Test("A newer schema is rejected whole (forward-only versioning)")
    func manifestRejectsNewerSchema() throws {
        let newer = """
            {"schema":"rushes.recording/2","id":"01JA3K7Q2V9W8X6Y5Z4T3S2R1P","status":"complete"}
            """
        #expect(throws: RecordingManifest.ManifestError.unsupportedSchema(
            found: "rushes.recording/2", expected: "rushes.recording/1")
        ) {
            _ = try RecordingManifest.parse(Data(newer.utf8))
        }

        let schemaless = #"{"id":"01JA3K7Q2V9W8X6Y5Z4T3S2R1P"}"#
        #expect(throws: RecordingManifest.ManifestError.self) {
            _ = try RecordingManifest.parse(Data(schemaless.utf8))
        }
    }

    @Test("Missing fields take defaults and unknown fields are ignored")
    func manifestTolerantDecoding() throws {
        let minimal = """
            {"schema":"rushes.recording/1","id":"01JA3K7Q2V9W8X6Y5Z4T3S2R1P",
             "futureDiagnosticField":{"anything":true}}
            """
        let manifest = try RecordingManifest.parse(Data(minimal.utf8))
        #expect(manifest.id == "01JA3K7Q2V9W8X6Y5Z4T3S2R1P")
        #expect(manifest.status == .failed)
        #expect(manifest.tracks.isEmpty)
        #expect(manifest.warnings.isEmpty)
        #expect(manifest.clock == nil)

        let badStatus = """
            {"schema":"rushes.recording/1","id":"01JA3K7Q2V9W8X6Y5Z4T3S2R1P","status":"wat"}
            """
        #expect(throws: RecordingManifest.ManifestError.self) {
            _ = try RecordingManifest.parse(Data(badStatus.utf8))
        }
    }

    @Test("The manifest clock rebuilds a SessionClock with its pauses")
    func manifestClockToSessionClock() throws {
        var clock = SessionClock(epochNs: epochNs)
        try clock.beginPause(nowNs: epochNs + 500_000_000)
        try clock.endPause(nowNs: epochNs + 1_500_000_000)
        let manifestClock = RecordingManifest.ManifestClock(
            clock: clock, durationNs: 1_000_000_000)

        let restored = manifestClock.sessionClock
        #expect(restored.epochNs == epochNs)
        #expect(restored.pauses.count == 1)
        // Two seconds of host time minus the one-second pause.
        #expect(restored.mediaTimeNs(atHostNs: epochNs + 2_000_000_000) == 1_000_000_000)
        #expect(manifestClock.sessionClock.mediaTimeNs(atHostNs: epochNs + 2_000_000_000) == 1_000_000_000)
    }

    @Test("A manifest without an id is rejected")
    func manifestRequiresId() throws {
        let noId = #"{"schema":"rushes.recording/1","status":"complete"}"#
        #expect(throws: RecordingManifest.ManifestError.missingIdentifier) {
            _ = try RecordingManifest.parse(Data(noId.utf8))
        }
    }

    // MARK: - Recording ids

    @Test("Recording ids are ULIDs that sort by creation time")
    func ulidShape() {
        let id = RecordingId.generate()
        #expect(RecordingId.isValid(id))
        #expect(id.count == 26)
        #expect(RecordingId.generate() != id)

        let earlier = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(1))
        let later = RecordingId.generate(
            date: fixedDate.addingTimeInterval(10), randomBytes: fixedBytes(1))
        #expect(earlier < later)

        let again = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(1))
        #expect(again == earlier)
        #expect(RecordingId.folderPrefix(earlier) == String(earlier.prefix(6)))

        #expect(!RecordingId.isValid("01JA3K7Q2V9W8X6Y5Z4T3S2R1PI"))
        #expect(!RecordingId.isValid("0I"))  // I is not in the Crockford alphabet
    }

    private func fixedBytes(_ seed: UInt8) -> () -> [UInt8] {
        { (0..<10).map { UInt8((seed &+ $0) & 0xff) }
        }
    }

    // MARK: - Atomic writes

    @Test("An atomic write replaces the target and leaves no temporary file")
    func atomicWriteReplaces() throws {
        let dir = tempDir("atomic-ok")
        defer { cleanup(dir) }
        let target = dir.appendingPathComponent("manifest.json")

        try AtomicFileWriter.write(Data("v1".utf8), to: target)
        try AtomicFileWriter.write(Data("v2".utf8), to: target)

        #expect(String(decoding: try Data(contentsOf: target), as: UTF8.self) == "v2")
        #expect(hiddenTempFiles(in: dir).isEmpty)
    }

    @Test("A failing rename cleans the temporary file and keeps the target")
    func atomicWriteCleansUpOnRenameFailure() throws {
        let dir = tempDir("atomic-fail")
        defer { cleanup(dir) }
        let target = dir.appendingPathComponent("manifest.json")
        try Data("old".utf8).write(to: target)

        struct Boom: Error {}
        #expect(throws: Boom.self) {
            try AtomicFileWriter.write(Data("new".utf8), to: target) { _, _ in
                throw Boom()
            }
        }

        #expect(String(decoding: try Data(contentsOf: target), as: UTF8.self) == "old")
        #expect(hiddenTempFiles(in: dir).isEmpty)
    }

    // MARK: - Package layout

    @Test("A package folder is named start time plus full id and holds the layout")
    func packageCreationLayout() throws {
        // The root is canonicalized (realpath) so created and scanned paths
        // always compare equal.
        let root = RecordingPackage.canonicalRoot(tempDir("layout-root"))
        defer { cleanup(root) }
        let id = "01JA3K7Q2V9W8X6Y5Z4T3S2R1P"

        // The folder name uses the local time zone; the test pins UTC.
        #expect(
            RecordingPackage.folderName(for: fixedDate, id: id, timeZone: TimeZone(identifier: "UTC")!)
                == "2026-10-11_09-41-07_01JA3K7Q2V9W8X6Y5Z4T3S2R1P")

        let package = try RecordingPackage.create(root: root, date: fixedDate, id: id)
        let localName = RecordingPackage.folderName(for: fixedDate, id: id)
        let expectedFolder = root.appendingPathComponent(localName, isDirectory: true)
        #expect(package.folderURL == expectedFolder)
        #expect(FileManager.default.fileExists(atPath: expectedFolder.path))
        #expect(package.manifestURL == expectedFolder.appendingPathComponent("manifest.json"))
        #expect(package.inputURL == expectedFolder.appendingPathComponent("input.ndjson"))
        #expect(package.editURL == expectedFolder.appendingPathComponent("edit.json"))
        #expect(package.logURL == expectedFolder.appendingPathComponent("log.ndjson"))
        #expect(package.rendersDirectory == expectedFolder.appendingPathComponent("renders", isDirectory: true))
        #expect(package.shareDirectory == expectedFolder.appendingPathComponent("share", isDirectory: true))
        #expect(package.trackURL(for: .screen) == expectedFolder.appendingPathComponent("screen.mov"))
        #expect(package.trackURL(for: .camera) == expectedFolder.appendingPathComponent("camera.mov"))
        #expect(package.trackURL(for: .microphone) == expectedFolder.appendingPathComponent("mic.mov"))
        #expect(package.trackURL(for: .systemAudio) == expectedFolder.appendingPathComponent("system.mov"))

        // Repeating the same unique id never reuses its folder.
        #expect(throws: RecordingPackage.PackageError.self) {
            _ = try RecordingPackage.create(root: root, date: fixedDate, id: id)
        }

        // Manifest writes go through the atomic path and read back.
        let manifest = sampleManifest(id: id)
        try package.writeManifest(manifest)
        #expect(try package.readManifest() == manifest)
        #expect(hiddenTempFiles(in: expectedFolder).isEmpty)
        #expect(RecordingPackage.isPackageFolderName("2026-10-11_09-41-07_01JA3K"))
        #expect(RecordingPackage.isPackageFolderName("2026-10-11_09-41-07_\(id)"))
        #expect(!RecordingPackage.isPackageFolderName("notes.txt"))
    }

    @Test("Distinct takes in the same second preserve both packages and legacy lookup")
    func sameSecondPackages() throws {
        let root = RecordingPackage.canonicalRoot(tempDir("same-second"))
        defer { cleanup(root) }
        let idA = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(1))
        let idB = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(2))
        let first = try RecordingPackage.create(root: root, date: fixedDate, id: idA)
        let second = try RecordingPackage.create(root: root, date: fixedDate, id: idB)
        try first.writeManifest(sampleManifest(id: idA))
        try second.writeManifest(sampleManifest(id: idB))
        #expect(first.folderURL != second.folderURL)
        #expect(RecordingPackage.resolve(root: root, id: idB)?.folderURL == second.folderURL)
        let legacy = root.appendingPathComponent("2026-10-11_09-41-07_\(RecordingId.folderPrefix(idA))", isDirectory: true)
        try FileManager.default.moveItem(at: first.folderURL, to: legacy)
        #expect(RecordingPackage.resolve(root: root, id: idA)?.folderURL == legacy)
        #expect(try second.readManifest().id == idB)
    }

    @Test("A package resolves by id prefix and manifest confirmation")
    func packageResolve() throws {
        let root = tempDir("resolve-root")
        defer { cleanup(root) }
        let idA = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(1))
        let idB = RecordingId.generate(date: fixedDate.addingTimeInterval(1), randomBytes: fixedBytes(2))
        let packageA = try RecordingPackage.create(root: root, date: fixedDate, id: idA)
        let packageB = try RecordingPackage.create(root: root, date: fixedDate.addingTimeInterval(1), id: idB)
        try packageA.writeManifest(sampleManifest(id: idA, status: .recording))
        try packageB.writeManifest(sampleManifest(id: idB))

        #expect(RecordingPackage.resolve(root: root, id: idA)?.folderURL == packageA.folderURL)
        #expect(RecordingPackage.resolve(root: root, id: idB)?.folderURL == packageB.folderURL)
        #expect(RecordingPackage.resolve(root: root, id: RecordingId.generate()) == nil)

        let entries = try RecordingPackage.scanManifests(root: root)
        #expect(entries.map(\.manifest.id).sorted() == [idA, idB].sorted())
    }

    // MARK: - NDJSON append

    private struct InputEvent: Codable, Equatable {
        var t: Double
        var k: String
        var x: Double?
    }

    @Test("NDJSON appends one JSON object per line, durably")
    func ndjsonAppend() throws {
        let dir = tempDir("ndjson")
        defer { cleanup(dir) }
        let url = dir.appendingPathComponent("input.ndjson")

        let log = try NDJSONAppendFile(url: url, fsyncPerLine: true)
        try log.append(InputEvent(t: 1234.5, k: "move", x: 0.412))
        try log.append(InputEvent(t: 1302.0, k: "down", x: nil))
        try log.append(InputEvent(t: 1388.1, k: "up", x: nil))
        log.close()

        #expect(throws: NDJSONAppendFile.AppendError.self) {
            try log.append(InputEvent(t: 1, k: "move", x: 0))
        }

        let contents = try String(contentsOf: url, encoding: .utf8)
        let lines = contents.split(separator: "\n")
        #expect(lines.count == 3)
        #expect(contents.hasSuffix("\n"))
        let events = try lines.map { try JSONDecoder().decode(InputEvent.self, from: Data($0.utf8)) }
        #expect(events[0] == InputEvent(t: 1234.5, k: "move", x: 0.412))

        // Reopening appends; existing lines are never rewritten.
        let second = try NDJSONAppendFile(url: url)
        try second.append(InputEvent(t: 2000.0, k: "cursor", x: nil))
        second.close()
        #expect(try String(contentsOf: url, encoding: .utf8).split(separator: "\n").count == 4)
    }

    // MARK: - SQLite index

    @Test("The index stores rows in WAL mode and rebuilds to the same state")
    func packageIndexCRUDAndRebuild() async throws {
        let root = tempDir("index-root").resolvingSymlinksInPath()
        let dbURL = tempDir("index-db").appendingPathComponent("index.sqlite")
        defer { cleanup(root); cleanup(dbURL.deletingLastPathComponent()) }

        // Two indexed packages. The incremental flow mirrors the session
        // layer: every manifest write is followed by an index update from
        // that manifest.
        let idA = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(1))
        let idB = RecordingId.generate(date: fixedDate.addingTimeInterval(5), randomBytes: fixedBytes(2))
        let packageA = try RecordingPackage.create(root: root, date: fixedDate, id: idA)
        let packageB = try RecordingPackage.create(root: root, date: fixedDate.addingTimeInterval(5), id: idB)

        let index = try PackageIndex(databaseURL: dbURL)
        #expect(try await index.journalMode() == "wal")

        // Create: manifest A written at start (status recording, 61 s),
        // manifest B already complete.
        var manifestA = sampleManifest(id: idA, status: .recording)
        manifestA.clock = .init(clock: SessionClock(epochNs: epochNs), durationNs: 61_000_000_000)
        try packageA.writeManifest(manifestA)
        try packageB.writeManifest(sampleManifest(id: idB))

        func scannedRow(id: String) throws -> PackageIndex.Row {
            let entry = try RecordingPackage.scanManifests(root: root).first { $0.manifest.id == id }
            return PackageIndex.Row(entry: try #require(entry))
        }
        try await index.upsert(scannedRow(id: idA))
        try await index.upsert(scannedRow(id: idB))
        #expect(try await index.allRows().count == 2)
        #expect(try await index.row(id: idA)?.durationMs == 61_000)
        #expect(try await index.row(id: idA)?.status == "recording")
        #expect(try await index.row(id: idB)?.status == "complete")

        // Update: stop rewrites manifest A with status complete.
        var stopped = manifestA
        stopped.status = .complete
        try packageA.writeManifest(stopped)
        try await index.upsert(scannedRow(id: idA))
        #expect(try await index.row(id: idA)?.status == "complete")

        // Delete (and a repeat delete is a no-op).
        #expect(try await index.delete(id: idB) == true)
        #expect(try await index.delete(id: idB) == false)
        #expect(try await index.row(id: idB) == nil)
        try await index.upsert(scannedRow(id: idB))

        let incremental = try await index.allRows()

        // A lost or corrupt index rebuilds to exactly the same state from
        // the manifests alone.
        let rebuiltURL = tempDir("index-db2").appendingPathComponent("index.sqlite")
        defer { cleanup(rebuiltURL.deletingLastPathComponent()) }
        let rebuilt = try PackageIndex(databaseURL: rebuiltURL)
        let count = try await rebuilt.rebuild(root: root)
        #expect(count == 2)
        let rebuiltRows = try await rebuilt.allRows()

        #expect(
            incremental.sorted { $0.id < $1.id }
                == rebuiltRows.sorted { $0.id < $1.id })
        #expect(Set(rebuiltRows.map(\.id)) == [idA, idB])
        #expect(rebuiltRows.first { $0.id == idA }?.folder == packageA.folderURL.path)

        await index.close()
        await rebuilt.close()
    }

    // MARK: - Synthetic media

    /// One NV12 video frame at a host time, 320x240, 30 fps timing.
    private func makeVideoBuffer(hostNs: Int64, width: Int = 320, height: Int = 240) -> CMSampleBuffer {
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixelBuffer)
        guard let buffer = pixelBuffer else {
            Issue.record("CVPixelBufferCreate failed")
            fatalError("CVPixelBufferCreate failed")
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        for plane in 0..<CVPixelBufferGetPlaneCount(buffer) {
            if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) {
                memset(
                    base, 128,
                    CVPixelBufferGetHeightOfPlane(buffer, plane)
                        * CVPixelBufferGetBytesPerRowOfPlane(buffer, plane))
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])

        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, formatDescriptionOut: &format)
        guard let format else {
            Issue.record("format description creation failed")
            fatalError("format description creation failed")
        }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil,
            formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        guard let sample else {
            Issue.record("CMSampleBufferCreateForImageBuffer failed")
            fatalError("CMSampleBufferCreateForImageBuffer failed")
        }
        return sample
    }

    /// One buffer of `frames` mono Float32 PCM samples at 48 kHz, stamped at
    /// a host time.
    private func makeAudioBuffer(hostNs: Int64, frames: Int = 1024) -> CMSampleBuffer {
        let asbd = AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 32,
            mReserved: 0)
        var format: CMAudioFormatDescription?
        let formatStatus = withUnsafePointer(to: asbd) { asbdPtr in
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: asbdPtr, layoutSize: 0, layout: nil,
                magicCookieSize: 0, magicCookie: nil, extensions: nil,
                formatDescriptionOut: &format)
        }
        guard formatStatus == noErr, let format else {
            Issue.record("audio format description creation failed")
            fatalError("audio format description creation failed")
        }

        let totalBytes = frames * 4
        let memory = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
        let floats = memory.assumingMemoryBound(to: Float.self)
        for i in 0..<frames {
            floats[i] = 0.5 * sin(2 * Float.pi * 440 * Float(i) / 48_000)
        }
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: memory, blockLength: totalBytes,
            blockAllocator: kCFAllocatorMalloc, customBlockSource: nil, offsetToData: 0,
            dataLength: totalBytes, flags: 0, blockBufferOut: &block)
        guard let block else {
            Issue.record("CMBlockBufferCreateWithMemoryBlock failed")
            fatalError("CMBlockBufferCreateWithMemoryBlock failed")
        }

        var timing = [CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)]
        var sample: CMSampleBuffer?
        CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
            sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
        guard let sample else {
            Issue.record("CMSampleBufferCreate failed")
            fatalError("CMSampleBufferCreate failed")
        }
        return sample
    }

    /// Writes a real, playable one-track video file of `durationNs` via the
    /// production `TrackWriter` (H.264 so no hardware encoder is needed).
    private func writeVideoFile(url: URL, durationNs: Int64, epochNs: Int64) async throws {
        let config = TrackWriterConfiguration.screen(
            outputURL: url, width: 320, height: 240, codec: .h264)
        let writer = try TrackWriter(configuration: config, clock: SessionClock(epochNs: epochNs))
        let frameNs: Int64 = 33_333_333
        var host = epochNs
        while host < epochNs + durationNs {
            writer.appendVideo(makeVideoBuffer(hostNs: host))
            host += frameNs
        }
        let status = await writer.finalize(endMediaTimeNs: durationNs, deadline: .seconds(20))
        guard status.finalizeState == .finalized else {
            Issue.record("video fixture finalize failed: \(status.finalizeState)")
            return
        }
    }

    /// Writes a real, playable AAC audio file padded to exactly
    /// `durationNs`.
    private func writeAudioFile(url: URL, durationNs: Int64, epochNs: Int64) async throws {
        let config = TrackWriterConfiguration.microphone(outputURL: url)
        let writer = try TrackWriter(configuration: config, clock: SessionClock(epochNs: epochNs))
        let bufferNs: Int64 = Int64(Double(1024) / 48_000 * 1e9)
        var host = epochNs
        while host < epochNs + durationNs - bufferNs {
            writer.appendAudio(makeAudioBuffer(hostNs: host))
            host += bufferNs
        }
        let status = await writer.finalize(endMediaTimeNs: durationNs, deadline: .seconds(20))
        guard status.finalizeState == .finalized else {
            Issue.record("audio fixture finalize failed: \(status.finalizeState)")
            return
        }
    }

    // MARK: - Recovery

    @Test("Recovery marks an interrupted package recovered and never deletes footage")
    func recoveryMarksInterrupted() async throws {
        let root = tempDir("recover-root").resolvingSymlinksInPath()
        defer { cleanup(root) }

        // An interrupted package: a real half-second screen file and a
        // camera entry whose file never materialized.
        let id = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(3))
        let package = try RecordingPackage.create(root: root, date: fixedDate, id: id)
        let screenDurationNs: Int64 = 500_000_000
        try await writeVideoFile(
            url: package.trackURL(for: .screen), durationNs: screenDurationNs, epochNs: epochNs)
        var interrupted = sampleManifest(id: id, status: .recording)
        interrupted.tracks = [
            RecordingManifest.RecordingTrack(kind: .screen),
            RecordingManifest.RecordingTrack(kind: .camera),
        ]
        try package.writeManifest(interrupted)

        // A settled package the pass must not touch.
        let otherID = RecordingId.generate(date: fixedDate.addingTimeInterval(2), randomBytes: fixedBytes(4))
        let other = try RecordingPackage.create(root: root, date: fixedDate.addingTimeInterval(2), id: otherID)
        try other.writeManifest(sampleManifest(id: otherID, status: .complete))

        let recovery = PackageRecovery(root: root)
        let reports = try await recovery.recover(interruptedAtLaunch: true)

        #expect(reports.count == 1)
        let report = try #require(reports.first)
        #expect(report.packageID == id)
        #expect(report.previousStatus == .recording)
        let screenOutcome = try #require(report.trackOutcomes.first { $0.kind == .screen })
        #expect(screenOutcome.fileKept && screenOutcome.usable && !screenOutcome.salvaged)
        let cameraOutcome = try #require(report.trackOutcomes.first { $0.kind == .camera })
        #expect(cameraOutcome.fileKept == false && cameraOutcome.usable == false)

        let recovered = try package.readManifest()
        #expect(recovered.status == .recovered)
        // Footage is still on disk.
        #expect(FileManager.default.fileExists(atPath: package.trackURL(for: .screen).path))
        // The camera entry that never wrote a file is no longer marked present.
        let camera = try #require(recovered.tracks.first { $0.kind == .camera })
        #expect(camera.present == false)
        let screen = try #require(recovered.tracks.first { $0.kind == .screen })
        #expect(screen.present == true)
        // Warnings record what happened.
        #expect(recovered.warnings.contains { $0.code == "track-missing" })
        #expect(recovered.warnings.contains { $0.code == "recovered-at-launch" })
        // The duration was set from the shortest recovered video track.
        let durationNs = try #require(recovered.clock?.durationNs)
        #expect(durationNs > 300_000_000 && durationNs < 800_000_000)

        // The settled package is untouched.
        #expect(try other.readManifest().status == .complete)
        // A second pass finds nothing left to recover.
        let second = try await recovery.recover(interruptedAtLaunch: false)
        #expect(second.isEmpty)
    }

    @Test("An unopenable track is kept untouched and reported")
    func recoveryKeepsUnreadableFile() async throws {
        let root = tempDir("recover-garbage")
        defer { cleanup(root) }

        let id = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(5))
        let package = try RecordingPackage.create(root: root, date: fixedDate, id: id)
        let micURL = package.trackURL(for: .microphone)
        try Data("definitely not a quicktime movie".utf8).write(to: micURL)

        var manifest = sampleManifest(id: id, status: .finishing)
        manifest.tracks = [RecordingManifest.RecordingTrack(kind: .microphone)]
        manifest.clock = nil
        try package.writeManifest(manifest)

        let reports = try await PackageRecovery(root: root).recover(interruptedAtLaunch: false)
        #expect(reports.count == 1)

        // The garbage file is still there, byte for byte, and flagged.
        #expect(FileManager.default.fileExists(atPath: micURL.path))
        #expect(String(decoding: try Data(contentsOf: micURL), as: UTF8.self).hasPrefix("definitely"))
        let recovered = try package.readManifest()
        #expect(recovered.status == .recovered)
        #expect(recovered.warnings.contains { $0.code == "track-unreadable" })
        let mic = try #require(recovered.tracks.first { $0.kind == .microphone })
        #expect(mic.present == true)  // the file exists; it is just not usable media
    }

    // MARK: - Verify

    @Test("Verify passes on a good package with real media")
    func verifyGoodPackage() async throws {
        let root = tempDir("verify-good").resolvingSymlinksInPath()
        defer { cleanup(root) }
        let id = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(6))
        let package = try RecordingPackage.create(root: root, date: fixedDate, id: id)
        let durationNs: Int64 = 1_000_000_000
        try await writeVideoFile(url: package.trackURL(for: .screen), durationNs: durationNs, epochNs: epochNs)
        try await writeAudioFile(url: package.trackURL(for: .microphone), durationNs: durationNs, epochNs: epochNs)

        var manifest = sampleManifest(id: id, status: .complete)
        manifest.clock = .init(clock: SessionClock(epochNs: epochNs), durationNs: durationNs)
        // This take has no camera and no system audio: their entries are
        // marked absent and are skipped, not failed.
        manifest.tracks[1].present = false
        manifest.tracks[3].present = false
        try package.writeManifest(manifest)

        let report = await PackageVerifier(toleranceMs: 300).verify(package)
        #expect(report.ok)
        #expect(report.issues.isEmpty)
        #expect(report.trackChecks.count == 4)
        #expect(report.trackChecks.first { $0.kind == .camera }?.skipped == true)
        #expect(report.trackChecks.first { $0.kind == .systemAudio }?.skipped == true)
        let screen = try #require(report.trackChecks.first { $0.kind == .screen })
        #expect(screen.ok && screen.issues.isEmpty)
        let mic = try #require(report.trackChecks.first { $0.kind == .microphone })
        #expect(mic.ok && mic.issues.isEmpty)
    }

    @Test("Camera loss permits only its measured shorter camera duration")
    func verifyCameraLossDuration() async throws {
        let root = tempDir("camera-loss-duration")
        defer { cleanup(root) }
        let package = try RecordingPackage.create(root: root)
        try await writeVideoFile(url: package.trackURL(for: .screen), durationNs: 2_000_000_000, epochNs: epochNs)
        try await writeVideoFile(url: package.trackURL(for: .camera), durationNs: 1_000_000_000, epochNs: epochNs)
        var manifest = sampleManifest(id: package.id, status: .complete)
        manifest.clock?.durationNs = 2_000_000_000
        manifest.tracks = [.init(kind: .screen), .init(kind: .camera)]
        manifest.tracks[1].durationNs = 1_000_000_000
        manifest.warnings = [.init(code: "camera-lost", atMs: 1000)]
        try package.writeManifest(manifest)
        #expect((await PackageVerifier().verify(package)).ok)
        manifest.warnings = []
        try package.writeManifest(manifest)
        #expect(!(await PackageVerifier().verify(package)).ok)
        manifest.warnings = [.init(code: "camera-lost")]
        manifest.tracks[0].durationNs = 1_000_000_000
        try package.writeManifest(manifest)
        #expect(!(await PackageVerifier().verify(package)).ok)
    }

    @Test("A fatal early-stop warning cannot verify successfully merely because other tracks play")
    func verifyRejectsFatalEarlyStop() async throws {
        let root = tempDir("verify-fatal-stop")
        defer { cleanup(root) }
        let package = try RecordingPackage.create(root: root)
        try await writeAudioFile(url: package.trackURL(for: .microphone), durationNs: 1_000_000_000, epochNs: epochNs)
        var manifest = sampleManifest(id: package.id, status: .complete)
        manifest.clock?.durationNs = 1_000_000_000
        manifest.tracks = [.init(kind: .microphone)]
        manifest.warnings = []
        try package.writeManifest(manifest)
        #expect((await PackageVerifier().verify(package)).ok)
        manifest.tracks.append(.init(kind: .camera, present: false))
        manifest.warnings = [.init(code: "ended-early", message: "stream-error: camera writer: encoder failed")]
        try package.writeManifest(manifest)
        let report = await PackageVerifier().verify(package)
        #expect(!report.ok)
        #expect(report.trackChecks.first(where: { $0.kind == .microphone })?.ok == true)
        #expect(report.issues.contains { $0.contains("writer failed") })
    }
    @Test("Verify reports the specific failure for each broken track")
    func verifyReportsSpecificFailures() async throws {
        let root = tempDir("verify-bad")
        defer { cleanup(root) }
        let id = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(7))
        let package = try RecordingPackage.create(root: root, date: fixedDate, id: id)
        let durationNs: Int64 = 1_000_000_000

        // screen: entry says present, file missing.
        // camera: real media, but offsetMs disagrees with offsetNs.
        // mic: garbage bytes.
        // system: real audio, but the manifest duration says 10 s.
        try await writeVideoFile(url: package.trackURL(for: .camera), durationNs: durationNs, epochNs: epochNs)
        try await writeAudioFile(url: package.trackURL(for: .systemAudio), durationNs: durationNs, epochNs: epochNs)
        try Data("not a movie".utf8).write(to: package.trackURL(for: .microphone))

        var manifest = sampleManifest(id: id, status: .complete)
        manifest.clock?.durationNs = 10_000_000_000
        var camera = manifest.tracks[1]
        camera.offsetNs = 2_500_000
        camera.offsetMs = 0  // tampered: should say 3
        manifest.tracks[1] = camera
        try package.writeManifest(manifest)

        let report = await PackageVerifier(toleranceMs: 300).verify(package)
        #expect(!report.ok)

        let screen = try #require(report.trackChecks.first { $0.kind == .screen })
        #expect(!screen.ok)
        #expect(screen.issues.contains { $0.contains("screen.mov: file missing") })

        let cameraCheck = try #require(report.trackChecks.first { $0.kind == .camera })
        #expect(!cameraCheck.ok)
        #expect(cameraCheck.issues.contains { $0.contains("offsetMs 0 does not match offsetNs 2500000") })

        let mic = try #require(report.trackChecks.first { $0.kind == .microphone })
        #expect(!mic.ok)
        #expect(mic.issues.contains { $0.contains("mic.mov: could not be opened by AVFoundation") })

        let system = try #require(report.trackChecks.first { $0.kind == .systemAudio })
        #expect(!system.ok)
        #expect(system.issues.contains { $0.contains("system.mov: duration") && $0.contains("off the manifest duration") })
    }

    @Test("Verify reports an unreadable manifest without throwing")
    func verifyHandlesMissingManifest() async throws {
        let root = tempDir("verify-nomanifest")
        defer { cleanup(root) }
        let id = RecordingId.generate(date: fixedDate, randomBytes: fixedBytes(8))
        let package = try RecordingPackage.create(root: root, date: fixedDate, id: id)

        let report = await PackageVerifier().verify(package)
        #expect(!report.ok)
        #expect(report.issues.contains { $0.contains("manifest unreadable") })
    }

    @Test("Content-free and failed packages cannot pass verification")
    func verifyRejectsEmpty() async throws {
        let root = tempDir("verify-empty")
        defer { cleanup(root) }
        let id = RecordingId.generate()
        let package = try RecordingPackage.create(root: root, id: id)
        var manifest = sampleManifest(id: id)
        manifest.tracks = []
        try package.writeManifest(manifest)
        #expect(!(await PackageVerifier().verify(package)).ok)
        manifest.tracks = [.init(kind: .screen, present: false)]
        manifest.status = .failed
        try package.writeManifest(manifest)
        let report = await PackageVerifier().verify(package)
        #expect(!report.ok)
        #expect(report.issues.contains { $0.contains("no recorded media") })
        #expect(report.issues.contains { $0.contains("not a finalized") })
    }

    @Test("Traversal and canonical symlink escapes are refused before opening media")
    func unsafeTrackPaths() async throws {
        let root = tempDir("unsafe-track")
        defer { cleanup(root) }
        let id = RecordingId.generate()
        let package = try RecordingPackage.create(root: root, id: id)
        let outside = root.appendingPathComponent("outside.mov")
        try Data("must remain untouched".utf8).write(to: outside)
        for name in ["../outside.mov", outside.path, "folder/file.mov", "..", ""] {
            #expect(throws: RecordingPackage.PackageError.self) {
                _ = try package.validatedMediaURL(name)
            }
        }
        try FileManager.default.createSymbolicLink(at: package.trackURL(for: .screen), withDestinationURL: outside)
        #expect(throws: RecordingPackage.PackageError.self) {
            _ = try package.validatedMediaURL("screen.mov")
        }
        var manifest = sampleManifest(id: id, status: .recording)
        manifest.tracks = [.init(kind: .screen, file: "../outside.mov")]
        try package.writeManifest(manifest)
        let report = await PackageVerifier().verify(package)
        #expect(!report.ok)
        #expect(report.trackChecks.first?.issues.contains { $0.contains("unsafe media path") } == true)
        let recovered = try await PackageRecovery(root: root).recover(interruptedAtLaunch: true)
        #expect(recovered.first?.warnings.contains { $0.code == "unsafe-track-path" } == true)
        #expect(try String(contentsOf: outside, encoding: .utf8) == "must remain untouched")
    }
}
