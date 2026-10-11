import Foundation

public enum DiagnosticRedactor {
    public static func redact(_ text: String, homePath: String = FileManager.default.homeDirectoryForCurrentUser.path) -> String {
        var result = text.replacingOccurrences(of: "\\/", with: "/")
        // URL queries can contain signed credentials. Fragments and userinfo are removed too.
        let urlPattern = #"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s\"'<>]+"#
        if let regex = try? NSRegularExpression(pattern: urlPattern) {
            for match in regex.matches(in: result, range: NSRange(result.startIndex..., in: result)).reversed() {
                guard let range = Range(match.range, in: result) else { continue }
                var value = String(result[range])
                if let question = value.firstIndex(where: { $0 == "?" || $0 == "#" }) { value = String(value[..<question]) }
                if let parts = URLComponents(string: value), parts.user != nil || parts.password != nil {
                    var cleaned = parts; cleaned.user = nil; cleaned.password = nil
                    value = cleaned.string ?? "<url>"
                }
                result.replaceSubrange(range, with: value)
            }
        }
        if !homePath.isEmpty { result = result.replacingOccurrences(of: homePath, with: "<home>") }
        result = replace(pattern: #"/(?:Users|home)/[^\s/\\\"']+"#, in: result, with: "<home>")
        result = replace(pattern: #"(?i)(bearer\s+)[^\s\"',;]+"#, in: result, with: "$1<redacted>")
        result = replace(pattern: #"(?i)((?:token|secret|password|api[_-]?key|authorization|access[_-]?key|cookie)\s*[\"']?\s*[:=]\s*[\"']?)[^\s\"',;]+"#,
                         in: result, with: "$1<redacted>")
        return result
    }
    private static func replace(pattern: String, in text: String, with replacement: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        return regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement)
    }
}

public enum DiagnosticsBundle {
    /// Writes text only. Caller chooses state/log entries; media and transcript contents are never collected automatically.
    public static func write(outputURL: URL, entries: [String: String], homePath: String = FileManager.default.homeDirectoryForCurrentUser.path) throws -> URL {
        guard outputURL.isFileURL, outputURL.pathExtension.lowercased() == "zip", entries.count <= 100,
              entries.allSatisfy({ key, value in
                !key.isEmpty && key.count <= 120 && !key.hasPrefix(".") &&
                key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_") }) &&
                value.utf8.count <= 4_194_304
              }) else { throw ControlFailure(code: "invalid-params", message: "Diagnostics requires a local .zip path and bounded plain-text entries with safe names.") }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-diagnostics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        let staged = outputURL.deletingLastPathComponent().appendingPathComponent(".diagnostics-\(UUID().uuidString).zip")
        defer { try? FileManager.default.removeItem(at: folder); try? FileManager.default.removeItem(at: staged) }
        for (name, value) in entries {
            let redacted = DiagnosticRedactor.redact(value, homePath: homePath)
            try AtomicFileWriter.write(Data(redacted.utf8), to: folder.appendingPathComponent(name))
        }
        let manifest = "Rushes local diagnostics\nCreated: \(ISO8601DateFormatter().string(from: Date()))\nAudio/video/transcripts are not collected. Home paths, URL queries, URL credentials and common secret fields are redacted.\n"
        try AtomicFileWriter.write(Data(manifest.utf8), to: folder.appendingPathComponent("README.txt"))
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-c", "-k", folder.path, staged.path]
        let errors = Pipe(); process.standardError = errors
        try process.run(); let errorData = errors.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw ControlFailure(code: "diagnostics-archive-failed", message: DiagnosticRedactor.redact(String(decoding: errorData, as: UTF8.self), homePath: homePath))
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: staged.path)
        try AtomicFileWriter.posixRename(from: staged, to: outputURL)
        return outputURL
    }
}
