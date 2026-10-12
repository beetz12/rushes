@preconcurrency import AVFoundation
import CryptoKit
import Foundation

/// A decoded source timeline. Frame zero is source-file time zero; recording
/// offsets, measured latency, gains and edits belong to the renderer.
public struct PCMAudioSource: Sendable {
    public let url: URL
    public let frameCount: Int64
    public var frameCount48k: Int64 { frameCount }
    public let sourceSHA256: String
    public let outputSHA256: String
    public var durationMs: Double { Double(frameCount) / 48 }
}

/// Reusable straight-track decoding avoids constructing a compressed,
/// time-scaled multitrack AVAssetReader audio mixer for every export.
public actor PCMAudioSourceCache {
    public static let shared = PCMAudioSourceCache()
    private var preparing: Set<String> = []

    public init() {}

    public func prepare(package: RecordingPackage, track: RecordingManifest.RecordingTrack) async throws -> PCMAudioSource {
        guard track.present, track.kind == .microphone || track.kind == .systemAudio else {
            throw pcmSourceFailure("Only a present microphone or system-audio master can be decoded")
        }
        let folder = package.folderURL.standardizedFileURL
        guard folder.resolvingSymlinksInPath().standardizedFileURL == folder else {
            throw pcmSourceFailure("The recording package must not be a symbolic link")
        }
        let source = try PostproductionPaths.file(track.file, in: folder)
        let sourceSHA = try await PCMSourceWork<String>().run { work in try pcmChecksum(source, work: work) }
        let identity = pcmDigest(Data("rushes.pcm-source/1\n48000/stereo/float32\n\(sourceSHA)".utf8))
        let reservation = folder.path + "/" + identity
        // Concurrent exporters for different sources proceed independently.
        // Only publication of the same source in the same package is reserved.
        while preparing.contains(reservation) { try await Task.sleep(for: .milliseconds(10)) }
        try Task.checkCancellation()
        preparing.insert(reservation)
        defer { preparing.remove(reservation) }

        let directory = try pcmDirectory(folder, create: true)
        let cache = try PostproductionPaths.managedFile(identity + ".caf", in: directory)
        let stampURL = try PostproductionPaths.managedFile(identity + ".json", in: directory)
        if let cached = try await PCMSourceWork<PCMAudioSource?>().run({ work in
            try pcmCachedSource(cache: cache, stampURL: stampURL, sourceSHA: sourceSHA, work: work)
        }) {
            try Task.checkCancellation()
            return cached
        }

        let asset = AVURLAsset(url: source)
        guard let mediaTrack = try await asset.loadTracks(withMediaType: .audio).first else {
            throw pcmSourceFailure("The source file has no audio stream")
        }
        let duration = try await asset.load(.duration)
        let frameCount = try pcmFramePosition(duration, nonnegative: true)
        guard frameCount > 0 else { throw pcmSourceFailure("The source audio timeline is empty") }
        let decode = PCMSourceDecoder(asset: asset, track: mediaTrack, frameCount: frameCount)
        let work = PCMSourceWork<PCMAudioSource>()
        return try await work.run { state in
            let checkedDirectory = try pcmDirectory(folder, create: false)
            guard checkedDirectory == directory else { throw pcmSourceFailure("The PCM cache folder changed") }
            let temporaryName = ".pcm-\(UUID().uuidString).caf"
            let temporary = try PostproductionPaths.managedFile(temporaryName, in: directory)
            var published = false
            var valid = false
            defer {
                // Cleanup never follows a replacement cache-directory symlink.
                if (try? pcmDirectory(folder, create: false)) == directory,
                   (try? PostproductionPaths.managedFile(temporaryName, in: directory)) == temporary {
                    try? FileManager.default.removeItem(at: temporary)
                    if published && !valid {
                        // No cancelled/failed publication may leave a validity
                        // marker or an orphan canonical output behind.
                        if (try? PostproductionPaths.managedFile(cache.lastPathComponent, in: directory)) == cache {
                            try? FileManager.default.removeItem(at: cache)
                        }
                        if (try? PostproductionPaths.managedFile(stampURL.lastPathComponent, in: directory)) == stampURL {
                            try? FileManager.default.removeItem(at: stampURL)
                        }
                    }
                }
            }
            try decode.write(to: temporary, work: state)
            let outputSHA = try pcmChecksum(temporary, work: state)
            let currentSource = try PostproductionPaths.file(track.file, in: folder)
            guard currentSource == source, try pcmChecksum(currentSource, work: state) == sourceSHA else {
                throw pcmSourceFailure("The source master changed during decoding; retry the export")
            }
            try state.check()
            guard try pcmDirectory(folder, create: false) == directory,
                  try PostproductionPaths.managedFile(cache.lastPathComponent, in: directory) == cache,
                  try PostproductionPaths.managedFile(stampURL.lastPathComponent, in: directory) == stampURL else {
                throw pcmSourceFailure("The PCM cache paths changed")
            }
            let handle = try FileHandle(forWritingTo: temporary)
            try handle.synchronize(); try handle.close()
            try state.check()
            try AtomicFileWriter.posixRename(from: temporary, to: cache)
            published = true
            // A sidecar is the validity marker and is written only after the
            // complete CAF is closed, hashed and atomically published.
            try state.check()
            let stamp = PCMSourceStamp(sourceSHA256: sourceSHA, outputSHA256: outputSHA, frameCount: frameCount)
            try AtomicFileWriter.writeEncodable(stamp, to: stampURL)
            try state.check()
            valid = true
            return PCMAudioSource(url: cache, frameCount: frameCount, sourceSHA256: sourceSHA, outputSHA256: outputSHA)
        }
    }
}

