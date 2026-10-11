import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

public struct TeleprompterConfiguration: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var script: String
    public var locale: String
    public init(enabled: Bool = false, script: String = "", locale: String = "en-US") {
        self.enabled = enabled; self.script = script; self.locale = locale
    }
    public func validate() throws {
        guard script.count <= 32_768, !locale.isEmpty, locale.count <= 128,
              !enabled || !TeleprompterMatcher(script: script).tokens.isEmpty else {
            throw ControlFailure(code: "invalid-params", message: "Enabled voice following needs a nonempty script up to32768 characters and a valid locale identifier.")
        }
    }
}
public struct CameraBlurConfiguration: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var radius: Double
    public init(enabled: Bool = false, radius: Double = 18) { self.enabled = enabled; self.radius = radius }
    public func validate() throws {
        guard radius.isFinite, (1...80).contains(radius) else { throw ControlFailure(code: "invalid-params", message: "Camera blur radius must be1–80 pixels.") }
    }
}
public struct ProductionEffectsPolicy: Codable, Equatable, Sendable {
    public var schema = "rushes.production-effects/1"
    public var cameraBlur: CameraBlurConfiguration
    public init(cameraBlur: CameraBlurConfiguration = .init()) { self.cameraBlur = cameraBlur }
    public func validate() throws {
        guard schema == "rushes.production-effects/1" else { throw ControlFailure(code: "unsupported-effects-schema") }
        try cameraBlur.validate()
    }
    /// Missing policy is disabled. Malformed or unsafe policy throws; it never silently bypasses requested protection.
    public static func read(from packageURL: URL) throws -> ProductionEffectsPolicy {
        let file = try RecordingPackage.open(folderURL: packageURL).validatedMediaURL("production-effects.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return .init() }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: 65_537) ?? Data()
        guard data.count <= 65_536 else { throw ControlFailure(code: "invalid-effects-policy", message: "Camera effects policy exceeds its size limit.") }
        do {
            let policy = try JSONDecoder().decode(Self.self, from: data)
            try policy.validate(); return policy
        } catch let failure as ControlFailure { throw failure }
        catch { throw ControlFailure(code: "invalid-effects-policy", message: "The recording's camera effects policy is malformed; the requested protection was not bypassed.") }
    }
    public func write(to packageURL: URL) throws {
        try validate()
        let literal = packageURL.appendingPathComponent("production-effects.json")
        if let type = try? FileManager.default.attributesOfItem(atPath: literal.path)[.type] as? FileAttributeType,
           type == .typeSymbolicLink { throw ControlFailure(code: "unsafe-effects-policy", message: "A policy symlink cannot be used as a write destination.") }
        let file = try RecordingPackage.open(folderURL: packageURL).validatedMediaURL("production-effects.json")
        guard file.lastPathComponent == "production-effects.json" else { throw ControlFailure(code: "unsafe-effects-policy") }
        try AtomicFileWriter.writeEncodable(self, to: file)
    }
}

private struct EffectsFrame: @unchecked Sendable { let buffer: CVPixelBuffer; let time: CMTime }

/// Off-capture export processing. A requested privacy effect either succeeds or fails the render; raw is never returned.
public final class CameraBlurExportWorker: @unchecked Sendable {
    private let processor: CameraBackgroundBlur
    private let queue = DispatchQueue(label: "rushes.camera.blur-export", qos: .utility)
    private let lock = NSLock()
    private var pending = 0
    public init(radius: Double = 18) throws { processor = try CameraBackgroundBlur(radius: radius) }
    public func process(_ pixelBuffer: CVPixelBuffer, at time: CMTime) async throws -> CameraBlurFrame {
        try Task.checkCancellation()
        let accepted = lock.withLock { if pending >= 2 { return false }; pending += 1; return true }
        guard accepted else { throw ControlFailure(code: "blur-export-busy", message: "The bounded camera blur export worker is busy.") }
        let input = EffectsFrame(buffer: pixelBuffer, time: time)
        return try await withCheckedThrowingContinuation { continuation in
            queue.async { [self, input] in
                defer { lock.withLock { pending -= 1 } }
                let frame = processor.process(input.buffer, at: input.time)
                guard frame.disposition == "processed" || frame.disposition == "no-person" else {
                    continuation.resume(throwing: ControlFailure(code: frame.errorCode ?? "blur-export-failed",
                        message: frame.message ?? "Requested camera blur was not applied; raw camera image was withheld.")); return
                }
                continuation.resume(returning: frame)
            }
        }
    }
    public func cancel() { processor.cancel() }
}

/// Device-free service coordinator. Controller owns settings persistence, recording lifecycle and capture hookup.
public final class ProductionEffectsCoordinator: @unchecked Sendable {
    public typealias VoiceHandler = @Sendable (_ recordingID: String, _ progress: TeleprompterProgress) -> Void
    public typealias WarningHandler = @Sendable (_ code: String, _ message: String) -> Void
    public static let commands: Set<String> = ["teleprompter.set", "teleprompter.get", "teleprompter.start", "teleprompter.stop", "camera.blur.set", "camera.blur.get"]
    private let lock = NSLock()
    private let onVoice: VoiceHandler
    private let warning: WarningHandler
    private var teleprompter = TeleprompterConfiguration()
    private var cameraBlur = CameraBlurConfiguration()
    private var voice: VoiceTeleprompter?
    private var blur: CameraBackgroundBlur?
    private var recordingID: String?
    private var microphoneEnabled = false
    private var voiceGeneration: UInt64 = 0
    private var blurGeneration: UInt64 = 0
    private var lastProgress: TeleprompterProgress?
    private var lastVoiceError: ControlFailure?
    private var lastBlurWarning = Date.distantPast
    public init(onVoice: @escaping VoiceHandler = { _, _ in }, warning: @escaping WarningHandler = { _, _ in }) {
        self.onVoice = onVoice; self.warning = warning
    }

