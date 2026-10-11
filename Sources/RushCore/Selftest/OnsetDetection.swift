import AVFoundation
import CoreMedia
import Foundation

/// Onset-detection primitives for `selftest sync` and `analyze clap`
/// (docs/PLAN.md, Roadmap Phase 1 item 9).
///
/// Everything here is a read-only measurement over a finished media file:
/// an audio energy envelope over `AVAssetReader` PCM samples, and a video
/// frame series (mean luma plus frame-to-frame change) over decoded frames.
/// The finders are pure functions over those series, so they are unit tested
/// on synthetic files with known ground truth (Tests/RushCoreTests/
/// SelftestTests.swift) and then applied unchanged to real captures.

// MARK: - Audio envelope

/// One fixed-size RMS block of the decoded audio: milliseconds from the
/// file's media time zero, and the block's root-mean-square level in linear
/// full scale (1.0 == 0 dBFS).
public struct AudioEnvelopeBlock: Equatable, Sendable {
    public let timeMs: Double
    public let rms: Double

    public init(timeMs: Double, rms: Double) {
        self.timeMs = timeMs
        self.rms = rms
    }
}

/// Errors the readers can report. A file that cannot be read is a finding,
/// never a guess.
public enum OnsetDetectionError: Error, Equatable, Sendable, CustomStringConvertible {
    case unreadableAudio(String)
    case unreadableVideo(String)
    case noAudioTrack
    case noVideoTrack

    public var description: String {
        switch self {
        case .unreadableAudio(let detail):
            return "audio could not be decoded: \(detail)"
        case .unreadableVideo(let detail):
            return "video could not be decoded: \(detail)"
        case .noAudioTrack:
            return "the file has no audio track"
        case .noVideoTrack:
            return "the file has no video track"
        }
    }
}

/// Decodes an audio track and reduces it to fixed-size RMS blocks.
public enum AudioEnvelope {

    /// Blocks of `blockMs` milliseconds over the first audio track.
    /// `blockMs` of 1 gives millisecond onset resolution, which is what the
    /// 17 ms and 40 ms targets need.
    public static func blocks(url: URL, blockMs: Double = 1) async throws -> [AudioEnvelopeBlock] {
        let asset = AVURLAsset(url: url)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard let track = audioTracks.first else { throw OnsetDetectionError.noAudioTrack }

        guard let reader = try? AVAssetReader(asset: asset) else {
            throw OnsetDetectionError.unreadableAudio(url.lastPathComponent)
        }
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVLinearPCMBitDepthKey: 32,
                AVLinearPCMIsFloatKey: true,
                AVLinearPCMIsBigEndianKey: false,
            ])
        reader.add(output)
        guard reader.startReading() else {
            throw OnsetDetectionError.unreadableAudio(
                reader.error.map(String.init(describing:)) ?? url.lastPathComponent)
        }
        defer { reader.cancelReading() }

        var blocks: [AudioEnvelopeBlock] = []
        var rate: Double = 48_000
        var blockFrames = Int((rate * blockMs / 1_000).rounded())

        // Streaming accumulator: blocks may straddle CMSampleBuffers, and the
        // whole file is never materialized (a long take must not become a
        // gigabyte array).
        var sumSquares: Double = 0
        var count: Int = 0
        var blockStartSeconds: Double = 0
        var blockStartFixed = false

        func flush() {
            guard count > 0 else { return }
            let rms = sqrt(sumSquares / Double(count))
            blocks.append(
                AudioEnvelopeBlock(timeMs: blockStartSeconds * 1_000, rms: rms))
            sumSquares = 0
            count = 0
        }

        while let sampleBuffer = output.copyNextSampleBuffer() {
            let ptsSeconds = CMTimeGetSeconds(
                CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
            let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
            guard frameCount > 0, ptsSeconds.isFinite else { continue }
            if let description = CMSampleBufferGetFormatDescription(sampleBuffer),
               let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
               asbd.pointee.mSampleRate > 0 {
                let newRate = Double(asbd.pointee.mSampleRate)
                if newRate != rate {
                    rate = newRate
                    blockFrames = Int((rate * blockMs / 1_000).rounded())
                }
            }
            if !blockStartFixed {
                blockStartSeconds = max(ptsSeconds, 0)
                blockStartFixed = true
            }
            guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { continue }
            var lengthAtOffset = 0
            var totalLength = 0
            var dataPointer: UnsafeMutablePointer<Int8>?
            guard CMBlockBufferGetDataPointer(
                blockBuffer, atOffset: 0,
                lengthAtOffsetOut: &lengthAtOffset,
                totalLengthOut: &totalLength,
                dataPointerOut: &dataPointer) == noErr,
                let pointer = dataPointer else { continue }
            let floats = UnsafeRawPointer(pointer).assumingMemoryBound(to: Float.self)
            let sampleCount = lengthAtOffset / MemoryLayout<Float>.size
            for index in 0..<sampleCount {
                let square = Double(floats[index]) * Double(floats[index])
                sumSquares += square
                count += 1
                if count >= blockFrames {
                    flush()
                    blockStartSeconds += Double(blockFrames) / rate
                }
            }
        }
        flush()
        if reader.status == .failed {
            throw OnsetDetectionError.unreadableAudio(String(describing: reader.error))
        }
        return blocks
    }
}

