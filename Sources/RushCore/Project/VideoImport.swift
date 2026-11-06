@preconcurrency import AVFoundation
import Foundation

/// Brings an existing video file (an MP4 downloaded from Loom, a QuickTime
/// movie) into the library as a new recording package (`library.import`).
///
/// Layout of an imported package, chosen so every existing reader works
/// unchanged:
/// - `screen.mov`: the source's first video track, copied sample for sample
///   (no re-encode) into a QuickTime movie, with its display transform.
/// - `mic.mov`: the source's first audio track, copied the same way, when the
///   source has one. Transcription reads `mic.mov`, export mixes the
///   microphone track, and the editor's microphone gain and mute apply to it.
/// - `manifest.json`: status `complete`, an `imported` block with the
///   original file name and timestamps, and the original name (without its
///   extension) as the title.
///
/// Both media files are cut to the shorter of the two source tracks so the
/// package passes the same decode test (`verify`) as a recorded take.
///
/// The source is only ever read. All work happens in a hidden staging folder
/// inside the recordings root; the package appears under its final name by
/// one rename at the end, so a failed import leaves nothing behind.
public struct VideoImporter: Sendable {

    /// File extensions offered and accepted.
    public static let acceptedExtensions: Set<String> = ["mp4", "mov", "m4v"]

    public let root: URL
    public let volumeProvider: @Sendable (URL) -> VolumeInfo
    public let minimumFreeBytes: Int64
    public let hostNowNs: @Sendable () -> Int64
    /// Test seam: runs after the staging folder is complete and before it is
    /// renamed into place. Throwing simulates a failure at the last moment.
    public var beforeCommit: (@Sendable (URL) throws -> Void)?

    public init(
        root: URL,
        volumeProvider: @escaping @Sendable (URL) -> VolumeInfo = { VolumeInfo.current(nearestAncestorOf: $0) },
        minimumFreeBytes: Int64 = Preflight.startFloorBytes,
        hostNowNs: @escaping @Sendable () -> Int64 = { Int64(clamping: DispatchTime.now().uptimeNanoseconds) },
        beforeCommit: (@Sendable (URL) throws -> Void)? = nil
    ) {
        self.root = root
        self.volumeProvider = volumeProvider
        self.minimumFreeBytes = minimumFreeBytes
        self.hostNowNs = hostNowNs
        self.beforeCommit = beforeCommit
    }

    /// The outcome of one import.
    public struct Imported: Sendable {
        public let package: RecordingPackage
        public let manifest: RecordingManifest
        /// Milliseconds of video cut off because the audio track ended first.
        public var trimmedVideoMs: Int64 = 0
    }

    /// Prefix of the hidden staging folder an import builds in.
    public static let stagingPrefix = ".import-"