private struct PCMSourceStamp: Codable {
    var schema = "rushes.pcm-source/1"
    let sourceSHA256: String
    let outputSHA256: String
    let frameCount: Int64
}

private func pcmDirectory(_ folder: URL, create: Bool) throws -> URL {
    guard folder.resolvingSymlinksInPath().standardizedFileURL == folder else {
        throw pcmSourceFailure("The recording package path changed")
    }
    let renders = try PostproductionPaths.managedDirectory("renders", in: folder, create: create)
    return try PostproductionPaths.managedDirectory("pcm-sources", in: renders, create: create)
}

private func pcmCachedSource(cache: URL, stampURL: URL, sourceSHA: String, work: PCMSourceWork<PCMAudioSource?>) throws -> PCMAudioSource? {
    guard FileManager.default.fileExists(atPath: cache.path), FileManager.default.fileExists(atPath: stampURL.path) else { return nil }
    let handle = try FileHandle(forReadingFrom: stampURL)
    defer { try? handle.close() }
    guard let data = try handle.read(upToCount: 65_537), data.count <= 65_536,
          let stamp = try? JSONDecoder().decode(PCMSourceStamp.self, from: data),
          stamp.schema == "rushes.pcm-source/1", stamp.sourceSHA256 == sourceSHA,
          stamp.frameCount > 0, stamp.frameCount <= 604_800 * 48_000,
          stamp.outputSHA256.count == 64 else { return nil }
    guard try pcmChecksum(cache, work: work) == stamp.outputSHA256 else { return nil }
    guard let file = try? AVAudioFile(forReading: cache, commonFormat: .pcmFormatFloat32, interleaved: false) else { return nil }
    defer { file.close() }
    guard file.length == stamp.frameCount, file.fileFormat.sampleRate == 48_000,
          file.fileFormat.channelCount == 2, file.fileFormat.commonFormat == .pcmFormatFloat32 else { return nil }
    return PCMAudioSource(url: cache, frameCount: stamp.frameCount, sourceSHA256: sourceSHA, outputSHA256: stamp.outputSHA256)
}

private func pcmDigest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