// MARK: - Audio onset finders (pure)

/// Finders over an audio envelope.
public enum AudioOnset {

    /// The first sustained energy rise inside `windowMs`: the earliest block
    /// whose level stays above a threshold derived from the window's own
    /// peak. Used for the selftest tone (silence, then a tone).
    ///
    /// The threshold is `peak / factor`, floored at `minRms`: the tone onset
    /// must clear 24 dB below its peak and an absolute -46 dBFS. `hold`
    /// consecutive blocks (minus one) must clear half the threshold so a
    /// single noisy block never counts as an onset.
    public static func firstSustainedRise(
        blocks: [AudioEnvelopeBlock],
        windowMs: ClosedRange<Double>,
        factor: Double = 16,
        minRms: Double = 0.005,
        hold: Int = 5
    ) -> Double? {
        let window = blocks.filter { windowMs.contains($0.timeMs) }
        guard !window.isEmpty else { return nil }
        let peak = window.map(\.rms).max() ?? 0
        guard peak > minRms else { return nil }
        let threshold = max(peak / factor, minRms)
        for (index, block) in window.enumerated() where block.rms > threshold {
            let tail = window[index..<min(index + hold, window.count)]
            if tail.allSatisfy({ $0.rms > threshold / 2 }) {
                return block.timeMs
            }
        }
        return nil
    }

    /// Sharp energy attacks (claps) over the whole envelope: local peaks of
    /// level-relative-to-preceding-floor, newest-first quality ordered, kept
    /// apart by at least `minSeparationMs`.
    ///
    /// A clap is a fast rise from the local floor, so the detector scores
    /// every block by `rms / (median of the preceding floor window)` and
    /// keeps local maxima whose score clears `scoreFloor`, whose level clears
    /// an absolute floor, and which are the strongest within
    /// `minSeparationMs`. The onset time is then walked back to the first
    /// block below half the peak (the attack start, not the peak).
    public static func sharpAttacks(
        blocks: [AudioEnvelopeBlock],
        limit: Int = 8,
        floorWindowMs: Double = 120,
        minSeparationMs: Double = 300,
        scoreFloor: Double = 6,
        minRms: Double = 0.004
    ) -> [Double] {
        guard !blocks.isEmpty else { return [] }
        let times = blocks.map(\.timeMs)
        let levels = blocks.map(\.rms)
        let blockSpanMs = times.count > 1 ? times[1] - times[0] : 1
        let floorBlocks = max(Int(floorWindowMs / max(blockSpanMs, 0.1)), 8)

        struct Candidate {
            let timeMs: Double
            let score: Double
            let level: Double
        }
        var candidates: [Candidate] = []
        for index in blocks.indices {
            let windowStart = max(0, index - floorBlocks)
            let preceding = levels[windowStart..<index]
            guard !preceding.isEmpty else { continue }
            let sorted = preceding.sorted()
            let median = sorted[sorted.count / 2]
            let floor = max(median, 1e-6)
            let score = levels[index] / floor
            if score >= scoreFloor, levels[index] >= max(minRms, floor * 3) {
                candidates.append(
                    Candidate(timeMs: times[index], score: score, level: levels[index]))
            }
        }
        // Strongest first; enforce separation.
        candidates.sort { $0.level > $1.level }
        var kept: [Candidate] = []
        for candidate in candidates {
            if kept.allSatisfy({ abs($0.timeMs - candidate.timeMs) >= minSeparationMs }) {
                kept.append(candidate)
            }
        }
        kept.sort { $0.timeMs < $1.timeMs }
        kept = Array(kept.prefix(limit))
        guard !kept.isEmpty else { return [] }

        // Walk each kept peak back to its attack start: the first block of
        // the loud region, where the level last sat below half the peak.
        // (Walking while the level is LOW would run back through the
        // preceding silence; the attack is where the level drops away.)
        return kept.map { candidate in
            let peakIndex = blocks.firstIndex {
                abs($0.timeMs - candidate.timeMs) < blockSpanMs / 2
            } ?? blocks.indices.last!
            var onsetIndex = peakIndex
            let half = candidate.level / 2
            while onsetIndex > 0,
                  levels[onsetIndex - 1] >= half,
                  times[peakIndex] - times[onsetIndex - 1] <= 150 {
                onsetIndex -= 1
            }
            return times[onsetIndex]
        }
    }
}

// MARK: - Video frame series

/// One decoded video frame: its presentation time in milliseconds from media
/// time zero, its mean luma (0 = black, 1 = white), and its mean absolute
/// luma change against the previous frame (0 = identical).
public struct VideoFrameSample: Equatable, Sendable {
    public let ptsMs: Double
    public let meanLuma: Double
    public let change: Double

    public init(ptsMs: Double, meanLuma: Double, change: Double) {
        self.ptsMs = ptsMs
        self.meanLuma = meanLuma
        self.change = change
    }
}

