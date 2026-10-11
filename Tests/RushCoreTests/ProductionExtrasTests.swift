import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Testing
@testable import RushCore

private final class ProgressLog: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [TeleprompterProgress] = []
    func append(_ value: TeleprompterProgress) { lock.withLock { values.append(value) } }
    func read() -> [TeleprompterProgress] { lock.withLock { values } }
}
private func extrasPixelBuffer(width: Int = 320, height: Int = 180) throws -> CVPixelBuffer {
    var buffer: CVPixelBuffer?
    let attributes: [CFString: Any] = [kCVPixelBufferIOSurfacePropertiesKey: [:], kCVPixelBufferMetalCompatibilityKey: true]
    let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer)
    #expect(status == kCVReturnSuccess)
    return try #require(buffer)
}
private func inputFingerprint(_ buffer: CVPixelBuffer) throws -> Data {
    #expect(CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let base = try #require(CVPixelBufferGetBaseAddress(buffer))
    return Data(bytes: base, count: CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer))
}

private func extrasCMBuffer(_ pcm: AVAudioPCMBuffer, hostTime: CMTime) throws -> CMSampleBuffer {
    var sample: CMSampleBuffer?
    var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(pcm.format.sampleRate)),
                                    presentationTimeStamp: hostTime, decodeTimeStamp: .invalid)
    let status = CMSampleBufferCreate(allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: pcm.format.formatDescription,
        sampleCount: Int(pcm.frameLength), sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
    #expect(status == noErr)
    let value = try #require(sample)
    #expect(CMSampleBufferSetDataBufferFromAudioBufferList(value, blockBufferAllocator: kCFAllocatorDefault,
        blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0, bufferList: pcm.audioBufferList) == noErr)
    #expect(CMSampleBufferSetDataReady(value) == noErr)
    return value
}

