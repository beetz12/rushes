@preconcurrency import AVFoundation
import CryptoKit
import Foundation
import Testing
@testable import RushCore

/// File-only media fixtures. No microphone, camera, screen or audio devices.
private struct PCMSourceFixture {
    let root: URL
    let package: RecordingPackage
    var track: RecordingManifest.RecordingTrack { .init(kind: .microphone, codec: "aac") }

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-pcm-source-\(UUID().uuidString)", isDirectory: true)
        package = try RecordingPackage.create(root: root)
    }
    func cleanup() { try? FileManager.default.removeItem(at: root) }

    func audio(rate: Int = 48_000, channels: Int = 1, aac: Bool = true,
               windows: [Range<Int>]? = nil, duration: Double = 1, videoTail: Bool = false) async throws {
        // AVAssetWriter can concatenate noncontiguous input audio PTS. Persist
        // real empty edits with a passthrough composition when testing gaps.
        let masterURL = package.trackURL(for: .microphone)
        let encodedURL = windows == nil ? masterURL : root.appendingPathComponent("encoded.mov")
        let writer = try AVAssetWriter(outputURL: encodedURL, fileType: .mov)
        var settings: [String: Any] = [AVFormatIDKey: aac ? kAudioFormatMPEG4AAC : kAudioFormatLinearPCM,
            AVSampleRateKey: rate, AVNumberOfChannelsKey: channels]
        if aac { settings[AVEncoderBitRateKey] = 128_000 }
        else {
            settings[AVLinearPCMBitDepthKey] = 32; settings[AVLinearPCMIsFloatKey] = true
            settings[AVLinearPCMIsBigEndianKey] = false; settings[AVLinearPCMIsNonInterleaved] = false
        }
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        var tailInput: AVAssetWriterInput?
        var adaptor: AVAssetWriterInputPixelBufferAdaptor?
        if videoTail {
            let video = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: 16, AVVideoHeightKey: 16])
            video.expectsMediaDataInRealTime = true
            writer.add(video); tailInput = video
            adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: 16, kCVPixelBufferHeightKey as String: 16])
        }
        guard writer.startWriting() else { throw renderFailure("PCM fixture start") }
        writer.startSession(atSourceTime: .zero)
        let inputFrames = windows?.reduce(0) { $0 + $1.count } ?? Int(duration * Double(rate))
        for window in [0..<inputFrames] {
            for frame in stride(from: window.lowerBound, to: window.upperBound, by: 1_024) {
                try await waitUntilReadyForMedia(input, writer: writer)
                guard input.append(try Self.sample(frame: frame, count: min(1_024, window.upperBound - frame), rate: rate, channels: channels)) else {
                    throw renderFailure(writer.error?.localizedDescription ?? "PCM fixture append")
                }
            }
        }
        input.markAsFinished()
        if let tailInput, let adaptor {
            try await waitUntilReadyForMedia(tailInput, writer: writer)
            var pixel: CVPixelBuffer?
            guard let pool = adaptor.pixelBufferPool,
                  CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixel) == kCVReturnSuccess, let pixel else {
                throw renderFailure("PCM fixture tail allocation")
            }
            CVPixelBufferLockBaseAddress(pixel, [])
            memset(CVPixelBufferGetBaseAddress(pixel), 0, CVPixelBufferGetDataSize(pixel))
            CVPixelBufferUnlockBaseAddress(pixel, [])
            guard adaptor.append(pixel, withPresentationTime: CMTime(seconds: duration - 1.0 / 30, preferredTimescale: 48_000)) else {
                throw renderFailure("PCM fixture tail append")
            }
            tailInput.markAsFinished()
        }
        writer.endSession(atSourceTime: CMTime(seconds: duration, preferredTimescale: 48_000))
        try await finishWriting(writer, within: 20)
        if let windows {
            let asset = AVURLAsset(url: encodedURL), composition = AVMutableComposition()
            let original = try await asset.loadTracks(withMediaType: .audio)[0]
            let composed = try #require(composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid))
            var sourceFrame = 0
            for window in windows {
                try composed.insertTimeRange(CMTimeRange(start: CMTime(value: Int64(sourceFrame), timescale: Int32(rate)),
                    duration: CMTime(value: Int64(window.count), timescale: Int32(rate))), of: original,
                    at: CMTime(value: Int64(window.lowerBound), timescale: Int32(rate)))
                sourceFrame += window.count
            }
            if videoTail {
                let video = try await asset.loadTracks(withMediaType: .video)[0]
                let composedVideo = try #require(composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid))
                try composedVideo.insertTimeRange(try await video.load(.timeRange), of: video, at: .zero)
            }
            let export = try #require(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetPassthrough))
            try await export.export(to: masterURL, as: .mov)
        }
    }

    static func sample(frame: Int, count: Int, rate: Int, channels: Int) throws -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: Double(rate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: UInt32(channels * 4),
            mFramesPerPacket: 1, mBytesPerFrame: UInt32(channels * 4), mChannelsPerFrame: UInt32(channels), mBitsPerChannel: 32, mReserved: 0)
        var description: CMAudioFormatDescription?
        guard CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
            magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description) == noErr, let description else {
            throw renderFailure("PCM fixture format")
        }
        var block: CMBlockBuffer?
        guard CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
            blockLength: count * channels * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: count * channels * 4, flags: 0, blockBufferOut: &block) == noErr, let block else {
            throw renderFailure("PCM fixture block")
        }
        let values = (0..<(count * channels)).map { i in
            Float(0.3) * sin(2 * Float.pi * (i % channels == 0 ? 440 : 660) * Float(frame + i / channels) / Float(rate))
        }
        let copied = values.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block,
            offsetIntoDestination: 0, dataLength: $0.count) }
        guard copied == noErr else { throw renderFailure("PCM fixture data") }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: Int32(rate)),
            presentationTimeStamp: CMTime(value: Int64(frame), timescale: Int32(rate)), decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: description, sampleCount: count,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
            sampleBufferOut: &sample) == noErr, let sample else { throw renderFailure("PCM fixture sample") }
        return sample
    }

    static func hash(_ url: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined()
    }
    static func samples(_ url: URL, start: Int64 = 0, count: Int = 48_000) throws -> [[Float]] {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        defer { file.close() }
        file.framePosition = start
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(count)))
        try file.read(into: buffer)
        let data = try #require(buffer.floatChannelData)
        return (0..<Int(buffer.format.channelCount)).map { Array(UnsafeBufferPointer(start: data[$0], count: Int(buffer.frameLength))) }
    }
    static func rms(_ samples: [Float]) -> Double {
        sqrt(samples.reduce(0) { $0 + Double($1 * $1) } / Double(samples.count))
    }
}

