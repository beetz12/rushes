@preconcurrency import AVFoundation
import Foundation

/// Non-destructive microphone noise suppression for exports.
///
/// The decoded microphone PCM runs offline through Apple's Sound Isolation
/// audio unit. The raw `mic` master is never touched. The unit's processing
/// latency is removed so the cleaned voice stays aligned with the video, and
/// the output has exactly as many frames as the input.
enum VoiceIsolation {
    static let description = AudioComponentDescription(
        componentType: kAudioUnitType_Effect,
        componentSubType: kAudioUnitSubType_AUSoundIsolation,
        componentManufacturer: kAudioUnitManufacturer_Apple,
        componentFlags: 0, componentFlagsMask: 0)
    static let block: AVAudioFrameCount = 4096

    static var isAvailable: Bool { AudioComponentFindNext(nil, [description]) != nil }

    /// Cleaned copy of `source`, cached next to it and keyed by its checksum.
    static func prepare(_ source: PCMAudioSource) async throws -> PCMAudioSource {
        let directory = source.url.deletingLastPathComponent()
        let target = try PostproductionPaths.managedFile("\(source.outputSHA256).voice-isolated.caf", in: directory)
        if let file = try? AVAudioFile(forReading: target, commonFormat: .pcmFormatFloat32, interleaved: false),
           file.length == source.frameCount {
            return PCMAudioSource(url: target, frameCount: source.frameCount,
                sourceSHA256: source.sourceSHA256, outputSHA256: source.outputSHA256 + ".voice-isolated")
        }
        let staging = try PostproductionPaths.managedFile(".voice-\(UUID().uuidString).caf", in: directory)
        defer { try? FileManager.default.removeItem(at: staging) }
        let frames = try await Task.detached(priority: .utility) {
            try process(input: source.url, output: staging)
        }.value
        guard frames == source.frameCount else {
            throw renderFailure("Voice isolation changed the microphone length")
        }
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        try FileManager.default.moveItem(at: staging, to: target)
        return PCMAudioSource(url: target, frameCount: frames,
            sourceSHA256: source.sourceSHA256, outputSHA256: source.outputSHA256 + ".voice-isolated")
    }

    /// Renders `input` through Sound Isolation into `output`. Returns frames written.
    static func process(input: URL, output: URL) throws -> Int64 {
        guard isAvailable else {
            throw ControlFailure(code: "voice-isolation-unavailable",
                message: "Noise suppression needs macOS Sound Isolation, which this Mac does not provide")
        }
        let source = try AVAudioFile(forReading: input, commonFormat: .pcmFormatFloat32, interleaved: false)
        let format = source.processingFormat
        let total = source.length
        var settings = format.settings; settings[AVLinearPCMIsNonInterleaved] = false
        let writer = try AVAudioFile(forWriting: output, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        guard total > 0 else { return 0 }

        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        let effect = AVAudioUnitEffect(audioComponentDescription: description)
        engine.attach(player); engine.attach(effect)
        engine.connect(player, to: effect, format: format)
        engine.connect(effect, to: engine.mainMixerNode, format: format)
        try engine.enableManualRenderingMode(.offline, format: format, maximumFrameCount: block)
        try engine.start()
        defer { player.stop(); engine.stop() }
        player.scheduleFile(source, at: nil)
        player.play()

        // The unit delays its output; drop that many leading frames, then
        // keep rendering (feeding silence) until the input length is written.
        let latency = Int64((effect.auAudioUnit.latency * format.sampleRate).rounded())
        guard let buffer = AVAudioPCMBuffer(pcmFormat: engine.manualRenderingFormat, frameCapacity: block),
              let trimmed = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: block) else {
            throw renderFailure("Voice isolation buffer allocation failed")
        }
        var skipped: Int64 = 0, written: Int64 = 0
        while written < total {
            try Task.checkCancellation()
            let want = AVAudioFrameCount(min(Int64(block), total - written + max(0, latency - skipped)))
            let status = try engine.renderOffline(want, to: buffer)
            guard status == .success else { throw renderFailure("Voice isolation render stopped (\(status.rawValue))") }
            var start = Int64(0)
            if skipped < latency {
                let drop = min(latency - skipped, Int64(buffer.frameLength))
                skipped += drop; start = drop
            }
            let keep = min(Int64(buffer.frameLength) - start, total - written)
            guard keep > 0 else { continue }
            guard let from = buffer.floatChannelData, let to = trimmed.floatChannelData else {
                throw renderFailure("Voice isolation format is unavailable")
            }
            for channel in 0..<Int(format.channelCount) {
                to[channel].update(from: from[channel].advanced(by: Int(start)), count: Int(keep))
            }
            trimmed.frameLength = AVAudioFrameCount(keep)
            try writer.write(from: trimmed)
            written += keep
        }
        return written
    }
}
