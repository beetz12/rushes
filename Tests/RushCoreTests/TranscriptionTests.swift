import Foundation
import AVFoundation
import Speech
import FoundationModels
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
    @Test("PCM level detector measures a known two-second silent gap")
    func levelSilence() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("silence-\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 64000))
        buffer.frameLength = 64000
        let samples = try #require(buffer.floatChannelData)[0]
        for index in 0..<64000 {
            samples[index] = (index < 16000 || index >= 48000) ? Float(sin(Double(index) * 0.4) * 0.5) : 0
        }
        let writer = try AVAudioFile(forWriting: url, settings: format.settings)
        try writer.write(from: buffer)
        let input = try AVAudioFile(forReading: url)
        let silence = try AudioSilenceDetector.detect(file: input)
        #expect(silence == [.init(startMs: 1000, endMs: 3000)])
        #expect(input.framePosition == 0)
    }
    @Test("Package reads reject source and transcript symlinks outside package")
    func sourceContainment() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let external = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        try Data("external audio".utf8).write(to: external)
        defer { try? FileManager.default.removeItem(at: folder); try? FileManager.default.removeItem(at: external) }
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("mic.mov"), withDestinationURL: external)
        do { _ = try await TranscriptService.transcribe(packageURL: folder); Issue.record("Source escape accepted") }
        catch let failure as ControlFailure { #expect(failure.payload.code == "unsafe-package-path") }
        try FileManager.default.createSymbolicLink(at: folder.appendingPathComponent("transcript.json"), withDestinationURL: external)
        #expect(throws: ControlFailure.self) { try TranscriptFiles.read(from: folder) }
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
        let module = SpeechTranscriber(locale: Locale(identifier: "en-US"), preset: .transcription)
        let before = await AssetInventory.status(forModules: [module])
        let started = Date()
        let doc = try await TranscriptService.transcribe(audioURL: URL(fileURLWithPath: path), allowAssetDownload: ProcessInfo.processInfo.environment["RUSHES_SPEECH_DOWNLOAD"] == "1")
        let after = await AssetInventory.status(forModules: [module])
        print("LIVE_ASSETS before=\(before) after=\(after) setupAndRecognitionSeconds=\(Date().timeIntervalSince(started)) downloadBytes=unavailable")
        print("LIVE_TRANSCRIPTION engine=\(doc.engine) locale=\(doc.locale) words=\(doc.words.count) text=\(doc.text)")
        #expect(doc.engine == "Apple SpeechAnalyzer")
        #expect(doc.words.count >= 10)
        #expect(doc.text.localizedCaseInsensitiveContains("recording"))
        #expect(doc.text.localizedCaseInsensitiveContains("video"))
        let normalized = doc.text.lowercased().split { !$0.isLetter && !$0.isNumber }.joined(separator: " ")
        #expect(normalized.contains("this is a recording test for our new video application"))
        #expect(normalized.contains("this recording stays on this computer"))
        #expect(doc.words.allSatisfy { $0.endMs > $0.startMs && $0.startMs >= 0 })
        try doc.validate()
    }
    @Test("Recognizes a real MOV microphone track through package facade")
    func recognizesMOVPackage() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["RUSHES_SPEECH_FIXTURE"])
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("asr-mov-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: folder) }
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let export = try #require(AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetPassthrough))
        try await export.export(to: folder.appendingPathComponent("mic.mov"), as: .mov)
        let doc = try await TranscriptService.transcribe(packageURL: folder)
        #expect(doc.inputFile == "mic.mov")
        #expect(doc.words.count >= 10)
        #expect(doc.text.localizedCaseInsensitiveContains("recording"))
        #expect(try TranscriptFiles.read(from: folder) == doc)
        #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("captions.vtt").path))
        let word = try #require(doc.words.first(where: { $0.text.lowercased() == "microphone" }))
        _ = try await TranscriptCommands.handle(request: ControlRequest(id: "correction", cmd: "transcript.correct", args: .object(["wordId": .string(word.id), "text": .string("speaker")])), packageURL: folder)
        let rerun = try await TranscriptService.transcribe(packageURL: folder)
        #expect(rerun.words.contains { $0.id == word.id && $0.text == "speaker" && $0.source == "user" && $0.originalText.lowercased() == "microphone" })
        #expect(try TranscriptFiles.read(from: folder) == rerun)
    }
}

@Suite("Ten minute Apple speech benchmark", .enabled(if: ProcessInfo.processInfo.environment["RUSHES_LONG_SPEECH_FIXTURE"] == "1"))
struct LongTranscriptionTests {
    @Test("Recognizes ten minutes of synthesized speech audio within three minutes", .timeLimit(.minutes(3)))
    func tenMinuteRecognition() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["RUSHES_SPEECH_FIXTURE"])
        let source = AVURLAsset(url: URL(fileURLWithPath: path))
        let sourceDuration = try await source.load(.duration)
        let sourceTrack = try #require(try await source.loadTracks(withMediaType: .audio).first)
        let composition = AVMutableComposition()
        let track = try #require(composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid))
        let total = CMTime(seconds: 600, preferredTimescale: 48_000)
        var position = CMTime.zero
        while position < total {
            let duration = CMTimeMinimum(sourceDuration, CMTimeSubtract(total, position))
            try track.insertTimeRange(CMTimeRange(start: .zero, duration: duration), of: sourceTrack, at: position)
            position = CMTimeAdd(position, duration)
        }
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-long-speech-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: output) }
        let export = try #require(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetAppleM4A))
        try await export.export(to: output, as: .m4a)
        let started = Date()
        let document = try await TranscriptService.transcribe(audioURL: output)
        let elapsed = Date().timeIntervalSince(started)
        print("LONG_ASR durationMs=\(document.durationMs) words=\(document.words.count) elapsedSeconds=\(elapsed) source=synthesized-spoken-audio")
        #expect(abs(document.durationMs - 600_000) < 100)
        #expect(document.words.count > 500)
        #expect(elapsed < 180)
        #expect(document.words.last?.startMs ?? 0 > 570_000)
        try document.validate()
        let metadata = await MetadataService.generate(transcript: document)
        print("LONG_METADATA engine=\(metadata.engine) chapters=\(metadata.chapters.count) lastStartMs=\(metadata.chapters.last?.startMs ?? -1)")
        #expect(metadata.chapters.first?.startMs == 0)
        #expect(metadata.chapters.last?.startMs ?? 0 > 420_000)
        if SystemLanguageModel.default.availability == .available { #expect(metadata.engine == "Apple FoundationModels (on-device)") }
        try metadata.validate(durationMs: document.durationMs)
    }
}