@Suite(.serialized) struct PCMAudioSourceCacheTests {
    @Test func aacResamplesMonoToCanonicalStereoWithoutApplyingOffsets() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio(rate: 44_100)
        let master = fixture.package.trackURL(for: .microphone), before = try PCMSourceFixture.hash(master)
        var track = fixture.track; track.offsetNs = 720_000_000; track.offsetMs = 720; track.latencyMs = 190
        let source = try await PCMAudioSourceCache().prepare(package: fixture.package, track: track)
        #expect(source.frameCount == 48_000 && source.frameCount48k == source.frameCount && source.durationMs == 1_000)
        #expect(source.sourceSHA256 == before)
        #expect(try source.outputSHA256 == PCMSourceFixture.hash(source.url))
        #expect(try PCMSourceFixture.hash(master) == before)
        let audio = try PCMSourceFixture.samples(source.url)
        #expect(audio.count == 2 && audio[0].count == 48_000)
        #expect(PCMSourceFixture.rms(Array(audio[0][4_800..<9_600])) > 0.1)
        #expect(zip(audio[0], audio[1]).allSatisfy { abs($0 - $1) < 0.00001 })
        let formats = try await AVURLAsset(url: master).loadTracks(withMediaType: .audio)[0].load(.formatDescriptions)
        #expect(CMFormatDescriptionGetMediaSubType(formats[0]) == kAudioFormatMPEG4AAC)
    }

    @Test func absolutePTSLeadingGapInteriorGapAndTrailingAssetDuration() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio(channels: 2, aac: false, windows: [12_000..<24_000, 36_000..<43_200], duration: 1.25, videoTail: true)
        let source = try await PCMAudioSourceCache().prepare(package: fixture.package, track: fixture.track)
        #expect(source.frameCount == 60_000)
        let audio = try PCMSourceFixture.samples(source.url, count: 60_000)
        for channel in audio {
            #expect(channel[0..<12_000].allSatisfy { $0 == 0 })
            #expect(channel[24_000..<36_000].allSatisfy { $0 == 0 })
            #expect(channel[43_200..<60_000].allSatisfy { $0 == 0 })
            #expect(PCMSourceFixture.rms(Array(channel[13_000..<23_000])) > 0.2)
        }
        #expect(zip(audio[0][13_000..<23_000], audio[1][13_000..<23_000]).contains { abs($0 - $1) > 0.3 })
    }

    @Test func aacPrimingAndDiscontinuousPTSDoNotShiftToneOnsets() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio(windows: [12_000..<24_000, 36_000..<48_000], duration: 1.2, videoTail: true)
        let source = try await PCMAudioSourceCache().prepare(package: fixture.package, track: fixture.track)
        #expect(source.frameCount == 57_600)
        let audio = try PCMSourceFixture.samples(source.url, count: 57_600)[0]
        #expect(PCMSourceFixture.rms(Array(audio[0..<10_000])) < 0.00001)
        #expect(PCMSourceFixture.rms(Array(audio[14_000..<22_000])) > 0.1)
        #expect(PCMSourceFixture.rms(Array(audio[27_000..<33_000])) < 0.0001)
        #expect(PCMSourceFixture.rms(Array(audio[38_000..<46_000])) > 0.1)
        #expect(PCMSourceFixture.rms(Array(audio[52_000..<57_600])) < 0.00001)
    }

    @Test func cacheHitConcurrentPreparationAndChangedMaster() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio()
        let cache = PCMAudioSourceCache()
        async let first = cache.prepare(package: fixture.package, track: fixture.track)
        async let second = cache.prepare(package: fixture.package, track: fixture.track)
        let (a, b) = try await (first, second)
        #expect(a.url == b.url && a.outputSHA256 == b.outputSHA256)
        let old = Date(timeIntervalSince1970: 1_000)
        try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: a.url.path)
        var changedMetadata = fixture.track; changedMetadata.latencyMs = 999; changedMetadata.offsetMs = 250
        let hit = try await PCMAudioSourceCache().prepare(package: fixture.package, track: changedMetadata)
        #expect(hit.url == a.url)
        #expect(try FileManager.default.attributesOfItem(atPath: a.url.path)[.modificationDate] as? Date == old)
        try FileManager.default.removeItem(at: fixture.package.trackURL(for: .microphone))
        try await fixture.audio(channels: 2, duration: 0.5)
        let changed = try await cache.prepare(package: fixture.package, track: fixture.track)
        #expect(changed.url != a.url && changed.sourceSHA256 != a.sourceSHA256 && changed.frameCount == 24_000)
        #expect(!(try FileManager.default.contentsOfDirectory(atPath: a.url.deletingLastPathComponent().path)).contains { $0.hasPrefix(".pcm-") })
    }

    @Test func corruptedMissingAndMalformedCacheEntriesAreRebuilt() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio()
        let cache = PCMAudioSourceCache(), source = try await cache.prepare(package: fixture.package, track: fixture.track)
        let stamp = source.url.deletingPathExtension().appendingPathExtension("json")
        try AtomicFileWriter.write(Data("broken CAF".utf8), to: source.url)
        let repaired = try await cache.prepare(package: fixture.package, track: fixture.track)
        #expect(repaired.frameCount == source.frameCount)
        #expect(try repaired.outputSHA256 == PCMSourceFixture.hash(repaired.url))
        #expect(try PCMSourceFixture.rms(PCMSourceFixture.samples(repaired.url)[0]) > 0.1)
        for data in [Data("{\"schema\":\"rushes.pcm-source/1\"".utf8), Data(repeating: 0x20, count: 65_537)] {
            try AtomicFileWriter.write(data, to: stamp)
            _ = try await cache.prepare(package: fixture.package, track: fixture.track)
            let sidecar = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: stamp)) as? [String: Any])
            #expect(try sidecar["outputSHA256"] as? String == PCMSourceFixture.hash(source.url))
        }
        try FileManager.default.removeItem(at: stamp)
        _ = try await cache.prepare(package: fixture.package, track: fixture.track)
        #expect(FileManager.default.fileExists(atPath: stamp.path))
    }

    @Test func cancellationAndInvalidSourceLeaveNoPartialCache() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio(aac: false, duration: 45)
        let cache = PCMAudioSourceCache()
        let task = Task { try await cache.prepare(package: fixture.package, track: fixture.track) }
        let directory = fixture.package.rendersDirectory.appendingPathComponent("pcm-sources")
        var staged = false
        for _ in 0..<2_000 {
            if let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path), names.contains(where: { $0.hasPrefix(".pcm-") }) {
                staged = true; task.cancel(); break
            }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(staged)
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
        try FileManager.default.removeItem(at: fixture.package.trackURL(for: .microphone))
        try AtomicFileWriter.write(Data("invalid master".utf8), to: fixture.package.trackURL(for: .microphone))
        await #expect(throws: (any Error).self) { try await cache.prepare(package: fixture.package, track: fixture.track) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
    }

    @Test func cacheAndMasterSymlinkEscapesAreRejected() async throws {
        let fixture = try PCMSourceFixture(); defer { fixture.cleanup() }
        try await fixture.audio()
        let outside = fixture.root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let marker = outside.appendingPathComponent("marker")
        try AtomicFileWriter.write(Data("preserve".utf8), to: marker)
        let cache = PCMAudioSourceCache(), renders = fixture.package.rendersDirectory
        try FileManager.default.createSymbolicLink(at: renders, withDestinationURL: outside)
        await #expect(throws: ControlFailure.self) { try await cache.prepare(package: fixture.package, track: fixture.track) }
        #expect(try FileManager.default.contentsOfDirectory(atPath: outside.path) == ["marker"])
        try FileManager.default.removeItem(at: renders)
        let source = try await cache.prepare(package: fixture.package, track: fixture.track)
        let stamp = source.url.deletingPathExtension().appendingPathExtension("json")
        for target in [stamp, source.url] {
            let bytes = try Data(contentsOf: target), external = outside.appendingPathComponent(target.lastPathComponent)
            try AtomicFileWriter.write(bytes, to: external)
            try FileManager.default.removeItem(at: target)
            try FileManager.default.createSymbolicLink(at: target, withDestinationURL: external)
            await #expect(throws: ControlFailure.self) { try await cache.prepare(package: fixture.package, track: fixture.track) }
            #expect(try Data(contentsOf: external) == bytes)
            try FileManager.default.removeItem(at: target); try AtomicFileWriter.write(bytes, to: target)
        }
        let master = fixture.package.trackURL(for: .microphone), external = outside.appendingPathComponent("outside.mov")
        try FileManager.default.moveItem(at: master, to: external)
        try FileManager.default.createSymbolicLink(at: master, withDestinationURL: external)
        await #expect(throws: ControlFailure.self) { try await cache.prepare(package: fixture.package, track: fixture.track) }
        #expect(try String(contentsOf: marker, encoding: .utf8) == "preserve")
    }
}