    /// Deletes staging folders left by an import that was killed mid-copy
    /// (quit, crash, power loss). Call once at launch, before any import runs.
    @discardableResult
    public static func removeAbandonedStaging(root: URL) -> Int {
        let root = RecordingPackage.canonicalRoot(root)
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: root.path) else { return 0 }
        var removed = 0
        for name in names where name.hasPrefix(stagingPrefix) {
            if (try? FileManager.default.removeItem(at: root.appendingPathComponent(name, isDirectory: true))) != nil { removed += 1 }
        }
        return removed
    }

    /// Imports one file. Errors are `ControlFailure`s with stable codes:
    /// `invalid-params`, `not-found`, `unsupported-file`, `protected-content`,
    /// `no-video`, `low-disk`, `import-failed`.
    public func importVideo(at source: URL) async throws -> Imported {
        let source = source.standardizedFileURL
        let attributes = try Self.validateSourceFile(source)
        let asset = AVURLAsset(url: source)
        let (video, audio, mediaCreated) = try await Self.inspect(asset, name: source.lastPathComponent)

        let sourceBytes = (attributes[.size] as? NSNumber)?.int64Value ?? 0
        let free = volumeProvider(root).availableBytes
        guard free >= minimumFreeBytes + sourceBytes else {
            throw ControlFailure(code: "low-disk",
                message: "Not enough free space to import this video. Free at least \(Self.gigabytes(minimumFreeBytes + sourceBytes - free)) GB and try again.",
                details: ["availableBytes": .int(free), "requiredBytes": .int(minimumFreeBytes + sourceBytes)])
        }

        let canonicalRoot = RecordingPackage.canonicalRoot(root)
        try Self.ensureRoot(canonicalRoot)
        let id = RecordingId.generate()
        let staging = canonicalRoot.appendingPathComponent("\(Self.stagingPrefix)\(id)", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: false)
        do {
            let imported = try await build(in: staging, root: canonicalRoot, id: id, source: source,
                                           asset: asset, video: video, audio: audio,
                                           mediaCreated: mediaCreated, attributes: attributes,
                                           sourceBytes: sourceBytes)
            return imported
        } catch {
            try? FileManager.default.removeItem(at: staging)
            if error is ControlFailure { throw error }
            throw ControlFailure(code: "import-failed",
                message: "Rushes could not copy this video into the library: \(error.localizedDescription)")
        }
    }

    // MARK: - Steps

    private func build(
        in staging: URL, root: URL, id: String, source: URL, asset: AVURLAsset,
        video: AVAssetTrack, audio: AVAssetTrack?, mediaCreated: Date?,
        attributes: [FileAttributeKey: Any], sourceBytes: Int64
    ) async throws -> Imported {
        let videoRange = try await video.load(.timeRange)
        var end = videoRange.end
        if let audio {
            let audioRange = try await audio.load(.timeRange)
            if audioRange.end.isValid, audioRange.end > .zero { end = min(end, audioRange.end) }
        }
        let trimmed = videoRange.end.isNumeric && end.isNumeric ? CMTimeSubtract(videoRange.end, end) : .zero
        let trimmedVideoMs = trimmed.isNumeric ? Int64((max(0, trimmed.seconds) * 1000).rounded()) : 0
        guard end.isValid, end.isNumeric, end > .zero else {
            throw ControlFailure(code: "unsupported-file", message: "\(source.lastPathComponent) has no playable duration.")
        }

        let screenURL = staging.appendingPathComponent(RecordingPackage.trackFileName(for: .screen))
        try await Self.copyTrack(video, of: asset, to: screenURL, end: end,
                                 transform: try await video.load(.preferredTransform))
        let micURL = staging.appendingPathComponent(RecordingPackage.trackFileName(for: .microphone))
        if let audio { try await Self.copyTrack(audio, of: asset, to: micURL, end: end, transform: nil) }

        let screenProbe = await MediaProbing.probe(url: screenURL)
        guard screenProbe.openable, let seconds = screenProbe.durationSeconds, seconds > 0 else {
            throw ControlFailure(code: "import-failed", message: "The copied video could not be read back.")
        }
        var durationSeconds = seconds
        if audio != nil {
            let micProbe = await MediaProbing.probe(url: micURL)
            guard micProbe.openable, let micSeconds = micProbe.durationSeconds, micSeconds > 0 else {
                throw ControlFailure(code: "import-failed", message: "The copied audio could not be read back.")
            }
            // Both files end at the same cut; split any container rounding.
            durationSeconds = (seconds + micSeconds) / 2
        }

        let iso = ISO8601DateFormatter()
        let now = Date()
        let fileCreated = attributes[.creationDate] as? Date
        let fileModified = attributes[.modificationDate] as? Date
        let info = RecordingManifest.ImportInfo(
            originalFilename: source.lastPathComponent,
            importedAt: iso.string(from: now),
            mediaCreatedAt: mediaCreated.map(iso.string(from:)),
            fileCreatedAt: fileCreated.map(iso.string(from:)),
            fileModifiedAt: fileModified.map(iso.string(from:)),
            sourceBytes: sourceBytes,
            hasAudio: audio != nil)

        let tracks = try await Self.manifestTracks(video: video, audio: audio)
        let hostNow = hostNowNs()
        let title = (source.lastPathComponent as NSString).deletingPathExtension
        var manifest = RecordingManifest(
            id: id,
            title: title.isEmpty ? source.lastPathComponent : title,
            // The library sorts by when the video was made, not imported.
            createdAt: iso.string(from: mediaCreated ?? fileCreated ?? fileModified ?? now),
            createdHostNs: hostNow,
            startedHostNs: hostNow,
            endedHostNs: hostNow,
            status: .complete,
            clock: .init(epochHostNs: hostNow, durationNs: Int64((durationSeconds * 1e9).rounded()), pausesNs: []),
            sources: .init(mode: "import"),
            tracks: tracks)
        manifest.imported = info

        let finalFolder = root.appendingPathComponent(RecordingPackage.folderName(for: now, id: id), isDirectory: true)
        let staged = RecordingPackage(root: root, id: id, folderURL: staging)
        try staged.writeManifest(manifest)
        try beforeCommit?(staging)
        guard !FileManager.default.fileExists(atPath: finalFolder.path) else {
            throw RecordingPackage.PackageError.folderAlreadyExists(path: finalFolder.path)
        }
        if Darwin.rename(staging.path, finalFolder.path) != 0 {
            throw AtomicFileWriter.WriteError.renameFailed(from: staging.path, to: finalFolder.path, errno: errno)
        }
        let dirFD = Darwin.open(root.path, O_RDONLY)
        if dirFD >= 0 { _ = Darwin.fsync(dirFD); Darwin.close(dirFD) }
        var result = Imported(package: RecordingPackage(root: root, id: id, folderURL: finalFolder), manifest: manifest)
        result.trimmedVideoMs = trimmedVideoMs
        return result
    }

    static func validateSourceFile(_ source: URL) throws -> [FileAttributeKey: Any] {
        guard source.isFileURL, source.path.hasPrefix("/") else {
            throw ControlFailure(code: ControlErrorCode.invalidParams, message: "Import needs an absolute path to a local video file.")
        }
        let name = source.lastPathComponent
        let attributes: [FileAttributeKey: Any]
        do {
            attributes = try FileManager.default.attributesOfItem(atPath: source.resolvingSymlinksInPath().path)
        } catch {
            // Generic on purpose: never describe what else exists at a path.
            throw ControlFailure(code: ControlErrorCode.notFound, message: "The selected video could not be found.")
        }
        guard (attributes[.type] as? FileAttributeType) == .typeRegular else {
            throw ControlFailure(code: "unsupported-file", message: "\(name) is not a video file.")
        }
        guard acceptedExtensions.contains(source.pathExtension.lowercased()) else {
            throw ControlFailure(code: "unsupported-file",
                message: "\(name) is not an MP4, MOV or M4V video. Rushes imports .mp4, .mov and .m4v files.")
        }
        guard FileManager.default.isReadableFile(atPath: source.path) else {
            throw ControlFailure(code: "permission-denied", message: "The selected video could not be read. Check its permissions.")
        }
        return attributes
    }

    static func inspect(_ asset: AVURLAsset, name: String) async throws -> (AVAssetTrack, AVAssetTrack?, Date?) {
        let protected: Bool
        let videos: [AVAssetTrack]
        let audios: [AVAssetTrack]
        do {
            protected = try await asset.load(.hasProtectedContent)
            videos = try await asset.loadTracks(withMediaType: .video)
            audios = try await asset.loadTracks(withMediaType: .audio)
        } catch {
            throw ControlFailure(code: "unsupported-file",
                message: "\(name) could not be opened as a video: \(error.localizedDescription)")
        }
        if protected {
            throw ControlFailure(code: "protected-content",
                message: "\(name) is copy-protected (DRM) and cannot be imported.")
        }
        guard let video = videos.first else {
            throw ControlFailure(code: "no-video", message: "\(name) has no video track.")
        }
        guard try await video.load(.isDecodable) else {
            throw ControlFailure(code: "unsupported-file", message: "\(name) uses a video format this Mac cannot play.")
        }
        var playableAudio: AVAssetTrack?
        if let audio = audios.first, (try? await audio.load(.isDecodable)) == true { playableAudio = audio }
        let created = try? await asset.load(.creationDate)
        let createdDate = try? await created?.load(.dateValue)
        return (video, playableAudio, createdDate ?? nil)
    }

    private static func manifestTracks(video: AVAssetTrack, audio: AVAssetTrack?) async throws -> [RecordingManifest.RecordingTrack] {
        let size = try await video.load(.naturalSize)
        let transform = try await video.load(.preferredTransform)
        let shown = size.applying(transform)
        let fps = try await video.load(.nominalFrameRate)
        let videoFormat = try await video.load(.formatDescriptions).first
        var tracks = [RecordingManifest.RecordingTrack(
            kind: .screen,
            codec: videoFormat.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) },
            width: Int(abs(shown.width).rounded()),
            height: Int(abs(shown.height).rounded()),
            fps: fps > 0 ? Int(fps.rounded()) : nil)]
        if let audio {
            let format = try await audio.load(.formatDescriptions).first
            let basic = format.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
            tracks.append(.init(
                kind: .microphone,
                codec: format.map { fourCC(CMFormatDescriptionGetMediaSubType($0)) },
                sampleRate: basic.map { Int($0.mSampleRate) },
                channels: basic.map { Int($0.mChannelsPerFrame) }))
        }
        return tracks
    }

    private static func fourCC(_ code: FourCharCode) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> $0) & 0xFF) }
        let text = String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespaces)
        switch text {
        case "avc1": return "h264"
        case "hvc1", "hev1": return "hevc"
        case "aac ": return "aac"
        default: return text.isEmpty ? "unknown" : text
        }
    }

    private static func ensureRoot(_ root: URL) throws {
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else { throw RecordingPackage.PackageError.rootNotFolder(path: root.path) }
        } else {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        }
    }

    private static func gigabytes(_ bytes: Int64) -> String {
        String(format: "%.1f", max(0.1, Double(bytes) / 1_073_741_824))
    }

    // MARK: - Sample copy

    /// Reader and writer pair driven on one serial queue. AVFoundation's
    /// blocking reads stay off Swift's cooperative executor.
    private final class Copy: @unchecked Sendable {
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        let writer: AVAssetWriter
        let input: AVAssetWriterInput
        private var finished = false
        init(reader: AVAssetReader, output: AVAssetReaderTrackOutput, writer: AVAssetWriter, input: AVAssetWriterInput) {
            self.reader = reader; self.output = output; self.writer = writer; self.input = input
        }
        /// Called on the copy queue only. Returns nil while more data is
        /// pending, or the outcome once the track is fully copied.
        func pump() -> Result<Void, Error>? {
            guard !finished else { return nil }
            while input.isReadyForMoreMediaData {
                guard let sample = output.copyNextSampleBuffer() else {
                    finished = true
                    input.markAsFinished()
                    if reader.status == .failed {
                        return .failure(reader.error ?? ControlFailure(code: "import-failed", message: "The source could not be read."))
                    }
                    return .success(())
                }
                if !input.append(sample) {
                    finished = true
                    input.markAsFinished()
                    return .failure(writer.error ?? ControlFailure(code: "import-failed", message: "The copy could not be written."))
                }
            }
            return nil
        }
    }

    /// Copies one track without re-encoding into its own QuickTime movie,
    /// presenting it from zero to `end`.
    private static func copyTrack(_ track: AVAssetTrack, of asset: AVURLAsset, to url: URL,
                                  end: CMTime, transform: CGAffineTransform?) async throws {
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw ControlFailure(code: "import-failed", message: "The source track cannot be read.") }
        reader.add(output)
        let format = try await track.load(.formatDescriptions).first
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: track.mediaType, outputSettings: nil, sourceFormatHint: format)
        input.expectsMediaDataInRealTime = false
        if let transform { input.transform = transform }
        guard writer.canAdd(input) else {
            throw ControlFailure(code: "unsupported-file", message: "This video's format cannot be stored in a Rushes recording.")
        }
        writer.add(input)
        guard reader.startReading() else {
            throw reader.error ?? ControlFailure(code: "import-failed", message: "The source could not be read.")
        }
        guard writer.startWriting() else {
            reader.cancelReading()
            throw writer.error ?? ControlFailure(code: "import-failed", message: "The copy could not be started.")
        }
        writer.startSession(atSourceTime: .zero)
        let copy = Copy(reader: reader, output: output, writer: writer, input: input)
        let queue = DispatchQueue(label: "rushes.import.copy")
        let outcome: Result<Void, Error> = await withCheckedContinuation { continuation in
            input.requestMediaDataWhenReady(on: queue) {
                if let result = copy.pump() { continuation.resume(returning: result) }
            }
        }
        if case .failure(let error) = outcome {
            reader.cancelReading()
            writer.cancelWriting()
            throw error
        }
        writer.endSession(atSourceTime: end)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting { continuation.resume() }
        }
        guard writer.status == .completed else {
            throw writer.error ?? ControlFailure(code: "import-failed", message: "The copy could not be finished.")
        }
    }
}
