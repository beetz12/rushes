import Foundation
import Testing
@testable import RushCore

private func speechWord(_ id: Int, _ text: String = "word", start: Double, end: Double) -> TranscriptWord {
    .init(id: "w\(id)", text: text, startMs: start, endMs: end)
}

@Suite("Transcription invariants")
struct TranscriptionTests {
    @Test("Caption limits across Unicode, overlap, long words and durations", arguments: ["ordinary words", "你好世界🙂", String(repeating: "a", count: 120)])
    func captionLimits(text: String) throws {
        let words = (0..<100).map { index in speechWord(index, text, start: Double(index * 200), end: Double(index * 200 + 300)) }
        let cues = try CaptionBuilder.build(words: words)
        #expect(!cues.isEmpty)
        #expect(cues.allSatisfy { $0.text.count <= 42 && $0.endMs - $0.startMs <= 4000 && $0.endMs > $0.startMs })
        for pair in zip(cues, cues.dropFirst()) {
            #expect(pair.1.startMs > pair.0.startMs); #expect(pair.1.endMs > pair.0.endMs)
            #expect(pair.1.startMs >= pair.0.endMs)
        }
        _ = try TranscriptDocument(locale: "en-US", inputFile: "mic.mov", durationMs: 22_000, words: words, cues: cues)
    }
    @Test("Pause exactly 900ms splits captions and measured silence excludes words")
    func pausesAndSilence() throws {
        let words = [speechWord(0, "before", start: 0, end: 400), speechWord(1, "after", start: 1300, end: 1500), speechWord(2, "noise", start: 3000, end: 3300)]
        let cues = try CaptionBuilder.build(words: words, silence: [.init(startMs: 2500, endMs: 3500)])
        #expect(cues.count == 2); #expect(!cues.contains { $0.wordIds.contains("w2") })
    }
    @Test("Malformed timing and duplicate IDs are rejected")
    func invalidTimes() throws {
        #expect(throws: ControlFailure.self) { try CaptionBuilder.build(words: [speechWord(0, start: .nan, end: 1)]) }
        #expect(throws: ControlFailure.self) { try CaptionBuilder.build(words: [speechWord(0, start: 9, end: 8)]) }
        #expect(throws: ControlFailure.self) {
            try TranscriptDocument(locale: "en", inputFile: "mic.mov", durationMs: 1000,
                words: [speechWord(0, start: 0, end: 500), speechWord(0, start: 500, end: 900)])
        }
    }
    @Test("Subtitle formats are valid and saved atomically without altering masters")
    func subtitleFormats() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: folder) }
        let master = Data("master-media".utf8); try master.write(to: folder.appendingPathComponent("mic.mov"))
        let doc = try TranscriptDocument(locale: "en", inputFile: "mic.mov", durationMs: 2000,
            words: [speechWord(0, "Hello <world>", start: 0, end: 1200)])
        try TranscriptFiles.write(doc, to: folder)
        #expect(try TranscriptFiles.read(from: folder) == doc)
        let vtt = try String(contentsOf: folder.appendingPathComponent("captions.vtt"), encoding: .utf8)
        let srt = try String(contentsOf: folder.appendingPathComponent("captions.srt"), encoding: .utf8)
        #expect(vtt.hasPrefix("WEBVTT\n\n00:00:00.000 --> 00:00:01.200"))
        #expect(vtt.contains("&lt;world&gt;")); #expect(srt.contains("00:00:00,000 --> 00:00:01,200"))
        #expect(try Data(contentsOf: folder.appendingPathComponent("mic.mov")) == master)
    }
    @Test("Every kept word has 70ms breathing protection across selected/filler/silence matrices")
    func editMatrix() throws {
        let words = [speechWord(0, "keep", start: 100, end: 500), speechWord(1, "um", start: 510, end: 740),
                     speechWord(2, "delete", start: 850, end: 1100), speechWord(3, "keep", start: 1140, end: 1600),
                     speechWord(4, "keep", start: 4000, end: 4500)]
        for fillers in [false, true] {
            for silence in [false, true] {
                let cuts = try TranscriptEditPlanner.suggestions(words: words, durationMs: 5000, selectedWordIds: ["w2"],
                    removeFillers: fillers, removeSilence: silence, measuredSilence: [.init(startMs: 1000, endMs: 4400)])
                let kept = words.filter { $0.id != "w2" && (!fillers || $0.id != "w1") }
                for cut in cuts {
                    for word in kept {
                        #expect(cut.sourceEndMs <= word.startMs - 70 || cut.sourceStartMs >= word.endMs + 70)
                    }
                }
            }
        }
    }
    @Test("Silence removes only middle after preserving 350ms on both sides")
    func silenceBoundaries() throws {
        let words = [speechWord(0, start: 0, end: 1000), speechWord(1, start: 3000, end: 4000)]
        let cuts = try TranscriptEditPlanner.suggestions(words: words, durationMs: 4000, removeSilence: true)
        #expect(cuts == [.init(sourceStartMs: 1350, sourceEndMs: 2650, reason: "silence")])
        #expect(throws: ControlFailure.self) { try TranscriptEditPlanner.suggestions(words: words, durationMs: 4000, selectedWordIds: ["missing"]) }
    }
    @Test("Teleprompter never moves backward or looks beyond eight words")
    func teleprompter() {
        var matcher = TeleprompterMatcher(script: "one two three four five six seven eight nine ten")
        #expect(matcher.consume("nine") == 0); #expect(matcher.consume("three") == 3)
        #expect(matcher.consume("one two") == 3); #expect(matcher.consume("eight nine ten") == 10)
        #expect(matcher.consume("ten") == 10)
    }
    @Test("No audio is a structured actionable failure")
    func noAudio() async throws {
        do { _ = try await TranscriptService.transcribe(packageURL: URL(fileURLWithPath: "/tmp/no-rushes-package-\(UUID().uuidString)")); Issue.record("Expected missing audio failure") }
        catch let error as ControlFailure { #expect(error.payload.code == "no-audio") }
    }
}

@Suite("Real on-device transcription", .enabled(if: ProcessInfo.processInfo.environment["RUSHES_SPEECH_FIXTURE"] != nil))
struct LiveTranscriptionTests {
    @Test("Recognizes actual audio bytes with Apple model and real timed words")
    func recognizesSpeechFixture() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["RUSHES_SPEECH_FIXTURE"])
        let doc = try await TranscriptService.transcribe(audioURL: URL(fileURLWithPath: path), allowAssetDownload: ProcessInfo.processInfo.environment["RUSHES_SPEECH_DOWNLOAD"] == "1")
        print("LIVE_TRANSCRIPTION engine=\(doc.engine) locale=\(doc.locale) words=\(doc.words.count) text=\(doc.text)")
        #expect(doc.engine == "Apple SpeechAnalyzer")
        #expect(doc.words.count >= 10)
        #expect(doc.text.localizedCaseInsensitiveContains("recording"))
        #expect(doc.text.localizedCaseInsensitiveContains("video"))
        #expect(doc.words.allSatisfy { $0.endMs > $0.startMs && $0.startMs >= 0 })
        try doc.validate()
    }
}
