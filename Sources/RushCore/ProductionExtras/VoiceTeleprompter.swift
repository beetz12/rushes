import AVFoundation
import CoreMedia
import Foundation
import Speech

public struct TeleprompterProgress: Codable, Equatable, Sendable {
    public var position: Int
    public var tokenCount: Int
    public var charOffset: Int
    public var recognizedText: String
    public var sourceStartMs: Double?
    public var sourceEndMs: Double?
    public var state: String
    public var receivedBuffers: Int
    public var droppedBuffers: Int
    public var errorCode: String?
    public var message: String?
}

/// A volatile update may re-deliver earlier words. Only its newly recognized suffix is consumed.
struct ProgressiveScriptTracker: Sendable {
    var matcher: TeleprompterMatcher
    private var previousTokens: [String] = []
    private var rangeStart = -Double.infinity
    private var finalizedThrough = -Double.infinity
    init(script: String) { matcher = TeleprompterMatcher(script: script) }
    mutating func consume(text: String, startMs: Double, endMs: Double, isFinal: Bool) -> Int {
        guard startMs.isFinite, endMs.isFinite, endMs > finalizedThrough else { return matcher.position }
        let tokens = text.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
        if abs(rangeStart - startMs) > 0.5 { previousTokens = []; rangeStart = startMs }
        let common = zip(previousTokens, tokens).prefix { $0.0 == $0.1 }.count
        matcher.consume(tokens.dropFirst(common).joined(separator: " "))
        previousTokens = tokens
        if isFinal { finalizedThrough = max(finalizedThrough, endMs); previousTokens = []; rangeStart = -.infinity }
        return matcher.position
    }
}

private struct OwnedPCMFrame: @unchecked Sendable {
    let buffer: AVAudioPCMBuffer
    let time: CMTime
}

private final class VoiceFinishLatch: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<TeleprompterProgress, Error>?
    init(_ continuation: CheckedContinuation<TeleprompterProgress, Error>) { self.continuation = continuation }
    func claim() -> CheckedContinuation<TeleprompterProgress, Error>? {
        lock.withLock { let value = continuation; continuation = nil; return value }
    }
}

/// Tee only the existing recording microphone into this service. It never opens an audio device.
public final class VoiceTeleprompter: @unchecked Sendable {
    public typealias ProgressHandler = @Sendable (TeleprompterProgress) -> Void
    private let analyzer: SpeechAnalyzer
    private let transcriber: SpeechTranscriber
    private let analyzerFormat: AVAudioFormat
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private let queue = DispatchQueue(label: "rushes.teleprompter.conversion", qos: .utility)
    private let progressQueue = DispatchQueue(label: "rushes.teleprompter.progress", qos: .utility)
    private let lock = NSLock()
    private let callback: ProgressHandler
    private let maxPendingBuffers: Int
    private let scriptOffsets: [Int]
    private var tracker: ProgressiveScriptTracker
    private var state = "listening"
    private var accepting = true
    private var pendingBuffers = 0
    private var receivedBuffers = 0
    private var droppedBuffers = 0
    private var lastSubmittedTime: Double = -.infinity
    private var pendingProgress: TeleprompterProgress?
    private var deliveringProgress = false
    private var currentText = ""
    private var rangeStartMs: Double?
    private var rangeEndMs: Double?
    private var errorCode: String?
    private var errorMessage: String?
    // Only the conversion queue touches converter and convertedEndTime.
    private var converter: AVAudioConverter?
    private var convertedEndTime = CMTime.zero
    private var analysisTask: Task<Void, Error>?
    private var resultTask: Task<Void, Error>?

    private init(script: String, analyzer: SpeechAnalyzer, transcriber: SpeechTranscriber,
                 format: AVAudioFormat, continuation: AsyncStream<AnalyzerInput>.Continuation,
                 maxPendingBuffers: Int, callback: @escaping ProgressHandler) {
        self.analyzer = analyzer; self.transcriber = transcriber; self.analyzerFormat = format
        self.continuation = continuation; self.maxPendingBuffers = maxPendingBuffers; self.callback = callback
        tracker = ProgressiveScriptTracker(script: script)
        // Character offsets use UTF-16 units, matching Electron/JavaScript string offsets.
        var offsets: [Int] = [], inToken = false, offset = 0
        for character in script {
            if character.isLetter || character.isNumber {
                if !inToken { offsets.append(offset) }; inToken = true
            } else { inToken = false }
            offset += String(character).utf16.count
        }
        offsets.append(script.utf16.count); scriptOffsets = offsets
    }

