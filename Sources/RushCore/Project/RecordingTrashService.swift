import Foundation

/// The platform move seam. Production uses macOS Trash; tests move only their
/// own fixture directory. Expiring an undo token never deletes media.
public protocol RecordingTrashMoving: Sendable {
    func moveToTrash(_ url: URL) throws -> URL
    func restore(_ trashedURL: URL, to originalURL: URL) throws
}
public struct NativeRecordingTrashMover: RecordingTrashMoving {
    public init() {}
    public func moveToTrash(_ url: URL) throws -> URL {
        var destination: NSURL?
        try FileManager.default.trashItem(at: url, resultingItemURL: &destination)
        guard let destination else {
            throw ControlFailure(code: "trash-location-unavailable", message: "recording moved to Trash but the system returned no undo location")
        }
        return destination as URL
    }
    public func restore(_ trashedURL: URL, to originalURL: URL) throws {
        try FileManager.default.moveItem(at: trashedURL, to: originalURL)
    }
}

/// Whole-package move to Trash with a five-second, collision-safe undo. The
/// caller rebuilds its package index after success. No permanent deletion API.
public actor RecordingTrashService {
    public struct Receipt: Codable, Equatable, Sendable {
        public let id: String
        public let undoToken: String
        public let undoExpiresAt: String
        public let undoWindowMs: Int
        public let trashedPath: String
    }
    private struct Pending {
        let id: String
        let original: URL
        let trashed: URL
        let expires: Date
        let identity: FileIdentity
    }
    private struct FileIdentity: Equatable {
        let device: UInt64
        let inode: UInt64
    }
    private let root: URL
    private let mover: any RecordingTrashMoving
    private let now: @Sendable () -> Date
    private var pending: [String: Pending] = [:]
    public init(root: URL = RecordingPackage.defaultRoot, mover: any RecordingTrashMoving = NativeRecordingTrashMover(), now: @escaping @Sendable () -> Date = { Date() }) {
        self.root = root.standardizedFileURL.resolvingSymlinksInPath()
        self.mover = mover
        self.now = now
    }

    public func trash(id: String, activeRecordingID: String? = nil) throws -> Receipt {
        prune()
        try validateRoot()
        guard id != activeRecordingID else { throw ControlFailure(code: "recording-active", message: "stop the recording before moving it to Trash") }
        guard RecordingId.isValid(id), let package = RecordingPackage.resolve(root: root, id: id) else {
            throw ControlFailure(code: "not-found", message: "recording was not found")
        }
        guard (try FileManager.default.attributesOfItem(atPath: package.folderURL.path))[.type] as? FileAttributeType == .typeDirectory else {
            throw ControlFailure(code: "unsafe-package-path", message: "the recording package is not a direct directory")
        }
        let folder = package.folderURL.standardizedFileURL.resolvingSymlinksInPath()
        guard folder.deletingLastPathComponent().path == root.path else {
            throw ControlFailure(code: "unsafe-package-path", message: "recording is outside the library root")
        }
        let manifest = try package.readManifest()
        guard manifest.id == id else {
            throw ControlFailure(code: "invalid-manifest", message: "the recording manifest identity does not match the package")
        }
        guard [.complete, .recovered, .failed].contains(manifest.status) else {
            throw ControlFailure(code: "recording-active", message: "recover or stop the recording before moving it to Trash")
        }
        guard pending.count < 32 else {
            throw ControlFailure(code: "trash-undo-busy", message: "wait for a previous undo window to expire")
        }
        let trashed = try mover.moveToTrash(folder).standardizedFileURL
        guard !FileManager.default.fileExists(atPath: folder.path), FileManager.default.fileExists(atPath: trashed.path) else {
            throw ControlFailure(code: "trash-move-unverified", message: "the recording's move to Trash could not be verified")
        }
        let expires = now().addingTimeInterval(5)
        let token = UUID().uuidString
        pending[token] = Pending(id: id, original: folder, trashed: trashed, expires: expires, identity: try Self.identity(trashed))
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return Receipt(id: id, undoToken: token, undoExpiresAt: formatter.string(from: expires), undoWindowMs: 5000, trashedPath: trashed.path)
    }

    public func undo(token: String) throws -> String {
        guard let item = pending[token] else { throw ControlFailure(code: "undo-not-found", message: "undo token is unavailable") }
        guard now() < item.expires else {
            pending[token] = nil
            throw ControlFailure(code: "undo-expired", message: "the five-second undo window expired; footage remains in Trash")
        }
        try validateRoot()
        guard try Self.identity(item.trashed) == item.identity else {
            throw ControlFailure(code: "unsafe-trash-path", message: "the item in Trash changed; no item was restored")
        }
        guard !Self.itemExists(item.original) else {
            throw ControlFailure(code: "undo-path-occupied", message: "the original path is occupied; no item was overwritten")
        }
        try mover.restore(item.trashed, to: item.original)
        guard FileManager.default.fileExists(atPath: item.original.path), !FileManager.default.fileExists(atPath: item.trashed.path) else {
            throw ControlFailure(code: "undo-restore-unverified", message: "the recording's restore could not be verified")
        }
        pending[token] = nil
        return item.id
    }
    private func prune() {
        let instant = now()
        pending = pending.filter { $0.value.expires > instant }
    }
    private func validateRoot() throws {
        guard root.resolvingSymlinksInPath().path == root.path else {
            throw ControlFailure(code: "unsafe-package-path", message: "the library root changed; no item was moved")
        }
    }
    private static func itemExists(_ url: URL) -> Bool {
        // Attributes detect even a dangling symlink, which must never be
        // replaced by an undo operation.
        (try? FileManager.default.attributesOfItem(atPath: url.path)) != nil
    }
    private static func identity(_ url: URL) throws -> FileIdentity {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeDirectory,
              url.resolvingSymlinksInPath().path == url.path,
              let device = attributes[.systemNumber] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber else {
            throw ControlFailure(code: "unsafe-trash-path", message: "the item in Trash is not the original package directory")
        }
        return .init(device: device.uint64Value, inode: inode.uint64Value)
    }
}