private func pcmChecksum<T>(_ url: URL, work: PCMSourceWork<T>) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hash = SHA256()
    while true {
        try work.check()
        guard let data = try handle.read(upToCount: 1_048_576), !data.isEmpty else { break }
        hash.update(data: data)
    }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

private func pcmFramePosition(_ time: CMTime, nonnegative: Bool = false) throws -> Int64 {
    let seconds = time.seconds
    guard time.isNumeric, seconds.isFinite, abs(seconds) <= 604_800,
          !nonnegative || seconds >= 0 else { throw pcmSourceFailure("Invalid source audio timestamp or duration") }
    return CMTimeConvertScale(time, timescale: 48_000, method: .roundHalfAwayFromZero).value
}

/// SDK objects are owned by a single decode queue after asynchronous asset
/// loading. Neither AVAudioEngine nor an input/output hardware node is used.
private final class PCMSourceDecoder: @unchecked Sendable {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let frameCount: Int64
    init(asset: AVURLAsset, track: AVAssetTrack, frameCount: Int64) {
        self.asset = asset; self.track = track; self.frameCount = frameCount
    }

    func write(to url: URL, work: PCMSourceWork<PCMAudioSource>) throws {
        let reader = try AVAssetReader(asset: asset)
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
        guard reader.canAdd(output) else { throw pcmSourceFailure("The audio decoder does not support this source format") }
        reader.add(output); work.attach(reader)
        defer { work.detachReader(); if reader.status == .reading { reader.cancelReading() } }
        guard reader.startReading() else { throw pcmSourceFailure(reader.error?.localizedDescription ?? "Audio decoding could not start") }
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: true),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8_192) else {
            throw pcmSourceFailure("Cannot allocate the bounded PCM conversion buffer")
        }
        let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: true)
        defer { file.close() }
        var written: Int64 = 0
        func silence(until target: Int64) throws {
            while written < target {
                try work.check()
                buffer.frameLength = AVAudioFrameCount(min(8_192, target - written))
                let buffers = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                for entry in buffers { if let data = entry.mData { memset(data, 0, Int(entry.mDataByteSize)) } }
                try file.write(from: buffer); written += Int64(buffer.frameLength)
            }
        }
        while true {
            try work.check()
            guard let sample = output.copyNextSampleBuffer() else { break }
            try autoreleasepool {
                guard let description = sample.formatDescription,
                      CMFormatDescriptionGetMediaType(description) == kCMMediaType_Audio,
                      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
                      asbd.pointee.mFormatID == kAudioFormatLinearPCM,
                      asbd.pointee.mSampleRate == 48_000, asbd.pointee.mChannelsPerFrame == 2,
                      asbd.pointee.mBitsPerChannel == 32,
                      asbd.pointee.mFormatFlags & kAudioFormatFlagIsFloat != 0,
                      asbd.pointee.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0 else {
                    throw pcmSourceFailure("The decoder returned an unexpected PCM format")
                }
                let count = CMSampleBufferGetNumSamples(sample)
                guard count > 0, count <= Int(Int32.max) else { throw pcmSourceFailure("Invalid decoded audio sample count") }
                let start = try pcmFramePosition(sample.presentationTimeStamp)
                let trimStart = try pcmTrimFrames(sample, key: kCMSampleBufferAttachmentKey_TrimDurationAtStart)
                let trimEnd = try pcmTrimFrames(sample, key: kCMSampleBufferAttachmentKey_TrimDurationAtEnd)
                guard trimStart <= Int64(count), trimEnd <= Int64(count) - trimStart else {
                    throw pcmSourceFailure("Invalid decoded audio trim duration")
                }
                let endOffset = Int64(count) - trimEnd
                // Fully discarded priming buffers never extend the timeline.
                if trimStart == endOffset { return }
                try silence(until: min(frameCount, max(0, start + trimStart)))
                // Negative AAC priming and already-written overlapping frames
                // are trimmed without moving subsequent source timestamps.
                var offset = max(trimStart, written - start)
                while offset < endOffset, written < frameCount {
                    try work.check()
                    let size = min(Int64(8_192), endOffset - offset, frameCount - written)
                    buffer.frameLength = AVAudioFrameCount(size)
                    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: Int32(offset),
                        frameCount: Int32(size), into: buffer.mutableAudioBufferList)
                    guard status == noErr else { throw pcmSourceFailure("Cannot copy decoded PCM frames (\(status))") }
                    try file.write(from: buffer); written += size; offset += size
                }
            }
        }
        try work.check()
        guard reader.status == .completed else { throw pcmSourceFailure(reader.error?.localizedDescription ?? "Audio decoding ended before completion") }
        try silence(until: frameCount)
        guard file.length == frameCount else { throw pcmSourceFailure("Decoded PCM length differs from its source timeline") }
    }
}

