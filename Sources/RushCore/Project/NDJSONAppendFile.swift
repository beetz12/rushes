import Foundation

/// Append-only NDJSON writer: one JSON object per line.
///
/// Backs `input.ndjson` (pointer, clicks, keys) and `log.ndjson`. The file is
/// opened with `O_APPEND`, so every write lands at the end even across
/// processes; `fsyncPerLine` makes each line durable as it is written, which
/// the input timeline uses so a crash keeps the cursor data.
///
/// Lines are never rewritten or reordered: the file is a log, not a document.
public final class NDJSONAppendFile: @unchecked Sendable {

    /// The file being appended to.
    public let url: URL

    private let lock = NSLock()
    private var fd: Int32
    private let fsyncPerLine: Bool

    public enum AppendError: Error, Equatable, Sendable, CustomStringConvertible {
        case openFailed(path: String, errno: Int32)
        case writeFailed(path: String, errno: Int32)
        case syncFailed(path: String, errno: Int32)
        case closed(path: String)

        public var description: String {
            switch self {
            case .openFailed(let path, let errno):
                return "could not open \(path) for append: errno \(errno)"
            case .writeFailed(let path, let errno):
                return "could not append to \(path): errno \(errno)"
            case .syncFailed(let path, let errno):
                return "could not fsync \(path): errno \(errno)"
            case .closed(let path):
                return "\(path) is closed"
            }
        }
    }

    /// Opens (or creates) `url` for appending.
    ///
    /// - Parameter fsyncPerLine: when true, every appended line is fsynced
    ///   before `append` returns.
    public init(url: URL, fsyncPerLine: Bool = false) throws {
        self.url = url
        self.fsyncPerLine = fsyncPerLine
        let opened = Darwin.open(url.path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
        guard opened >= 0 else {
            throw AppendError.openFailed(path: url.path, errno: errno)
        }
        self.fd = opened
    }

    /// Appends the JSON encoding of `object` as one line.
    public func append(_ object: some Encodable) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try appendData(try encoder.encode(object))
    }

    /// Appends one pre-encoded JSON object as a line.
    public func append(json data: Data) throws {
        try appendData(data)
    }

    private func appendData(_ data: Data) throws {
        var line = Data(data)
        line.append(0x0A)  // newline terminates the object

        lock.lock()
        defer { lock.unlock() }
        guard fd >= 0 else { throw AppendError.closed(path: url.path) }
        var offset = 0
        try line.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            guard let base = raw.baseAddress else { return }
            while offset < raw.count {
                let written = Darwin.write(fd, base + offset, raw.count - offset)
                if written > 0 {
                    offset += written
                } else if written < 0 && errno == EINTR {
                    continue
                } else {
                    throw AppendError.writeFailed(path: url.path, errno: errno)
                }
            }
        }
        if fsyncPerLine, Darwin.fsync(fd) != 0 {
            throw AppendError.syncFailed(path: url.path, errno: errno)
        }
    }

    /// Closes the file. Further appends throw; closing twice is a no-op.
    public func close() {
        lock.lock()
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
        lock.unlock()
    }

    deinit {
        if fd >= 0 { Darwin.close(fd) }
    }
}