    public func handle(_ request: ControlRequest) async throws -> JSONValue {
        let args = request.args?.object ?? [:]
        switch request.cmd {
        case "teleprompter.get": return try teleprompterState()
        case "teleprompter.set", "teleprompter.start", "teleprompter.stop":
            var config = lock.withLock { teleprompter }
            if request.cmd == "teleprompter.start" { config.enabled = true }
            if request.cmd == "teleprompter.stop" { config.enabled = false }
            if let value = args["enabled"] { guard let enabled = value.bool else { throw ControlFailure(code: "invalid-params") }; config.enabled = enabled }
            if let value = args["script"] { guard let script = value.string else { throw ControlFailure(code: "invalid-params") }; config.script = script }
            if let value = args["locale"] { guard let locale = value.string else { throw ControlFailure(code: "invalid-params") }; config.locale = locale }
            try config.validate()
            lock.withLock { teleprompter = config; voiceGeneration &+= 1; lastVoiceError = nil; lastProgress = nil }
            try await restartVoice()
            return try teleprompterState()
        case "camera.blur.get": return blurState()
        case "camera.blur.set":
            guard let enabled = args["enabled"]?.bool else { throw ControlFailure(code: "invalid-params", message: "Camera blur enabled must be a Boolean.") }
            var config = lock.withLock { cameraBlur }; config.enabled = enabled
            if let value = args["radius"] { guard let radius = value.double else { throw ControlFailure(code: "invalid-params") }; config.radius = radius }
            try configureBlur(config); return blurState()
        default: throw ControlFailure(code: "unknown-command")
        }
    }

    /// No device capture starts here. The already-armed recording supplies its microphone availability.
    public func beginRecording(id: String, microphoneEnabled: Bool, allowAssetDownload: Bool = false) async throws {
        lock.withLock { recordingID = id; self.microphoneEnabled = microphoneEnabled; voiceGeneration &+= 1; lastVoiceError = nil; lastProgress = nil }
        try await restartVoice(allowAssetDownload: allowAssetDownload)
    }
    public func finishRecording() async throws -> TeleprompterProgress? {
        let (old, generation) = lock.withLock { let value = voice; voice = nil; recordingID = nil; microphoneEnabled = false; voiceGeneration &+= 1; return (value, voiceGeneration) }
        guard let old else { return nil }
        let progress = try await old.finish()
        lock.withLock { if voiceGeneration == generation { lastProgress = progress } }; return progress
    }
    public func cancelRecording() async {
        let old = lock.withLock { let value = voice; voice = nil; recordingID = nil; microphoneEnabled = false; voiceGeneration &+= 1; return value }
        await old?.cancel()
    }
    /// TrackWriter calls this only after valid microphone input passed its epoch/pause/mute gate.
    @discardableResult public func acceptMicrophone(_ sampleBuffer: CMSampleBuffer, at mediaTime: CMTime) -> Bool {
        let service = lock.withLock { voice }
        return service?.submit(sampleBuffer, at: mediaTime) ?? false
    }
    public func microphoneObserver() -> @Sendable (CMSampleBuffer, CMTime) -> Void {
        { [weak self] sample, time in _ = self?.acceptMicrophone(sample, at: time) }
    }