private func pcmTrimFrames(_ sample: CMSampleBuffer, key: CFString) throws -> Int64 {
    guard let value = CMGetAttachment(sample, key: key, attachmentModeOut: nil) else { return 0 }
    guard CFGetTypeID(value) == CFDictionaryGetTypeID() else { throw pcmSourceFailure("Invalid decoded audio trim attachment") }
    return try pcmFramePosition(CMTimeMakeFromDictionary(unsafeDowncast(value, to: CFDictionary.self)), nonnegative: true)
}

/// Cancellation and the stall deadline are recorded here. A hung
/// `copyNextSampleBuffer` never reaches `check()`, so `interrupt` resumes the
/// caller immediately and abandons that copy. `cancelReading` stays on the
/// decode queue: calling it while the copy is in flight segfaults on
/// GitHub-hosted macOS. The worker still cleans up once the copy returns.
final class PCMSourceWork<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, any Error>?
    private var interruption: (any Error)?
    private var completed = false
    private var reader: AVAssetReader?
    private let stallTimeout: TimeInterval
    private var timerResumed = false
    private let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
    private let queue = DispatchQueue(label: "rushes.pcm-source.\(UUID().uuidString)", qos: .utility)

    init(stallTimeout: TimeInterval = 30) {
        self.stallTimeout = stallTimeout
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.interrupt(ControlFailure(code: "audio-reader-stalled", message: "Straight audio source decoding made no progress for \(Int(self.stallTimeout)) seconds"))
        }
    }
    deinit { if timerResumed { timer.cancel() } }

    func run(_ operation: @escaping @Sendable (PCMSourceWork<Value>) throws -> Value) async throws -> Value {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                lock.lock()
                if let interruption { lock.unlock(); continuation.resume(throwing: interruption); return }
                self.continuation = continuation
                if !timerResumed {
                    timerResumed = true
                    timer.schedule(deadline: .now() + stallTimeout)
                    timer.resume()
                }
                lock.unlock()
                queue.async {
                    let result = Result { try operation(self) }
                    self.lock.lock()
                    let continuation = self.continuation
                    self.continuation = nil; self.completed = true
                    let interruption = self.interruption
                    self.lock.unlock()
                    if let interruption { continuation?.resume(throwing: interruption) }
                    else { continuation?.resume(with: result) }
                }
            }
        } onCancel: { self.interrupt(CancellationError()) }
    }

    func check() throws {
        lock.lock(); let interruption = interruption; lock.unlock()
        if let interruption { throw interruption }
        timer.schedule(deadline: .now() + stallTimeout)
    }
    func attach(_ reader: AVAssetReader) { lock.lock(); self.reader = reader; lock.unlock() }
    func detachReader() { lock.lock(); reader = nil; lock.unlock() }
    private func interrupt(_ error: any Error) {
        lock.lock()
        guard !completed, interruption == nil else { lock.unlock(); return }
        interruption = error
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(throwing: error)
    }
}

private func pcmSourceFailure(_ message: String) -> ControlFailure {
    ControlFailure(code: "pcm-source-failed", message: message)
}
