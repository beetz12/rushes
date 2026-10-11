import Foundation
import Testing
import FoundationModels
@testable import RushCore

@Suite("Local metadata")
struct MetadataTests {
    @Test("Extractive chapters span a ten-minute transcript and remain grounded")
    func wholeRecording() async throws {
        let words = (0..<600).map { TranscriptWord(id: "\($0)", text: "Topic\($0)", startMs: Double($0 * 1000), endMs: Double($0 * 1000 + 600)) }
        let doc = try TranscriptDocument(locale: "en", inputFile: "mic.mov", durationMs: 600_000, words: words)
        let metadata = try await MetadataService.generate(transcript: doc, preferLanguageModel: false)
        #expect(metadata.engine == "extractive-fallback")
        #expect(metadata.chapters.first?.startMs == 0)
        #expect(try #require(metadata.chapters.last?.startMs) > 420_000)
        #expect(metadata.chapters.allSatisfy { words.map(\.text).contains($0.title.components(separatedBy: " ").first ?? "") })
        let text = try ChapterExport.youtube(metadata.chapters)
        #expect(text.hasPrefix("0:00 ")); #expect(text.split(separator: "\n").count == metadata.chapters.count)
        try metadata.validate(durationMs: doc.durationMs)
    }
    @Test("Sampling includes both ends and one-point sampling is safe")
    func sampling() {
        let words = (0..<1000).map { TranscriptWord(id: "\($0)", text: "word", startMs: Double($0), endMs: Double($0 + 1)) }
        let samples = MetadataService.sample(words, count: 70)
        #expect(samples.count == 70); #expect(samples.first?.id == "0"); #expect(samples.last?.id == "999")
        #expect(MetadataService.sample(words, count: 1).count == 1); #expect(MetadataService.sample(words, count: 0).isEmpty)
    }
    @Test("Chapter validation rejects unsafe and unordered metadata")
    func validatesChapters() throws {
        #expect(throws: ControlFailure.self) { try ChapterExport.youtube([.init(startMs: 10, title: "Start")]) }
        #expect(throws: ControlFailure.self) { try ChapterExport.youtube([.init(startMs: 0, title: "Start"), .init(startMs: 0, title: "Again")]) }
        #expect(throws: ControlFailure.self) { try ChapterExport.youtube([.init(startMs: 0, title: "Inject\n0:00 bad")]) }
        let hour = try ChapterExport.youtube([.init(startMs: 0, title: "Start"), .init(startMs: 3_661_000, title: "Later")])
        #expect(hour.contains("01:01:01 Later"))
    }
    @Test("Oversized finite chapter time is rejected before integer formatting")
    func oversizedChapter() throws {
        #expect(throws: ControlFailure.self) {
            try ChapterExport.youtube([.init(startMs: 0, title: "Start"), .init(startMs: 1e30, title: "Later")])
        }
    }
    @Test("User metadata roundtrips and never alters source media")
    func metadataPersistence() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: folder) }
        let request = ControlRequest(id: "meta", cmd: "meta.set", args: .object(["title": .string("My take"), "summary": .string("Summary"), "chapters": .array([.object(["startMs": .int(0), "title": .string("Introduction")])])]))
        let result = try await MetadataCommands.handle(request: request, packageURL: folder)
        #expect(result["title"]?.string == "My take")
        #expect(try MetadataService.read(from: folder).chapters.count == 1)
    }
}

@Suite("Live on-device metadata", .enabled(if: ProcessInfo.processInfo.environment["RUSHES_SPEECH_FIXTURE"] != nil))
struct LiveMetadataTests {
    @Test("Uses the real on-device language model when available and identifies unavailable fallback")
    func modelAvailability() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["RUSHES_SPEECH_FIXTURE"])
        let transcript = try await TranscriptService.transcribe(audioURL: URL(fileURLWithPath: path))
        let availability = SystemLanguageModel.default.availability
        let result = try await MetadataService.generate(transcript: transcript)
        print("LIVE_METADATA availability=\(availability) engine=\(result.engine) title=\(result.title) warning=\(result.warning ?? "none")")
        if availability == .available {
            #expect(result.engine == "Apple FoundationModels (on-device)")
            #expect(result.warning == nil)
        } else {
            #expect(result.engine == "extractive-fallback")
            #expect(result.warning != nil)
        }
        try result.validate(durationMs: transcript.durationMs)
    }
}