@Suite("Native production extras")
struct ProductionExtrasTests {
    @Test("Volatile result suffixes never double-advance repeated script words")
    func progressiveMatcher() {
        var tracker = ProgressiveScriptTracker(script: "hello world hello world done")
        #expect(tracker.consume(text: "Hello world", startMs: 0, endMs: 1000, isFinal: false) == 2)
        #expect(tracker.consume(text: "Hello world", startMs: 0, endMs: 1000, isFinal: false) == 2)
        #expect(tracker.consume(text: "Hello world hello", startMs: 0, endMs: 1500, isFinal: false) == 3)
        #expect(tracker.consume(text: "Hello world hello world", startMs: 0, endMs: 2000, isFinal: true) == 4)
        #expect(tracker.consume(text: "Hello world hello world", startMs: 0, endMs: 2000, isFinal: true) == 4)
        #expect(tracker.consume(text: "done", startMs: 2000, endMs: 2300, isFinal: true) == 5)
    }
    @Test("Empty/non-word scripts and invalid buffer limits fail before any model use")
    func scriptValidation() async {
        for script in ["", "   ", "..."] {
            do { _ = try await VoiceTeleprompter.start(script: script) { _ in }; Issue.record("Empty script accepted") }
            catch let error as ControlFailure { #expect(error.payload.code == "invalid-params") }
            catch { Issue.record("Unexpected error: \(error)") }
        }
        do { _ = try await VoiceTeleprompter.start(script: "hello", maxPendingBuffers: 0) { _ in }; Issue.record("Invalid limit accepted") }
        catch let error as ControlFailure { #expect(error.payload.code == "invalid-params") }
        catch { Issue.record("Unexpected error: \(error)") }
    }
    @Test("Blur validates settings and cancels without processing")
    func cancellation() throws {
        #expect(throws: ControlFailure.self) { try CameraBackgroundBlur(radius: .nan) }
        #expect(throws: ControlFailure.self) { try CameraBackgroundBlur(radius: 0) }
        let blur = try CameraBackgroundBlur(), input = try extrasPixelBuffer()
        blur.cancel()
        let result = blur.process(input, at: CMTime(value: 17, timescale: 30))
        #expect(result.pixelBuffer === input)
        #expect(result.disposition == "busy")
        #expect(blur.statistics().dropped == 1)
    }
    @Test("A saved frame uses actual Vision segmentation and preserves source bytes, dimensions and timestamp",
          .enabled(if: ProcessInfo.processInfo.environment["RUSHES_EXTRAS_IMAGE_FIXTURE"] != nil))
    func savedPersonFrame() throws {
        let path = try #require(ProcessInfo.processInfo.environment["RUSHES_EXTRAS_IMAGE_FIXTURE"])
        let image = try #require(CIImage(contentsOf: URL(fileURLWithPath: path)))
        let input = try extrasPixelBuffer(width: Int(image.extent.width), height: Int(image.extent.height))
        CIContext().render(image, to: input)
        let original = try inputFingerprint(input)
        let blur = try CameraBackgroundBlur(radius: 24)
        let timestamp = CMTime(value: 123456, timescale: 48_000)
        let result = blur.process(input, at: timestamp)
        print("VISION_PERSON detected=\(result.personDetected) coverage=\(result.foregroundCoverage) elapsedMs=\(result.processingMs) disposition=\(result.disposition) error=\(result.message ?? "none")")
        #expect(result.disposition == "processed")
        #expect(result.personDetected); #expect(result.foregroundCoverage > 0.02 && result.foregroundCoverage < 0.8)
        #expect(CVPixelBufferGetWidth(result.pixelBuffer) == CVPixelBufferGetWidth(input))
        #expect(CVPixelBufferGetHeight(result.pixelBuffer) == CVPixelBufferGetHeight(input))
        #expect(result.presentationTime == timestamp)
        #expect(try inputFingerprint(input) == original)
        #expect(try inputFingerprint(result.pixelBuffer) != original)
        var warmDurations: [Double] = []
        for index in 0..<10 {
            autoreleasepool {
                let warm = blur.process(input, at: CMTime(value: Int64(index + 1), timescale: 30))
                #expect(warm.disposition == "processed")
                #expect(warm.personDetected)
                warmDurations.append(warm.processingMs)
            }
        }
        let ordered = warmDurations.sorted()
        print("VISION_WARM samples=10 medianMs=\(ordered[5]) maxMs=\(ordered.last ?? -1)")
        if let outputPath = ProcessInfo.processInfo.environment["RUSHES_EXTRAS_BLUR_OUTPUT"] {
            try CIContext().writePNGRepresentation(of: CIImage(cvPixelBuffer: result.pixelBuffer), to: URL(fileURLWithPath: outputPath), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        }
    }
    @Test("A frame with no person reports full-background blur using actual Vision")
    func absentPerson() throws {
        let input = try extrasPixelBuffer()
        CIContext().render(CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 320, height: 180)), to: input)
        let result = try CameraBackgroundBlur().process(input, at: .zero)
        print("VISION_EMPTY detected=\(result.personDetected) coverage=\(result.foregroundCoverage) disposition=\(result.disposition)")
        #expect(!result.personDetected); #expect(result.foregroundCoverage < 0.002)
        #expect(result.disposition == "no-person")
    }
    @Test("Bounded blur worker declines concurrent optional work promptly")
    func boundedBlur() async throws {
        let blur = try CameraBackgroundBlur(), input = try extrasPixelBuffer(width: 1280, height: 720)
        CIContext().render(CIImage(color: .gray).cropped(to: CGRect(x: 0, y: 0, width: 1280, height: 720)), to: input)
        let started = Date()
        let result = await withCheckedContinuation { continuation in
            let accepted = blur.submit(input, at: .zero) { frame in continuation.resume(returning: frame) }
            #expect(accepted)
            #expect(!blur.submit(input, at: CMTime(value: 1, timescale: 30)) { _ in Issue.record("Concurrent blur was accepted") })
            #expect(Date().timeIntervalSince(started) < 0.05)
        }
        #expect(result.presentationTime == .zero)
        #expect(blur.statistics().processed == 1); #expect(blur.statistics().dropped >= 1)
    }
    @Test("Audio overflow remains bounded and cancellation rejects subsequent samples",
          .enabled(if: ProcessInfo.processInfo.environment["RUSHES_EXTRAS_SPEECH_FIXTURE"] != nil), .timeLimit(.minutes(1)))
    func voiceBackpressure() async throws {
        let service = try await VoiceTeleprompter.start(script: "hello world", localeIdentifier: "en-US", maxPendingBuffers: 1) { _ in }
        let format = try #require(AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1))
        let pcm = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800))
        pcm.frameLength = 4800
        let samples = try #require(pcm.floatChannelData)[0]
        for index in 0..<4800 { samples[index] = 0 }
        #expect(!service.submit(pcm, at: CMTime(value: Int64.max, timescale: 1)))
        for index in 0..<100 {
            _ = service.submit(pcm, at: CMTime(value: Int64(index * 4800), timescale: 48000))
        }
        let snapshot = service.snapshot()
        #expect(snapshot.droppedBuffers > 0)
        #expect(snapshot.receivedBuffers < 100)
        await service.cancel()
        #expect(service.snapshot().state == "cancelled")
        #expect(!service.submit(pcm, at: CMTime(seconds: 20, preferredTimescale: 48000)))
    }
    @Test("Streaming Apple recognition advances real spoken PCM to the last script token",
          .enabled(if: ProcessInfo.processInfo.environment["RUSHES_EXTRAS_SPEECH_FIXTURE"] != nil), .timeLimit(.minutes(1)))
    func realStreamingRecognition() async throws {
        let path = try #require(ProcessInfo.processInfo.environment["RUSHES_EXTRAS_SPEECH_FIXTURE"])
        let script = "🎬 This is a recording test for our new video application. The microphone records clear audio. We can record a screen, review the video, and export captions. This recording stays on this computer."
        let updates = ProgressLog()
        let service = try await VoiceTeleprompter.start(script: script, localeIdentifier: "en-US", maxPendingBuffers: 16) { updates.append($0) }
        let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
        let frames = AVAudioFrameCount(file.processingFormat.sampleRate * 0.1)
        while file.framePosition < file.length {
            let position = file.framePosition
            let pcm = try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames))
            try file.read(into: pcm)
            let mediaTime = CMTime(value: position, timescale: CMTimeScale(file.processingFormat.sampleRate))
            let accepted: Bool
            if Int(position / Int64(frames)) % 2 == 0 {
                let sample = try extrasCMBuffer(pcm, hostTime: CMTimeAdd(mediaTime, CMTime(seconds: 1000, preferredTimescale: 48000)))
                accepted = service.submit(sample, at: mediaTime)
            } else { accepted = service.submit(pcm, at: mediaTime) }
            #expect(accepted)
            try await Task.sleep(for: .milliseconds(90))
        }
        let final = try await service.finish()
        let events = updates.read()
        print("VOICE_STREAM position=\(final.position)/\(final.tokenCount) state=\(final.state) received=\(final.receivedBuffers) dropped=\(final.droppedBuffers) updates=\(events.count) text=\(final.recognizedText)")
        #expect(final.state == "finished"); #expect(final.position == final.tokenCount)
        #expect(final.charOffset == script.utf16.count)
        #expect(final.droppedBuffers == 0)
        #expect(events.contains { $0.state == "listening" && $0.position > 0 })
        #expect(events.contains { $0.recognizedText.lowercased().contains("recording") })
        #expect(zip(events, events.dropFirst()).allSatisfy { $0.1.position >= $0.0.position })
        #expect(events.contains { ($0.sourceEndMs ?? 0) > 1000 })
        #expect(events.allSatisfy { ($0.sourceEndMs ?? 0) < 30_000 })
        await service.cancel()
        #expect(!service.submit(try #require(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)), at: .zero))
    }
}
