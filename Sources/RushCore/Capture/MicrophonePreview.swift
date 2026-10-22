import AVFoundation
import CoreMedia
import Foundation

/// In-memory measurements only. No PCM or device audio is retained.
internal struct MicrophoneLevels: Equatable, Sendable {
    var rms: Double
    var peak: Double
    var clipping: Bool
    var frames: Int

    static func measure(_ sample: CMSampleBuffer) -> Self? {
        guard let format = CMSampleBufferGetFormatDescription(sample),
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(format),
              let block = CMSampleBufferGetDataBuffer(sample) else { return nil }
        let pcm = description.pointee, frames = CMSampleBufferGetNumSamples(sample)
        guard pcm.mFormatID == kAudioFormatLinearPCM,
              pcm.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              pcm.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              pcm.mBitsPerChannel == 32, pcm.mSampleRate.isFinite, pcm.mSampleRate > 0,
              frames > 0, pcm.mChannelsPerFrame > 0, pcm.mChannelsPerFrame <= 64 else { return nil }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length <= 4_194_304,
              length == frames * Int(pcm.mChannelsPerFrame) * 4 else { return nil }
        var values = [Float](repeating: 0, count: length / 4)
        let copied = values.withUnsafeMutableBytes {
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
        }
        guard copied == noErr else { return nil }
        var energy = 0.0, peak = 0.0
        for value in values {
            guard value.isFinite else { return nil }
            let magnitude = abs(Double(value))
            peak = max(peak, magnitude); energy += magnitude * magnitude
        }
        let rms = sqrt(energy / Double(values.count))
        guard rms.isFinite, peak.isFinite else { return nil }
        return .init(rms: rms, peak: peak, clipping: peak >= 1, frames: frames)
    }
}

internal protocol MicrophonePreviewing: Sendable {
    func start(deviceID: String, receive: @escaping @Sendable (MicrophoneLevels?) -> Void) async throws
    /// Returns only after session stop and callback queue drain.
    func stop() async
}

internal enum NativeMicrophoneSelection {
    struct Device: Equatable, Sendable { var uniqueID: String; var name: String }
    static func index(for id: String, in devices: [Device]) -> Int? {
        var names: [String: Int] = [:]
        for (index, device) in devices.enumerated() {
            let position = names[device.name, default: 0]
            names[device.name] = position + 1
            if SourceIds.device(uniqueID: device.uniqueID, modelName: device.name, position: position) == id
                || (!device.uniqueID.isEmpty && device.uniqueID == id) { return index }
        }
        return nil
    }
}

internal final class NativeMicrophonePreview: NSObject, MicrophonePreviewing,
    AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "rushes.preflight.microphone.session")
    private let samples = DispatchQueue(label: "rushes.preflight.microphone.samples")
    // Confined to samples.
    private var receive: (@Sendable (MicrophoneLevels?) -> Void)?
    private var lastEmission: UInt64 = 0
    private var energy = 0.0, peak = 0.0
    private var frames = 0
    private var invalid = false, clipped = false

    func start(deviceID: String, receive: @escaping @Sendable (MicrophoneLevels?) -> Void) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sessionQueue.async { [self] in
                do {
                    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external],
                        mediaType: .audio, position: .unspecified).devices
                    guard let index = NativeMicrophoneSelection.index(for: deviceID, in: devices.map {
                        .init(uniqueID: $0.uniqueID, name: $0.localizedName)
                    }) else { throw ControlFailure(code: "microphone-not-found", message: "The selected microphone disconnected.") }
                    let input = try AVCaptureDeviceInput(device: devices[index])
                    let output = AVCaptureAudioDataOutput()
                    output.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM,
                        AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
                        AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
                    session.beginConfiguration()
                    guard session.canAddInput(input), session.canAddOutput(output) else {
                        session.commitConfiguration()
                        throw ControlFailure(code: "microphone-unavailable", message: "The selected microphone could not attach.")
                    }
                    session.addInput(input); session.addOutput(output)
                    output.setSampleBufferDelegate(self, queue: samples)
                    session.commitConfiguration()
                    samples.sync { self.receive = receive }
                    session.startRunning()
                    guard session.isRunning else {
                        throw ControlFailure(code: "microphone-unavailable", message: "The selected microphone could not start.")
                    }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            sessionQueue.async { [self] in
                session.stopRunning()
                samples.sync { receive = nil; energy = 0; peak = 0; frames = 0 }
                continuation.resume()
            }
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let receive else { return }
        if let level = MicrophoneLevels.measure(sample) {
            energy += level.rms * level.rms * Double(level.frames)
            frames += level.frames; peak = max(peak, level.peak); clipped = clipped || level.clipping
        } else { invalid = true }
        let now = DispatchTime.now().uptimeNanoseconds
        guard now - lastEmission >= 100_000_000 else { return }
        let value: MicrophoneLevels? = !invalid && frames > 0
            ? .init(rms: sqrt(energy / Double(frames)), peak: peak, clipping: clipped, frames: frames) : nil
        lastEmission = now; energy = 0; peak = 0; frames = 0; invalid = false; clipped = false
        receive(value)
    }
}
