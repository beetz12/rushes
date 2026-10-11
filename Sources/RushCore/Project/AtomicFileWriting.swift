import Foundation

/// Atomic file writes for every piece of package metadata.
///
/// The plan's rule (docs/PLAN.md, Project format / Rules): write a temporary
/// file in the same folder, fsync it, rename it over the target, fsync the
/// folder. A reader therefore sees either the whole previous file or the
/// whole new one, never a torn write; a truncated file is rejected at load,
/// never half-loaded.
///
/// The rename step is injectable so tests can simulate a crash between fsync
/// and rename and assert the temporary file is cleaned up.
public enum AtomicFileWriter {

    /// One failed step of an atomic write, with the POSIX errno where one
    /// applies.
    public enum WriteError: Error, Equatable, Sendable, CustomStringConvertible {
        case createFailed(path: String, errno: Int32)
        case writeFailed(path: String, errno: Int32)
        case syncFailed(path: String, errno: Int32)
        case renameFailed(from: String, to: String, errno: Int32)
        case directorySyncFailed(path: String, errno: Int32)

        public var description: String {
            switch self {
            case .createFailed(let path, let errno):
                return "could not create temporary file at \(path): errno \(errno)"
            case .writeFailed(let path, let errno):
                return "could not write temporary file at \(path): errno \(errno)"
            case .syncFailed(let path, let errno):
                return "could not fsync temporary file at \(path): errno \(errno)"
            case .renameFailed(let from, let to, let errno):
                return "could not rename \(from) to \(to): errno \(errno)"
            case .directorySyncFailed(let path, let errno):
                return "could not fsync folder \(path): errno \(errno)"
            }
        }
    }

    /// Performs the rename step. The default is POSIX `rename(2)`, which
    /// atomically replaces the target when both files are on one filesystem.
    public typealias Rename = @Sendable (_ from: URL, _ to: URL) throws -> Void

    /// The production rename.
    public static func posixRename(from: URL, to: URL) throws {
        if Darwin.rename(from.path, to.path) != 0 {
            throw WriteError.renameFailed(from: from.path, to: to.path, errno: errno)
        }
    }

    /// Atomically writes `data` to `url`.
    ///
    /// The temporary file lives in the same folder as the target and is
    /// removed whenever any step throws, so a failed write leaves no debris
    /// and never disturbs the previous contents of the target.
    public static func write(_ data: Data, to url: URL, rename: Rename = posixRename) throws {
        let folder = url.deletingLastPathComponent()
        let tempURL = folder.appendingPathComponent(
            ".\(url.lastPathComponent).tmp-\(UUID().uuidString)")

        let fd = Darwin.open(tempURL.path, O_WRONLY | O_CREAT | O_EXCL, 0o644)
        guard fd >= 0 else {
            throw WriteError.createFailed(path: tempURL.path, errno: errno)
        }

        var renamed = false
        var openFD = fd
        do {
            try writeAll(data, to: fd, path: tempURL.path)
            if Darwin.fsync(fd) != 0 {
                throw WriteError.syncFailed(path: tempURL.path, errno: errno)
            }
            Darwin.close(fd)
            openFD = -1
            try rename(tempURL, url)
            renamed = true
        } catch {
            if openFD >= 0 { Darwin.close(openFD) }
            if !renamed { Darwin.unlink(tempURL.path) }
            throw error
        }

        // Persist the rename itself, so a power loss right after the write
        // still leaves the target in place.
        let dirFD = Darwin.open(folder.path, O_RDONLY)
        guard dirFD >= 0 else {
            throw WriteError.directorySyncFailed(path: folder.path, errno: errno)
        }
        if Darwin.fsync(dirFD) != 0 {
            Darwin.close(dirFD)
            throw WriteError.directorySyncFailed(path: folder.path, errno: errno)
        }
        Darwin.close(dirFD)
    }

    /// Atomically writes the JSON encoding of `value` to `url`.
    public static func writeEncodable(
        _ value: some Encodable,
        to url: URL,
        encoder: JSONEncoder = JSONEncoder(),
        rename: Rename = posixRename
    ) throws {
        try write(try encoder.encode(value), to: url, rename: rename)
    }

    /// Writes every byte, retrying interrupts.
    private static func writeAll(_ data: Data, to fd: Int32, path: String) throws {
        var offset = 0
        try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            while offset < raw.count {
                let written = Darwin.write(fd, base + offset, raw.count - offset)
                if written > 0 {
                    offset += written
                } else if written < 0 && errno == EINTR {
                    continue
                } else {
                    throw WriteError.writeFailed(path: path, errno: errno)
                }
            }
        }
    }
}
