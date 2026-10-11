import Foundation
import Testing
@testable import RushCore

@Suite("Private local diagnostics")
struct DiagnosticsTests {
    @Test("Home paths, query signatures, credentials and common secrets are redacted")
    func redacts() {
        let source = #"path=/Users/dave/Movies/take url=https://user:pass@example.com/video?signature=private#fragment token=private Authorization: Bearer private password="private" other=/Users/alice/Documents"#
        let clean = DiagnosticRedactor.redact(source, homePath: "/Users/dave")
        #expect(!clean.contains("/Users/")); #expect(!clean.contains("signature"))
        #expect(!clean.contains("private")); #expect(!clean.contains("user:pass"))
        #expect(clean.contains("https://example.com/video"))
    }
    @Test("ZIP roundtrip contains no home path or URL query")
    func archive() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: folder) }
        let zip = folder.appendingPathComponent("diag.zip")
        try DiagnosticsBundle.write(outputURL: zip, entries: ["status.json": #"{"path":"/Users/dave/Movies","url":"https://example.com?a=secret","token":"secret"}"#], homePath: "/Users/dave")
        #expect(FileManager.default.fileExists(atPath: zip.path))
        let output = folder.appendingPathComponent("unpacked")
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        process.arguments = ["-x", "-k", zip.path, output.path]; try process.run(); process.waitUntilExit()
        #expect(process.terminationStatus == 0)
        let text = try String(contentsOf: output.appendingPathComponent("status.json"), encoding: .utf8)
        #expect(!text.contains("/Users/dave")); #expect(!text.contains("?")); #expect(!text.contains("secret"))
        #expect(FileManager.default.fileExists(atPath: output.appendingPathComponent("README.txt").path))
    }
    @Test("Archive paths cannot escape the staging folder")
    func safeNames() {
        #expect(throws: ControlFailure.self) { try DiagnosticsBundle.write(outputURL: URL(fileURLWithPath: "/tmp/diag.zip"), entries: ["../secret": "x"]) }
        #expect(throws: ControlFailure.self) { try DiagnosticsBundle.write(outputURL: URL(fileURLWithPath: "/tmp/diag.txt"), entries: ["status": "x"]) }
    }
}
