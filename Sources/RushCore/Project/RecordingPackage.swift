import Foundation

/// One take's folder on disk: a plain folder under the recordings root, not
/// a macOS bundle, so Finder and David's editor open the files directly
/// (docs/PLAN.md, Package layout).
///
/// The folder name is the start time plus the first six characters of the
/// recording id; the id is a ULID that sorts by creation time. A new take
/// always gets a new package, so one recording can never overwrite the last
/// one.
public struct RecordingPackage: Equatable, Sendable {

    /// Problems creating or resolving packages.
    public enum PackageError: Error, Equatable, Sendable, CustomStringConvertible {
        case folderAlreadyExists(path: String)
        case notADirectory(path: String)
        case rootNotFolder(path: String)

        public var description: String {
            switch self {
            case .folderAlreadyExists(let path):
                return "package folder already exists: \(path)"
            case .notADirectory(let path):
                return "package path is not a folder: \(path)"
            case .rootNotFolder(let path):
                return "recordings root exists and is not a folder: \(path)"
            }
        }
    }

    /// The recordings root: `~/Movies/Rushes`. The OS does not purge it and
    /// David's editor can browse it (docs/PLAN.md, storage location).
    public static var defaultRoot: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Movies/Rushes", isDirectory: true)
    }

    /// The recordings root this package lives under (injectable for tests).
    public let root: URL

    /// The full 26-character recording id.
    public let id: String

    /// The package folder itself.
    public let folderURL: URL

    // MARK: - Naming

    /// The track file names per the plan's package layout.
    public static func trackFileName(for kind: TrackKind) -> String {
        switch kind {
        case .screen: return "screen.mov"
        case .camera: return "camera.mov"
        case .microphone: return "mic.mov"
        case .systemAudio: return "system.mov"
        }
    }

    /// `<date>_<id prefix>`: the start time in `yyyy-MM-dd_HH-mm-ss` plus the
    /// first six characters of the recording id.
    public static func folderName(for date: Date, id: String, timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return "\(formatter.string(from: date))_\(RecordingId.folderPrefix(id))"
    }

    /// Whether a folder name in the recordings root looks like a package
    /// folder (`..._<6 id characters>`).
    public static func isPackageFolderName(_ name: String) -> Bool {
        guard let underscore = name.lastIndex(of: "_") else { return false }
        let prefix = name[..<underscore]
        let suffix = name[name.index(after: underscore)...]
        guard suffix.count == 6 else { return false }
        let digits = prefix.filter { $0 == "-" || $0 == "_" || $0.isNumber }
        return digits.count == prefix.count && prefix.count >= 8
    }

    // MARK: - Creation and resolution

    /// Creates a fresh package folder under `root`, including the root
    /// itself when missing. The folder is never reused: a name collision
    /// (same second and the same six id characters) throws instead of
    /// touching the existing folder.
    public static func create(
        root: URL = RecordingPackage.defaultRoot,
        date: Date = Date(),
        id: String = RecordingId.generate()
    ) throws -> RecordingPackage {
        precondition(RecordingId.isValid(id), "recording id must be a ULID")
        let root = canonicalRoot(root)
        let fileManager = FileManager.default

        if fileManager.fileExists(atPath: root.path) {
            var isDirectory: ObjCBool = false
            fileManager.fileExists(atPath: root.path, isDirectory: &isDirectory)
            guard isDirectory.boolValue else { throw PackageError.rootNotFolder(path: root.path) }
        } else {
            try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        }

        let folderName = folderName(for: date, id: id)
        let folderURL = root.appendingPathComponent(folderName, isDirectory: true)
        guard !fileManager.fileExists(atPath: folderURL.path) else {
            throw PackageError.folderAlreadyExists(path: folderURL.path)
        }
        try fileManager.createDirectory(at: folderURL, withIntermediateDirectories: false)
        return RecordingPackage(root: root, id: id, folderURL: folderURL)
    }

    /// The root with symlinks resolved, so packages created by path and
    /// packages discovered by a directory scan always compare equal
    /// (`contentsOfDirectory` returns resolved paths, e.g.
    /// `/private/var` where the caller said `/var`; Foundation's
    /// `resolvingSymlinksInPath` leaves that one alone).
    static func canonicalRoot(_ root: URL) -> URL {
        let path = root.path
        if let resolved = path.withCString({ realpath($0, nil) }) {
            defer { free(resolved) }
            return URL(fileURLWithPath: String(cString: resolved), isDirectory: true)
        }
        // The folder is not there yet: canonicalize the existing parent and
        // rejoin the new component.
        let parent = (path as NSString).deletingLastPathComponent
        if let resolvedParent = parent.withCString({ realpath($0, nil) }) {
            defer { free(resolvedParent) }
            let canonical = (String(cString: resolvedParent) as NSString)
                .appendingPathComponent((path as NSString).lastPathComponent)
            return URL(fileURLWithPath: canonical, isDirectory: true)
        }
        return root
    }

    /// Wraps an existing package folder without reading anything from it.
    public static func open(folderURL: URL) throws -> RecordingPackage {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: folderURL.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            throw PackageError.notADirectory(path: folderURL.path)
        }
        return RecordingPackage(
            root: folderURL.deletingLastPathComponent(),
            id: "",
            folderURL: folderURL)
    }

    /// Finds the package for a recording id under `root`. The folder name
    /// only carries the first six id characters, so candidates are confirmed
    /// against the full id in the manifest before being returned.
    public static func resolve(root: URL, id: String) -> RecordingPackage? {
        let root = canonicalRoot(root)
        let prefix = RecordingId.folderPrefix(id)
        guard let candidates = try? FileManager.default.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey])
        else { return nil }
        for candidate in candidates.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard candidate.hasDirectoryPath,
                  candidate.lastPathComponent.hasSuffix("_\(prefix)") else { continue }
            let package = RecordingPackage(
                root: root, id: id, folderURL: candidate)
            if let manifest = try? package.readManifest(), manifest.id == id {
                return package
            }
        }
        return nil
    }

    /// One scan result of the recordings root.
    public struct ScanEntry: Equatable, Sendable {
        public let package: RecordingPackage
        public let manifest: RecordingManifest
    }

    /// Every folder under `root` that holds a parseable manifest. Folders
    /// whose manifest is missing or unreadable are skipped: the manifest is
    /// the source of truth for indexing, recovery and listing.
    public static func scanManifests(root: URL) throws -> [ScanEntry] {
        let root = canonicalRoot(root)
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: root.path) else { return [] }
        let folders = try fileManager.contentsOfDirectory(
            at: root, includingPropertiesForKeys: [.isDirectoryKey])
        var entries: [ScanEntry] = []
        for folder in folders.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            guard folder.hasDirectoryPath else { continue }
            let package = RecordingPackage(root: root, id: "", folderURL: folder)
            guard let manifest = try? package.readManifest() else { continue }
            entries.append(
                ScanEntry(
                    package: RecordingPackage(root: root, id: manifest.id, folderURL: folder),
                    manifest: manifest))
        }
        return entries
    }

    // MARK: - Layout

    /// `manifest.json`.
    public var manifestURL: URL { folderURL.appendingPathComponent("manifest.json") }

    /// `input.ndjson`, the append-only input timeline.
    public var inputURL: URL { folderURL.appendingPathComponent("input.ndjson") }

    /// `edit.json`, the last explicit save of the edit document (Phase 4).
    public var editURL: URL { folderURL.appendingPathComponent("edit.json") }

    /// `edit.json.bak`, the previous generation of the edit document.
    public var editBackupURL: URL { folderURL.appendingPathComponent("edit.json.bak") }

    /// `edit.draft.json`, the autosaved draft.
    public var editDraftURL: URL { folderURL.appendingPathComponent("edit.draft.json") }

    /// `log.ndjson`, session events without secrets or signed URLs.
    public var logURL: URL { folderURL.appendingPathComponent("log.ndjson") }

    /// `transcript.json` (Phase 4).
    public var transcriptURL: URL { folderURL.appendingPathComponent("transcript.json") }

    /// `captions.vtt` (Phase 4).
    public var captionsURL: URL { folderURL.appendingPathComponent("captions.vtt") }

    /// `poster.jpg`.
    public var posterURL: URL { folderURL.appendingPathComponent("poster.jpg") }

    /// `jobs.json`, the post-stop job list.
    public var jobsURL: URL { folderURL.appendingPathComponent("jobs.json") }

    /// `cursors/`, cursor images by hash (data mode, Phase 6).
    public var cursorsDirectory: URL { folderURL.appendingPathComponent("cursors", isDirectory: true) }

    /// `renders/`, cached deliverables and their render stamps.
    public var rendersDirectory: URL { folderURL.appendingPathComponent("renders", isDirectory: true) }

    /// `share/`, share state.
    public var shareDirectory: URL { folderURL.appendingPathComponent("share", isDirectory: true) }

    /// The file of one track inside the package.
    public func trackURL(for kind: TrackKind) -> URL {
        folderURL.appendingPathComponent(Self.trackFileName(for: kind))
    }

    // MARK: - Manifest I/O

    /// Reads and validates the manifest.
    public func readManifest() throws -> RecordingManifest {
        try RecordingManifest.parse(try Data(contentsOf: manifestURL))
    }

    /// Writes the manifest atomically (temporary file, fsync, rename, folder
    /// fsync). Output is stable JSON: sorted keys, no unescaped slashes.
    public func writeManifest(_ manifest: RecordingManifest) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        try AtomicFileWriter.writeEncodable(manifest, to: manifestURL, encoder: encoder)
    }

    public static func == (lhs: RecordingPackage, rhs: RecordingPackage) -> Bool {
        lhs.folderURL == rhs.folderURL && lhs.id == rhs.id
    }
}
