import CoreMedia
import Foundation

/// A silence warning requires measured PCM, never absent/unsupported samples.
internal enum AudioLevel {
    static func rms(_ sample: CMSampleBuffer) -> Double? {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format),
              let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
        let pcm = description.pointee
        guard pcm.mFormatID == kAudioFormatLinearPCM,
              pcm.mFormatFlags & kAudioFormatFlagIsFloat != 0, pcm.mBitsPerChannel == 32 else { return nil }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length % 4 == 0 else { return nil }
        var values = [Float](repeating: 0, count: length / 4)
        let result = values.withUnsafeMutableBytes { CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!) }
        guard result == noErr else { return nil }
        var energy: Double = 0
        for value in values { energy += Double(value) * Double(value) }
        let rms = sqrt(energy / Double(values.count))
        return rms.isFinite ? rms : nil
    }
}

internal struct SilenceWatch {
    private var startedNs: Int64?
    mutating func receive(rms: Double?, mediaNs: Int64, muted: Bool) -> Bool {
        guard !muted, let rms, rms.isFinite, rms >= 0, rms < 1e-5 else { startedNs = nil; return false }
        if startedNs == nil { startedNs = mediaNs }
        return mediaNs - (startedNs ?? mediaNs) >= 3_000_000_000
    }
}
