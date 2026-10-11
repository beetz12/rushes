import CoreMedia
import Foundation

/// Synthesizes silent PCM sample buffers in the exact sample layout of a
/// donor buffer.
///
/// The first real audio sample a `TrackWriter` accepts fixes the input format
/// of its `AVAssetWriterInput`, so every synthesized buffer (leading silence,
/// gap fill, mute, tail padding) must byte-match that layout. This type reads
/// the layout from a donor buffer the writer retained for exactly that
/// purpose, which keeps it correct for interleaved and deinterleaved PCM
/// alike.
internal enum AudioSilence {

    /// A silent buffer with `frameCount` frames in the donor's format,
    /// starting at `mediaStartNs` on the media clock.
    ///
    /// The timing entry follows CoreMedia's rule that a single entry
    /// describes one sample applied to all: its duration is one sample, its
    /// presentation time the buffer's start.
    static func makeSilence(
        mediaStartNs: Int64,
        frameCount: Int,
        donor: CMSampleBuffer
    ) -> CMSampleBuffer? {
        guard frameCount > 0,
              let format = CMSampleBufferGetFormatDescription(donor) else { return nil }
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return nil }
        let rate = asbd.pointee.mSampleRate
        guard rate > 0 else { return nil }

        let donorFrames = CMSampleBufferGetNumSamples(donor)
        // The block buffer's data length is the reliable byte count:
        // CMSampleBufferGetTotalSampleSize reads the sample-size array, which
        // PCM buffers created without one do not carry.
        let donorBytes = CMSampleBufferGetDataBuffer(donor).map { CMBlockBufferGetDataLength($0) } ?? 0
        guard donorFrames > 0, donorBytes > 0 else { return nil }
        let bytesPerFrame = donorBytes / donorFrames
        let totalBytes = frameCount * bytesPerFrame
        guard totalBytes > 0 else { return nil }

        let memory = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
        memset(memory, 0, totalBytes)
        var block: CMBlockBuffer?
        let status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: memory,
            blockLength: totalBytes,
            blockAllocator: kCFAllocatorMalloc,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: totalBytes,
            flags: 0,
            blockBufferOut: &block)
        guard status == noErr, block != nil else {
            memory.deallocate()
            return nil
        }

        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
            presentationTimeStamp: CMTime(exactNanoseconds: mediaStartNs),
            decodeTimeStamp: .invalid)
        var silence: CMSampleBuffer?
        let createStatus = CMSampleBufferCreate(
            allocator: kCFAllocatorDefault,
            dataBuffer: block,
            dataReady: true,
            makeDataReadyCallback: nil,
            refcon: nil,
            formatDescription: format,
            sampleCount: frameCount,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 0,
            sampleSizeArray: nil,
            sampleBufferOut: &silence)
        guard createStatus == noErr, silence != nil else { return nil }
        return silence
    }

    /// Whole audio frames spanning the media-time range, at the donor's
    /// sample rate.
    static func frameCount(
        fromMediaNs startNs: Int64,
        toMediaNs endNs: Int64,
        donor: CMSampleBuffer
    ) -> Int {
        guard endNs > startNs,
              let format = CMSampleBufferGetFormatDescription(donor),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format) else { return 0 }
        let rate = Double(asbd.pointee.mSampleRate)
        guard rate > 0 else { return 0 }
        return max(0, Int((Double(endNs - startNs) * rate / 1e9).rounded()))
    }
}
