@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import RushCore

/// Noise suppression uses a spoken fixture generated on this Mac by `say`,
/// mixed with deterministic white noise. No personal audio is involved.
@Suite("Voice isolation export", .serialized)
struct VoiceIsolationTests {
    static let rate = 48_000.0
    static let pad = 48_000

    private func speech(in directory: URL) throws -> [Float] {
        let aiff = directory.appendingPathComponent("speech.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-o", aiff.path, "This is a generated test voice. The steady hiss behind it should be removed while every word stays."]
        try say.run(); say.waitUntilExit()
        #expect(say.terminationStatus == 0)
        let file = try AVAudioFile(forReading: aiff)
        let input = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: input)
        let mono = try #require(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Self.rate, channels: 1, interleaved: false))
        let converter = try #require(AVAudioConverter(from: file.processingFormat, to: mono))
        let output = try #require(AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(Double(file.length) * Self.rate / file.processingFormat.sampleRate) + 4_800))
        nonisolated(unsafe) var given = false
        var error: NSError?
        _ = converter.convert(to: output, error: &error) { _, status in
            if given { status.pointee = .endOfStream; return nil }
            given = true; status.pointee = .haveData; return input
        }
        if let error { throw error }
        return Array(UnsafeBufferPointer(start: try #require(output.floatChannelData)[0], count: Int(output.frameLength)))
    }

    private func write(_ samples: [Float], to url: URL) throws {
        let format = try PCMEditingAudioRenderer.format()
        var settings = format.settings; settings[AVLinearPCMIsNonInterleaved] = false
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096))
        let channels = try #require(buffer.floatChannelData)
        var position = 0
        while position < samples.count {
            let count = min(4096, samples.count - position)
            buffer.frameLength = AVAudioFrameCount(count)
            for channel in 0..<2 { for i in 0..<count { channels[channel][i] = samples[position + i] } }
            try file.write(from: buffer); position += count
        }
    }

    private func read(_ url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        return Array(UnsafeBufferPointer(start: try #require(buffer.floatChannelData)[0], count: Int(buffer.frameLength)))
    }

    private func rms(_ values: ArraySlice<Float>) -> Double {
        sqrt(values.reduce(0) { $0 + Double($1 * $1) } / Double(max(1, values.count)))
    }

    private func correlation(_ a: [Float], _ b: [Float], range: Range<Int>, lag: Int) -> Double {
        var dot = 0.0, x2 = 0.0, y2 = 0.0
        for i in stride(from: range.lowerBound, to: range.upperBound, by: 2) {
            let x = Double(a[i]), y = Double(b[i + lag]); dot += x * y; x2 += x * x; y2 += y * y
        }
        return dot / (sqrt(x2 * y2) + 1e-12)
    }

    @Test func removesSteadyNoiseKeepsTheVoiceAlignedAndKeepsTheLength() async throws {
        guard VoiceIsolation.isAvailable else {
            Issue.record("Sound Isolation audio unit is missing on this Mac"); return
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-voice-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let voice = try speech(in: directory)
        #expect(voice.count > 48_000)
        let total = voice.count + 2 * Self.pad
        var clean = [Float](repeating: 0, count: total)
        var noisy = clean
        var seed: UInt64 = 0x5eed
        for i in 0..<total {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            let noise = Float(Int64(bitPattern: seed >> 11) % 2000 - 1000) / 1000 * 0.05
            if i >= Self.pad && i < Self.pad + voice.count { clean[i] = voice[i - Self.pad] }
            noisy[i] = clean[i] + noise
        }
        let input = directory.appendingPathComponent("mic.caf"), output = directory.appendingPathComponent("clean.caf")
        try write(noisy, to: input)

        let frames = try VoiceIsolation.process(input: input, output: output)
        let result = try read(output)
        #expect(frames == Int64(total))
        #expect(result.count == total)

        // Noise-only lead-in drops by at least 30 dB.
        let before = rms(noisy[4_800..<43_200]), after = rms(result[4_800..<43_200])
        #expect(20 * log10(after / before) < -30)

        // The voice survives and is aligned with the source: the best
        // correlation is within 2 ms of zero lag, not at the unit's 76 ms latency.
        let speech = Self.pad..<(Self.pad + voice.count)
        let atZero = correlation(clean, result, range: speech, lag: 0)
        #expect(atZero > 0.9)
        let late = correlation(clean, result, range: speech.lowerBound..<(speech.upperBound - 4_000), lag: 3_664)
        #expect(late < atZero)
        #expect(rms(result[speech]) > 0.5 * rms(clean[speech]))
    }

    @Test func editDocumentsOmitTheFlagWhileOffAndDecodeOlderDrafts() throws {
        var audio = EditAudio()
        let off = String(decoding: try JSONEncoder().encode(audio), as: UTF8.self)
        #expect(!off.contains("noiseSuppression"))
        audio.noiseSuppression = true
        let on = try JSONEncoder().encode(audio)
        #expect(try JSONDecoder().decode(EditAudio.self, from: on).noiseSuppression)
        let legacy = Data(#"{"micGain":1,"systemGain":0.5,"micMuted":false}"#.utf8)
        #expect(try JSONDecoder().decode(EditAudio.self, from: legacy).noiseSuppression == false)
    }

    @Test func exportUsesTheCleanedMicAndLeavesTheMasterUntouched() async throws {
        guard VoiceIsolation.isAvailable else {
            Issue.record("Sound Isolation audio unit is missing on this Mac"); return
        }
        let fixture = try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let hashes = try fixture.hashes(), service = PostproductionService(root: fixture.root)
        var edit = try await service.getEdit(id: fixture.package.id); edit.audio.systemGain = 0
        _ = try await service.setEdit(id: fixture.package.id, edit: edit)
        let plain = fixture.root.appendingPathComponent("plain.wav")
        _ = try await service.export(id: fixture.package.id, options: ExportOptions(preset: .audio, container: "wav"), to: plain)
        edit = try await service.getEdit(id: fixture.package.id); edit.audio.noiseSuppression = true
        _ = try await service.setEdit(id: fixture.package.id, edit: edit)
        let cleaned = fixture.root.appendingPathComponent("cleaned.wav")
        let result = try await service.export(id: fixture.package.id, options: ExportOptions(preset: .audio, container: "wav"), to: cleaned)
        // The fixture mic is a steady 440 Hz tone, which is not a voice, so
        // Sound Isolation removes it. A cached plain render would keep it.
        #expect(result.cached != true)
        let before = try await SyntheticExportFixture.audioRMS(plain)
        let after = try await SyntheticExportFixture.audioRMS(cleaned)
        #expect(before > 0.05)
        #expect(after < before * 0.1)
        #expect(try fixture.hashes() == hashes)
    }
}
