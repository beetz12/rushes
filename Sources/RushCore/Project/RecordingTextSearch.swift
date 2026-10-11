import Foundation

/// Search generated transcript text with bounded memory, including chunk seams.
enum RecordingTextSearch {
    static func contains(_ query: String, file: URL) throws -> Bool {
        guard !query.isEmpty, query.count <= 256 else { return false }
        guard FileManager.default.fileExists(atPath: file.path) else { return false }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular else { throw ControlFailure(code: "unsafe-package-path", message: "Transcript search requires a regular text file") }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var overlap = Data()
        while let chunk = try handle.read(upToCount: 65_536), !chunk.isEmpty {
            var bytes = overlap
            bytes.append(chunk)
            if String(decoding: bytes, as: UTF8.self).localizedCaseInsensitiveContains(query) { return true }
            // A 256-character UTF-8 query needs at most 1024 bytes. Keep more
            // to cover a partial multibyte code point at the boundary too.
            overlap = Data(bytes.suffix(2048))
        }
        return false
    }
}
