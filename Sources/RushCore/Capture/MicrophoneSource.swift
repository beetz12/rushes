import AVFoundation
import CoreMedia
import Foundation

/// Camera-only / microphone-only recording has no screen stream. Its audio
/// source uses one native capture session, converting timestamps to host time.
public final class MicrophoneSource: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "rush.microphone.session")
    private let frames = DispatchQueue(label: "rush.microphone.frames")
    private let writer: TrackWriter
    private var converter: SessionClockConverter?

    public init(writer: TrackWriter) { self.writer = writer }

    public func start(deviceID: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            queue.async { [self] in
                do {
                    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
                    guard let device = devices.first(where: { SourceIds.device(uniqueID: $0.uniqueID, modelName: $0.localizedName) == deviceID || $0.uniqueID == deviceID }) else {
                        throw ControlFailure(code: "microphone-not-found", message: "microphone no longer exists")
                    }
                    session.beginConfiguration()
                    let input = try AVCaptureDeviceInput(device: device)
                    let output = AVCaptureAudioDataOutput()
                    guard session.canAddInput(input), session.canAddOutput(output) else {
                        session.commitConfiguration()
                        throw ControlFailure(code: "microphone-unavailable", message: "microphone could not attach")
                    }
                    session.addInput(input)
                    session.addOutput(output)
                    output.setSampleBufferDelegate(self, queue: frames)
                    session.commitConfiguration()
                    session.startRunning()
                    let clock = SessionClockConverter(session: session)
                    frames.sync { converter = clock }
                    continuation.resume()
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    public func stop() async {
        await withCheckedContinuation { continuation in
            queue.async { [self] in session.stopRunning(); continuation.resume() }
        }
        frames.sync {}
    }

    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let original = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let hostTime = converter?.hostTime(fromSessionTime: original) ?? original
        if let sample = AudioSampleTiming.retime(sampleBuffer, to: hostTime) { writer.appendAudio(sample) }
    }
}
