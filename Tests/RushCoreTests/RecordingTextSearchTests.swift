import Foundation
import Testing
@testable import RushCore

struct RecordingTextSearchTests {
    @Test func findsUnicodeAcrossChunkBoundaryAndTreatsSymbolsLiterally() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        try Data((String(repeating: "x", count: 65_534) + "你好 Mixed CASE 100% [phrase]").utf8).write(to: file)
        #expect(try RecordingTextSearch.contains("你好 mixed case", file: file))
        #expect(try RecordingTextSearch.contains("100% [phrase]", file: file))
        #expect(try !RecordingTextSearch.contains("100% wildcard", file: file))
        #expect(try !RecordingTextSearch.contains("missing", file: file))
    }
}