    public func configureBlur(_ config: CameraBlurConfiguration) throws {
        try config.validate()
        let processor = config.enabled ? try CameraBackgroundBlur(radius: config.radius) : nil
        let old = lock.withLock { let value = blur; blur = processor; cameraBlur = config; blurGeneration &+= 1; return value }
        old?.cancel()
    }
    public func currentPolicy() -> ProductionEffectsPolicy { lock.withLock { .init(cameraBlur: cameraBlur) } }
    /// Install only when policy.enabled. Called on CameraSource's bounded previewQueue, never its capture callback.
    public func previewTransform() -> @Sendable (CVPixelBuffer) -> CVPixelBuffer? {
        { [weak self] input in self?.transformPreview(input) }
    }
    private func transformPreview(_ input: CVPixelBuffer) -> CVPixelBuffer? {
        let (config, processor, generation) = lock.withLock { (cameraBlur, blur, blurGeneration) }
        guard config.enabled else { return input }
        guard let processor else { return nil }
        let frame = processor.process(input, at: .zero)
        guard lock.withLock({ generation == blurGeneration }), frame.disposition == "processed" || frame.disposition == "no-person" else {
            warnBlur(frame.errorCode ?? "blur-preview-withheld", frame.message ?? "Requested camera blur is unavailable; raw preview was withheld.")
            return nil
        }
        return frame.pixelBuffer
    }
    private func warnBlur(_ code: String, _ message: String) {
        let emit = lock.withLock { if Date().timeIntervalSince(lastBlurWarning) < 1 { return false }; lastBlurWarning = Date(); return true }
        if emit { warning(code, message) }
    }
    private func restartVoice(allowAssetDownload: Bool = false) async throws {
        let (old, config, id, mic, generation) = lock.withLock {
            let old = voice; voice = nil; return (old, teleprompter, recordingID, microphoneEnabled, voiceGeneration)
        }
        await old?.cancel()
        guard config.enabled, let id else { return }
        guard mic else {
            let error = ControlFailure(code: "no-microphone", message: "Voice following needs an enabled recording microphone. No alternate microphone capture was started.")
            lock.withLock { if voiceGeneration == generation { lastVoiceError = error } }; throw error
        }
        do {
            let service = try await VoiceTeleprompter.start(script: config.script, localeIdentifier: config.locale,
                allowAssetDownload: allowAssetDownload) { [weak self] progress in
                guard let self, self.lock.withLock({ self.voiceGeneration == generation && self.recordingID == id }) else { return }
                self.lock.withLock { self.lastProgress = progress }
                self.onVoice(id, progress)
            }
            let current = lock.withLock {
                guard voiceGeneration == generation, recordingID == id, teleprompter.enabled else { return false }
                voice = service; return true
            }
            if !current { await service.cancel() }
        } catch {
            let failure = (error as? ControlFailure) ?? ControlFailure(code: "speech-analysis-failed", message: error.localizedDescription)
            lock.withLock { if voiceGeneration == generation { lastVoiceError = failure } }
            throw failure
        }
    }
    private func teleprompterState() throws -> JSONValue {
        let (config, service, id, progress, error) = lock.withLock { (teleprompter, voice, recordingID, lastProgress, lastVoiceError) }
        var state = try JSONValue(encoding: config).object ?? [:]
        state["recordingId"] = .string(id)
        state["state"] = .string(!config.enabled ? "disabled" : error != nil ? "error" : service?.snapshot().state ?? "armed")
        state["progress"] = try (service?.snapshot() ?? progress).map { try JSONValue(encoding: $0) } ?? .null
        if let error { state["errorCode"] = .string(error.payload.code); state["message"] = .string(error.payload.message) }
        state["capture"] = .string("recording-microphone-tee-only")
        return .object(state)
    }
    private func blurState() -> JSONValue {
        let config = lock.withLock { cameraBlur }
        return .object(["enabled": .bool(config.enabled), "radius": .double(config.radius),
            "affects": .array([.string("preview"), .string("export")]), "preservesRawMasters": .bool(true),
            "requiresDerivedCamera": .bool(config.enabled)])
    }
}
