import AVFoundation
import Foundation

public enum AudioSilenceDetector {
    public static func detect(audioURL: URL) async throws -> [TranscriptInterval] {
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-levels-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: temporary) }
        let audio: AVAudioFile
        do { audio = try AVAudioFile(forReading: audioURL) }
        catch {
            let asset = AVURLAsset(url: audioURL)
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
                throw ControlFailure(code: "audio-unreadable")
            }
            try await export.export(to: temporary, as: .m4a)
            audio = try AVAudioFile(forReading: temporary)
        }
        return try detect(file: audio)
    }

    /// Original 50ms PCM RMS scan. The decoded input position is restored for subsequent ASR.
    public static func detect(file: AVAudioFile) throws -> [TranscriptInterval] {
        let initialPosition = file.framePosition
        file.framePosition = 0
        defer { file.framePosition = initialPosition }
        let format = file.processingFormat
        guard !format.isInterleaved, format.commonFormat == .pcmFormatFloat32, format.sampleRate.isFinite, format.sampleRate > 0,
              format.channelCount > 0 else {
            throw ControlFailure(code: "audio-level-format", message: "Silence analysis requires decoded 32-bit PCM audio.")
        }
        let count = AVAudioFrameCount(max(1, Int(format.sampleRate * 0.05)))
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { throw ControlFailure(code: "audio-level-buffer") }
        var windows: [(start: Double, end: Double, level: Double)] = []
        while file.framePosition < file.length {
            let start = Double(file.framePosition) / format.sampleRate * 1000
            try file.read(into: buffer, frameCount: count)
            guard buffer.frameLength > 0, let channels = buffer.floatChannelData else { break }
            var squares = 0.0
            for channel in 0..<Int(format.channelCount) {
                for frame in 0..<Int(buffer.frameLength) {
                    let sample = Double(channels[channel][frame])
                    guard sample.isFinite else { throw ControlFailure(code: "invalid-audio-sample") }
                    squares += sample * sample
                }
            }
            let rms = sqrt(squares / Double(buffer.frameLength * format.channelCount))
            let end = Double(file.framePosition) / format.sampleRate * 1000
            windows.append((start, end, 20 * log10(max(0.000_001, rms))))
        }
        guard !windows.isEmpty else { return [] }
        let levels = windows.map(\.level).sorted()
        let speechLevel = levels[min(levels.count - 1, Int(Double(levels.count - 1) * 0.95))]
        let threshold = speechLevel < -70 ? -70 : speechLevel - 25
        var intervals: [TranscriptInterval] = []
        for window in windows where window.level < threshold {
            if var last = intervals.last, abs(last.endMs - window.start) < 0.1 {
                last.endMs = window.end; intervals[intervals.count - 1] = last
            } else { intervals.append(.init(startMs: window.start, endMs: window.end)) }
        }
        return intervals
    }
}