    public static func start(script: String, localeIdentifier: String = Locale.current.identifier,
                             allowAssetDownload: Bool = false, maxPendingBuffers: Int = 8,
                             progress: @escaping ProgressHandler) async throws -> VoiceTeleprompter {
        guard script.count <= 32_768, !TeleprompterMatcher(script: script).tokens.isEmpty, localeIdentifier.count <= 128,
              (1...32).contains(maxPendingBuffers) else {
            throw ControlFailure(code: "invalid-params", message: "A nonempty script (up to 32768 characters) and 1–32 pending recognition buffers are required.")
        }
        guard SpeechTranscriber.isAvailable else { throw ControlFailure(code: "speech-unsupported", message: "This Mac cannot run Apple's on-device speech model.") }
        let requested = Locale(identifier: localeIdentifier)
        let locales = await SpeechTranscriber.supportedLocales
        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested)
            ?? locales.first { $0.language.languageCode == requested.language.languageCode }
            ?? locales.first { $0.language.languageCode?.identifier == "en" }
        guard let locale else { throw ControlFailure(code: "speech-locale-unsupported", message: "No supported on-device speech language is available.") }
        let transcriber = SpeechTranscriber(locale: locale, preset: .timeIndexedProgressiveTranscription)
        let status = await AssetInventory.status(forModules: [transcriber])
        if status != .installed {
            guard status != .unsupported else { throw ControlFailure(code: "speech-assets-unsupported") }
            guard allowAssetDownload else {
                throw ControlFailure(code: "speech-assets-required", message: "Install Apple's on-device model for \(locale.identifier). Audio stays on this Mac.",
                    details: ["locale": .string(locale.identifier), "canDownload": .bool(true), "audioLeavesDevice": .bool(false)])
            }
            do {
                _ = try await AssetInventory.reserve(locale: locale)
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) { try await request.downloadAndInstall() }
            } catch { throw ControlFailure(code: "speech-assets-install-failed", message: "Apple speech model installation failed: \(error.localizedDescription)") }
        }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]),
              format.sampleRate.isFinite, (8000...192000).contains(format.sampleRate),
              (1...8).contains(format.channelCount) else {
            throw ControlFailure(code: "speech-audio-format", message: "Apple did not provide a compatible recognition audio format.")
        }
        let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self, bufferingPolicy: .bufferingNewest(maxPendingBuffers))
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        do { try await analyzer.prepareToAnalyze(in: format) }
        catch { throw mapError(error) }
        let service = VoiceTeleprompter(script: script, analyzer: analyzer, transcriber: transcriber,
                                       format: format, continuation: continuation, maxPendingBuffers: maxPendingBuffers, callback: progress)
        service.analysisTask = Task { [weak service] in
            do {
                _ = try await analyzer.analyzeSequence(stream)
                try await analyzer.finalizeAndFinishThroughEndOfInput()
            } catch {
                await analyzer.cancelAndFinishNow()
                let failure = Self.mapError(error); service?.fail(failure); throw failure
            }
        }
        service.resultTask = Task { [weak service] in
            do {
                for try await result in transcriber.results {
                    service?.recognized(String(result.text.characters), range: result.range, isFinal: result.isFinal)
                }
            } catch {
                let failure = Self.mapError(error); service?.fail(failure); throw failure
            }
        }
        service.publish(); return service
    }

    /// The caller supplies recording media time after epoch/pause adjustment. false means optional ASR work was dropped.
    @discardableResult public func submit(_ buffer: AVAudioPCMBuffer, at mediaTime: CMTime) -> Bool {
        let seconds = CMTimeGetSeconds(mediaTime)
        guard seconds.isFinite, (0...604800).contains(seconds), buffer.frameLength > 0,
              buffer.format.sampleRate.isFinite, (8000...192000).contains(buffer.format.sampleRate),
              (1...8).contains(buffer.format.channelCount),
              Double(buffer.frameLength) <= buffer.format.sampleRate * 0.5 else { reject(); return false }
        lock.lock()
        guard accepting, pendingBuffers < maxPendingBuffers, seconds > lastSubmittedTime else {
            droppedBuffers += 1; lock.unlock(); return false
        }
        pendingBuffers += 1; receivedBuffers += 1; lastSubmittedTime = seconds; lock.unlock()
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            completePending(); reject(); return false
        }
        copy.frameLength = buffer.frameLength
        let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in source.indices {
            guard let input = source[index].mData, let output = destination[index].mData,
                  source[index].mDataByteSize <= destination[index].mDataByteSize else { completePending(); reject(); return false }
            memcpy(output, input, Int(source[index].mDataByteSize))
        }
        let frame = OwnedPCMFrame(buffer: copy, time: mediaTime)
        queue.async { [self, frame] in
            defer { completePending() }
            guard isActive else { return }
            do { try convertAndYield(frame) }
            catch { fail(Self.mapError(error)); continuation.finish() }
        }
        return true
    }

    @discardableResult public func submit(_ sampleBuffer: CMSampleBuffer, at mediaTime: CMTime) -> Bool {
        guard CMSampleBufferIsValid(sampleBuffer), let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              CMFormatDescriptionGetMediaType(description) == kCMMediaType_Audio,
              let stream = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              stream.pointee.mFormatID == kAudioFormatLinearPCM,
              let format = AVAudioFormat(cmAudioFormatDescription: description) as AVAudioFormat?,
              format.sampleRate.isFinite, (8000...192000).contains(format.sampleRate),
              (1...8).contains(format.channelCount),
              CMSampleBufferGetNumSamples(sampleBuffer) > 0,
              CMSampleBufferGetNumSamples(sampleBuffer) <= Int(format.sampleRate * 0.5),
              let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(CMSampleBufferGetNumSamples(sampleBuffer))) else {
            reject(); return false
        }
        pcm.frameLength = pcm.frameCapacity
        let result = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(pcm.frameLength), into: pcm.mutableAudioBufferList)
        guard result == noErr else { reject(); return false }
        return submit(pcm, at: mediaTime)
    }

    /// Finalization is bounded independently of an unresponsive OS recognition service.
    public func finish(timeoutSeconds: Double = 5) async throws -> TeleprompterProgress {
        guard timeoutSeconds.isFinite, (0.01...30).contains(timeoutSeconds) else { throw ControlFailure(code: "invalid-params") }
        let tasks = lock.withLock {
            accepting = false; if state == "listening" { state = "finishing" }
            return (analysisTask, resultTask)
        }
        return try await withCheckedThrowingContinuation { completion in
            let latch = VoiceFinishLatch(completion)
            let timeout = Task { [weak self] in
                do { try await Task.sleep(for: .seconds(timeoutSeconds)) } catch { return }
                guard let completion = latch.claim() else { return }
                let failure = ControlFailure(code: "speech-finalize-timeout", message: "Voice following did not finish within \(timeoutSeconds) seconds. Recording audio remains intact; retry voice following later.")
                self?.fail(failure); self?.abortAnalysis()
                completion.resume(throwing: failure)
            }
            Task { [weak self, conversionQueue = queue, inputContinuation = continuation] in
                await withCheckedContinuation { drained in
                    conversionQueue.async { [weak self] in
                        if let self, self.isActive {
                            do { try self.flushConverter() } catch { self.fail(Self.mapError(error)) }
                        }
                        inputContinuation.finish(); drained.resume()
                    }
                }
                do {
                    try await tasks.0?.value; try await tasks.1?.value
                    guard let completion = latch.claim() else { return }
                    timeout.cancel()
                    guard let self else { completion.resume(throwing: ControlFailure(code: "speech-cancelled")); return }
                    self.lock.withLock { if self.state != "cancelled" && self.state != "failed" { self.state = "finished" } }
                    self.publish()
                    let result = self.snapshot()
                    if result.state == "failed" { completion.resume(throwing: ControlFailure(code: result.errorCode ?? "speech-analysis-failed", message: result.message)) }
                    else { completion.resume(returning: result) }
                } catch {
                    guard let completion = latch.claim() else { return }
                    timeout.cancel(); completion.resume(throwing: Self.mapError(error))
                }
            }
        }
    }

    /// Cancels local work immediately; OS model cleanup runs asynchronously and cannot block capture stop.
    public func cancel() async {
        lock.withLock { accepting = false; state = "cancelled" }
        abortAnalysis(); publish()
    }
    private func abortAnalysis() {
        continuation.finish(); analysisTask?.cancel(); resultTask?.cancel()
        let ownedAnalyzer = analyzer
        Task { await ownedAnalyzer.cancelAndFinishNow() }
    }

    public func snapshot() -> TeleprompterProgress {
        lock.withLock {
            let position = tracker.matcher.position
            return .init(position: position, tokenCount: tracker.matcher.tokens.count,
                         charOffset: scriptOffsets[min(position, scriptOffsets.count - 1)], recognizedText: currentText,
                         sourceStartMs: rangeStartMs, sourceEndMs: rangeEndMs, state: state,
                         receivedBuffers: receivedBuffers, droppedBuffers: droppedBuffers, errorCode: errorCode, message: errorMessage)
        }
    }
    private var isActive: Bool { lock.withLock { state == "listening" || state == "finishing" } }
    private func completePending() { lock.withLock { pendingBuffers -= 1 } }
    private func reject() { lock.withLock { droppedBuffers += 1 } }
    private func publish() {
        let value = snapshot()
        let schedule = lock.withLock {
            pendingProgress = value
            if deliveringProgress { return false }
            deliveringProgress = true; return true
        }
        guard schedule else { return }
        // One callback in flight and one latest snapshot; a slow UI cannot block finish/cancel or grow a queue.
        progressQueue.async { [weak self, callback] in
            while let value = self?.takeProgress() { callback(value) }
        }
    }
    private func takeProgress() -> TeleprompterProgress? {
        lock.withLock {
            let value = pendingProgress; pendingProgress = nil
            if value == nil { deliveringProgress = false }
            return value
        }
    }
    private func fail(_ error: ControlFailure) {
        lock.withLock { if state != "cancelled" { accepting = false; state = "failed"; errorCode = error.payload.code; errorMessage = error.payload.message } }
        publish()
    }
    private func recognized(_ text: String, range: CMTimeRange, isFinal: Bool) {
        let start = CMTimeGetSeconds(range.start) * 1000, end = CMTimeGetSeconds(CMTimeRangeGetEnd(range)) * 1000
        guard start.isFinite, end.isFinite, start >= 0, end >= start, end <= 604800000 else {
            fail(ControlFailure(code: "speech-invalid-time", message: "Apple returned an invalid recognition time range.")); return
        }
        lock.withLock {
            guard state != "cancelled" && state != "failed" else { return }
            _ = tracker.consume(text: text, startMs: start, endMs: end, isFinal: isFinal)
            currentText = String(text.prefix(4096)); rangeStartMs = start; rangeEndMs = end
        }
        publish()
    }
    private func convertAndYield(_ frame: OwnedPCMFrame) throws {
        let output: AVAudioPCMBuffer
        if frame.buffer.format == analyzerFormat { output = frame.buffer }
        else {
            if converter?.inputFormat != frame.buffer.format {
                converter = AVAudioConverter(from: frame.buffer.format, to: analyzerFormat)
                converter?.primeMethod = .none
            }
            guard let converter else { throw ControlFailure(code: "speech-audio-conversion", message: "Captured PCM cannot be converted to the recognition format.") }
            let capacity = AVAudioFrameCount(ceil(Double(frame.buffer.frameLength) * analyzerFormat.sampleRate / frame.buffer.format.sampleRate) + 64)
            guard let converted = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: capacity) else { throw ControlFailure(code: "speech-audio-buffer") }
            var supplied = false, error: NSError?
            let status = converter.convert(to: converted, error: &error) { _, status in
                if supplied { status.pointee = .noDataNow; return nil }
                supplied = true; status.pointee = .haveData; return frame.buffer
            }
            guard error == nil, status != .error else { throw error ?? ControlFailure(code: "speech-audio-conversion") }
            output = converted
        }
        guard output.frameLength > 0 else { return }
        convertedEndTime = CMTimeAdd(frame.time, CMTime(value: Int64(output.frameLength), timescale: CMTimeScale(analyzerFormat.sampleRate)))
        let result = continuation.yield(AnalyzerInput(buffer: output, bufferStartTime: frame.time))
        if case .dropped = result { reject() }
    }
    private func flushConverter() throws {
        guard let converter else { return }
        for _ in 0..<4 {
            guard let output = AVAudioPCMBuffer(pcmFormat: analyzerFormat, frameCapacity: 1024) else { return }
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, status in
                status.pointee = .endOfStream; return nil
            }
            guard error == nil, status != .error else { throw error ?? ControlFailure(code: "speech-audio-conversion") }
            if output.frameLength > 0 {
                let result = continuation.yield(AnalyzerInput(buffer: output, bufferStartTime: convertedEndTime))
                if case .dropped = result { reject() }
                convertedEndTime = CMTimeAdd(convertedEndTime, CMTime(value: Int64(output.frameLength), timescale: CMTimeScale(analyzerFormat.sampleRate)))
            }
            if status == .endOfStream || output.frameLength == 0 { break }
        }
    }
    deinit {
        continuation.finish(); analysisTask?.cancel(); resultTask?.cancel()
        let ownedAnalyzer = analyzer
        Task { await ownedAnalyzer.cancelAndFinishNow() }
    }
    private static func mapError(_ error: Error) -> ControlFailure {
        if let failure = error as? ControlFailure { return failure }
        if error is CancellationError { return ControlFailure(code: "speech-cancelled", message: "Voice following was cancelled.") }
        let text = error.localizedDescription
        if text.localizedCaseInsensitiveContains("permission") || text.localizedCaseInsensitiveContains("authorization") {
            return ControlFailure(code: "permission-denied", message: "Allow Speech Recognition for Rushes in System Settings > Privacy & Security, then retry.", details: ["permission": .string("speech")])
        }
        return ControlFailure(code: "speech-analysis-failed", message: text)
    }
}