/// Decodes a video track and reduces every frame to the two numbers the
/// selftests need.
public enum VideoFrameSeries {

    /// Frame samples over the first video track. Luma is measured on the
    /// NV12 Y plane, subsampled by `stride` in both axes (a full-frame mean
    /// does not need every pixel, and the stride keeps a 60 fps 4K master
    /// cheap to scan).
    public static func samples(url: URL, stride: Int = 4) async throws -> [VideoFrameSample] {
        let asset = AVURLAsset(url: url)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let track = videoTracks.first else { throw OnsetDetectionError.noVideoTrack }

        guard let reader = try? AVAssetReader(asset: asset) else {
            throw OnsetDetectionError.unreadableVideo(url.lastPathComponent)
        }
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String:
                                kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
        reader.add(output)
        guard reader.startReading() else {
            throw OnsetDetectionError.unreadableVideo(
                reader.error.map(String.init(describing:)) ?? url.lastPathComponent)
        }
        defer { reader.cancelReading() }

        var samples: [VideoFrameSample] = []
        var previousLuma: [UInt8]?

        while let sampleBuffer = output.copyNextSampleBuffer() {
            guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { continue }
            let ptsMs = CMTimeGetSeconds(
                CMSampleBufferGetPresentationTimeStamp(sampleBuffer)) * 1_000
            guard ptsMs.isFinite else { continue }

            CVPixelBufferLockBaseAddress(imageBuffer, [.readOnly])
            defer { CVPixelBufferUnlockBaseAddress(imageBuffer, [.readOnly]) }
            guard CVPixelBufferGetPlaneCount(imageBuffer) >= 1,
                  let base = CVPixelBufferGetBaseAddressOfPlane(imageBuffer, 0) else { continue }
            let width = CVPixelBufferGetWidthOfPlane(imageBuffer, 0)
            let height = CVPixelBufferGetHeightOfPlane(imageBuffer, 0)
            let bytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(imageBuffer, 0)
            let lumaPointer = base.assumingMemoryBound(to: UInt8.self)

            let step = max(1, stride)
            var columnIndices: [Int] = []
            columnIndices.reserveCapacity((width + step - 1) / step)
            var column = 0
            while column < width {
                columnIndices.append(column)
                column += step
            }
            var lumaValues: [UInt8] = []
            lumaValues.reserveCapacity(columnIndices.count * ((height + step - 1) / step))
            var total: Double = 0
            var row = 0
            while row < height {
                let rowBase = lumaPointer + row * bytesPerRow
                for columnOffset in columnIndices {
                    let value = rowBase[columnOffset]
                    lumaValues.append(value)
                    total += Double(value)
                }
                row += step
            }
            let meanLuma = lumaValues.isEmpty ? 0 : total / Double(lumaValues.count) / 255

            var change: Double = 0
            if let previous = previousLuma, previous.count == lumaValues.count {
                var difference: Double = 0
                for index in lumaValues.indices {
                    difference += abs(Double(lumaValues[index]) - Double(previous[index]))
                }
                change = difference / Double(lumaValues.count) / 255
            }
            previousLuma = lumaValues
            samples.append(VideoFrameSample(ptsMs: ptsMs, meanLuma: meanLuma, change: change))
        }
        if reader.status == .failed {
            throw OnsetDetectionError.unreadableVideo(String(describing: reader.error))
        }
        return samples
    }
}

// MARK: - Video onset finders (pure)

/// Finders over a video frame series.
public enum VideoOnset {

    /// The first frame inside `windowMs` whose mean luma jumps to a bright
    /// level from a dark one: the white flash of `selftest sync`. The
    /// threshold is relative to the window's own darkest and brightest frames
    /// so a dim screen or a scaled stream still trips it.
    public static func flashOnset(
        samples: [VideoFrameSample], windowMs: ClosedRange<Double>
    ) -> Double? {
        let window = samples.filter { windowMs.contains($0.ptsMs) }
        guard window.count >= 2 else { return nil }
        let darkest = window.map(\.meanLuma).min() ?? 0
        let brightest = window.map(\.meanLuma).max() ?? 0
        guard brightest - darkest > 0.4 else {
            // No bright flash in the window; fall back to the largest step.
            return largestChange(samples: samples, windowMs: windowMs)
        }
        let threshold = darkest + (brightest - darkest) * 0.5
        for (index, frame) in window.enumerated() {
            if frame.meanLuma >= threshold,
               index == 0 || window[index - 1].meanLuma < threshold {
                return frame.ptsMs
            }
        }
        return nil
    }

    /// The frame with the largest frame-to-frame change inside `windowMs`:
    /// the visual half of a clap (hands coming together) or a synthetic
    /// flash. Returns nil when the window holds no frames.
    public static func largestChange(
        samples: [VideoFrameSample], windowMs: ClosedRange<Double>
    ) -> Double? {
        let window = samples.filter { windowMs.contains($0.ptsMs) }
        guard let strongest = window.max(by: { $0.change < $1.change }) else { return nil }
        return strongest.ptsMs
    }
}
