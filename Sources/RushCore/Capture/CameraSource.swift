import AVFoundation
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Dispatch
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Pure decision types

/// One capture format the device offers, as plain values (so the choice is
/// unit-testable without a camera).
public struct CameraFormatOption: Equatable, Sendable {
    public let width: Int
    public let height: Int
    /// Whether the format's supported frame-rate ranges include 30 fps.
    public let supports30fps: Bool
    /// The format's position in the device's format list; the live path uses
    /// it to apply `device.formats[index]`.
    public let index: Int

    public init(width: Int, height: Int, supports30fps: Bool, index: Int) {
        self.width = width
        self.height = height
        self.supports30fps = supports30fps
        self.index = index
    }
}

/// The camera format rule (docs/PLAN.md, capture-camera): "HEVC, 1920x1080
/// at 30 fps when the device offers it, else 1280x720 at 30 fps".
public enum CameraFormatChoice {

    /// Picks the output format: the first 1920x1080 option that supports
    /// 30 fps, else the first 1280x720 at 30 fps, else the first option at
    /// 30 fps of any size, else nil (the device offers nothing usable).
    public static func choose(from options: [CameraFormatOption]) -> CameraFormatOption? {
        let at30 = options.filter(\.supports30fps)
        return at30.first { $0.width == 1920 && $0.height == 1080 }
            ?? at30.first { $0.width == 1280 && $0.height == 720 }
            ?? at30.first
    }
}

/// Keep device-native formats out of the eight-bit movie encoder input.
/// Availability depends on the attached device's current active format.
internal enum CameraPixelFormatChoice {
    static func choose(from available: [OSType]) -> OSType? {
        let preferences: [OSType] = [
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
            kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
            kCVPixelFormatType_32BGRA,
        ]
        return preferences.first { available.contains($0) }
    }
}

/// A camera's stable identity, for reconnection matching (docs/PLAN.md,
/// capture-camera: "a reconnected camera is found again by its unique id or
/// model id").
public struct CameraDeviceIdentity: Equatable, Sendable {
    public let uniqueID: String
    public let modelID: String?
    public let localizedName: String

    public init(uniqueID: String, modelID: String?, localizedName: String) {
        self.uniqueID = uniqueID
        self.modelID = modelID
        self.localizedName = localizedName
    }
}

/// What to do about the camera after a device change mid-take.
public enum CameraReconnectionDecision: Equatable, Sendable {
    /// The lost camera (or its same-model sibling) is back; reconfigure for
    /// this device.
    case reconnect(CameraDeviceIdentity)
    /// Still gone. Losing the camera is a warning, not a failure
    /// (docs/PLAN.md, Camera loss: the recording continues).
    case keepWaiting
}

/// Reconnection matching: unique id first, then model id (two identical
/// cameras share a model id; the unique id is exact).
public enum CameraReconnection {

    public static func decide(
        lost: CameraDeviceIdentity, available: [CameraDeviceIdentity]
    ) -> CameraReconnectionDecision {
        if available.contains(where: { $0.uniqueID == lost.uniqueID }) {
            return .reconnect(lost)
        }
        if let modelID = lost.modelID,
           let sameModel = available.first(where: { $0.modelID == modelID }) {
            return .reconnect(sameModel)
        }
        return .keepWaiting
    }
}

/// Preview-frame throttling for the bubble's engine-published JPEGs
/// (docs/PLAN.md, Live UI kept out of the footage: small JPEG images, about
/// 512 px wide, at up to 30 per second, from the same session that writes
/// camera.mov - the renderer never opens the camera).
public struct PreviewThrottle: Sendable {

    /// Minimum interval between emitted frames, in nanoseconds.
    public let minimumIntervalNs: Int64
    /// Preview JPEGs are scaled to about this width.
    public let targetWidth: Int

    private var lastEmitNs: Int64? = nil

    /// - Parameters:
    ///   - framesPerSecond: at most this many preview frames per second.
    ///   - targetWidth: preview JPEGs are scaled to about this width.
    public init(framesPerSecond: Int = 30, targetWidth: Int = 512) {
        self.minimumIntervalNs = 1_000_000_000 / Int64(max(1, framesPerSecond))
        self.targetWidth = targetWidth
    }

    /// Whether a frame arriving at `hostNs` should be encoded and published.
    /// Mutation is caller-confined; `CameraSource` guards it with its lock.
    public mutating func shouldEmit(atHostNs hostNs: Int64) -> Bool {
        if let last = lastEmitNs, hostNs - last < minimumIntervalNs {
            return false
        }
        lastEmitNs = hostNs
        return true
    }

    /// The preview pixel width for a source frame: the source width capped at
    /// the target, kept even (encoders and scalers want even numbers).
    public func previewWidth(forSourceWidth sourceWidth: Int) -> Int {
        evenFloor(min(sourceWidth, targetWidth))
    }
}

// MARK: - Test seams over AVFoundation

/// The `AVCaptureSession` surface `CameraSource` drives. Fakes record calls;
/// the real conformer owns the session.
internal protocol CameraSessionDriving: AnyObject {
    func beginConfiguration()
    func commitConfiguration()
    var inputs: [AVCaptureInput] { get }
    func canAddInput(_ input: AVCaptureInput) -> Bool
    func addInput(_ input: AVCaptureInput)
    func removeInput(_ input: AVCaptureInput)
    func canAddOutput(_ output: AVCaptureOutput) -> Bool
    func addOutput(_ output: AVCaptureOutput)
    func startRunning()
    func stopRunning()
    /// Converts a sample timestamp from the session's synchronization clock
    /// to the host clock (docs/PLAN.md, Clock: camera timestamps are
    /// converted explicitly; normally the two are identical).
    func hostTime(fromSessionTime time: CMTime) -> CMTime

    /// The boxed converter for the frame path (nil when the fake session has
    /// no clock; timestamps then pass through unchanged).
    func makeClockConverter() -> SessionClockConverter?
}

extension AVCaptureSession: CameraSessionDriving {
    func hostTime(fromSessionTime time: CMTime) -> CMTime {
        guard let clock = synchronizationClock else { return time }
        return CMSyncConvertTime(time, from: clock, to: CMClockGetHostTimeClock())
    }

    func makeClockConverter() -> SessionClockConverter? {
        SessionClockConverter(session: self)
    }
}

/// Wraps one session's clock conversion in a `Sendable` box:
/// `AVCaptureSession` itself is not `Sendable`, but `CMSyncConvertTime`
/// against its synchronization clock is safe from any thread, and the camera
/// frame path needs the conversion off the session queue.
final class SessionClockConverter: @unchecked Sendable {
    private let clock: CMClock?

    init(session: AVCaptureSession) {
        // The clock is a strong CF reference; the box owns it.
        self.clock = session.synchronizationClock
    }

    func hostTime(fromSessionTime time: CMTime) -> CMTime {
        guard let clock else { return time }
        return CMSyncConvertTime(time, from: clock, to: CMClockGetHostTimeClock())
    }
}

/// Supplies cameras without `CameraSource` knowing AVFoundation discovery.
internal protocol CameraDeviceProviding: Sendable {
    func devices() -> [AVCaptureDevice]
}

internal struct SystemCameraDeviceProvider: CameraDeviceProviding {
    func devices() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        ).devices
    }
}

/// Builds `AVCaptureDeviceInput`s; a seam because the initializer throws and
/// tests need the failure path.
internal protocol CameraInputMaking: Sendable {
    func makeInput(device: AVCaptureDevice) throws -> AVCaptureInput
}

internal struct SystemCameraInputMaker: CameraInputMaking {
    func makeInput(device: AVCaptureDevice) throws -> AVCaptureInput {
        try AVCaptureDeviceInput(device: device)
    }
}

/// Encodes preview JPEGs. A seam so the throttle and tee are testable without
/// exercising Core Image; the default encoder is the production one.
internal protocol PreviewFrameEncoding: Sendable {
    /// JPEG bytes for the frame scaled to about `targetWidth`, or nil.
    func encode(_ pixelBuffer: CVPixelBuffer, targetWidth: Int) -> Data?
}

/// Production encoder: Core Image scale plus ImageIO JPEG.
internal struct JPEGPreviewEncoder: PreviewFrameEncoding {
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

    func encode(_ pixelBuffer: CVPixelBuffer, targetWidth: Int) -> Data? {
        let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
        guard sourceWidth > 0, sourceHeight > 0 else { return nil }
        var image = CIImage(cvPixelBuffer: pixelBuffer)
        let capped = max(2, targetWidth)
        if sourceWidth > capped {
            let scale = Double(capped) / Double(sourceWidth)
            image = image.transformed(
                by: CGAffineTransform(scaleX: scale, y: scale))
        }
        guard let cgImage = ciContext.createCGImage(image, from: image.extent) else {
            return nil
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        CGImageDestinationAddImage(destination, cgImage, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}

// MARK: - Camera source

/// The camera capture path: one `AVCaptureSession` that is warmed up when the
/// camera is selected, reused to write `camera.mov`, and teed for the bubble
/// preview (docs/PLAN.md, capture-camera and Live UI kept out of the
/// footage).
///
/// There is exactly one session per selected camera and no second capture
/// session anywhere: the preview JPEGs come from the same
/// `AVCaptureVideoDataOutput` that feeds the writer, so warm-up and recording
/// share exposure state and single-client virtual cameras are never
/// contended.
///
/// Camera loss mid-take is a warning, not a failure: `onCameraLost` fires
/// and the recording itself is the session layer's business.
public final class CameraSource: @unchecked Sendable {

    private let devices: any CameraDeviceProviding
    private let makeInput: any CameraInputMaking
    private let session: any CameraSessionDriving
    private let previewEncoder: any PreviewFrameEncoding
    private let makeVideoOutput: @Sendable () -> AVCaptureVideoDataOutput
    private var onCameraLost: @Sendable (String) -> Void

    /// Session mutation queue: every AVCaptureSession change happens here.
    private let sessionQueue = DispatchQueue(label: "rush.rushcore.camera.session", qos: .userInitiated)
    /// Frame queue: the sample-buffer delegate runs here; CMSampleBuffer
    /// never leaves it.
    private let frameQueue = DispatchQueue(label: "rush.rushcore.camera.frames", qos: .userInitiated)
    private let lock = NSLock()
    private let previewQueue = DispatchQueue(label: "rush.camera.preview")
    private var previewBusy = false
    private var receivedFrame = false
    private var observer: NSObjectProtocol?
    private var previewSink: (@Sendable (Data) -> Void)?
    private var previewTransform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?
    private var previewTransformGeneration: UInt64 = 0

    // Lock-confined (both queues and callers touch these).
    private var throttle = PreviewThrottle()
    private var attachedWriter: TrackWriter?
    private var running = false

    // Session-queue-confined.
    private var videoOutput: AVCaptureVideoDataOutput?
    private var activeDevice: AVCaptureDevice?
    private var activeIdentity: CameraDeviceIdentity?
    private var forwarder: CameraFrameForwarder?

    /// Where preview JPEGs are published. The engine connects this to the
    /// control socket; tests collect frames here. Called on the frame queue.
    public var previewHandler: (@Sendable (Data) -> Void)? {
        get { lock.withLock { previewSink } }
        set { lock.withLock { previewSink = newValue } }
    }

    /// Optional privacy transform applied only on the bounded preview queue. nil output suppresses the frame.
    public func setPreviewTransform(_ transform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?) {
        lock.withLock { previewTransform = transform; previewTransformGeneration &+= 1 }
    }

    /// Public entry point with the production seams.
    public convenience init(onCameraLost: @escaping @Sendable (String) -> Void) {
        self.init(
            devices: SystemCameraDeviceProvider(),
            makeInput: SystemCameraInputMaker(),
            session: AVCaptureSession(),
            previewEncoder: JPEGPreviewEncoder(),
            onCameraLost: onCameraLost)
    }

    /// Designated init with injectable seams (tests).
    internal init(
        devices: any CameraDeviceProviding,
        makeInput: any CameraInputMaking,
        session: any CameraSessionDriving,
        previewEncoder: any PreviewFrameEncoding,
        makeVideoOutput: @escaping @Sendable () -> AVCaptureVideoDataOutput = {
            let output = AVCaptureVideoDataOutput()
            // The writer queue is the pacing authority; late preview frames
            // are the cheapest to drop.
            output.alwaysDiscardsLateVideoFrames = true
            return output
        },
        onCameraLost: @escaping @Sendable (String) -> Void
    ) {
        self.devices = devices
        self.makeInput = makeInput
        self.session = session
        self.previewEncoder = previewEncoder
        self.makeVideoOutput = makeVideoOutput
        self.onCameraLost = onCameraLost
        observer = NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification,
                                                         object: nil, queue: nil) { [weak self] note in
            guard let device = note.object as? AVCaptureDevice else { return }
            self?.deviceDisconnected(id: device.uniqueID)
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    private func deviceDisconnected(id: String) {
        sessionQueue.async { [self] in
            guard activeIdentity?.uniqueID == id else { return }
            lock.withLock { running = false }
            detachWriter()
            let handler = lock.withLock { onCameraLost }
            handler(activeIdentity?.localizedName ?? id)
        }
    }

    /// Warms the camera: resolves the device, picks the format, pins the
    /// frame duration, builds the input and video output on the one session,
    /// and starts it. Called the moment the camera is selected, well before
    /// Record, so the first recorded frame is already well exposed and the
    /// preview is live.
    ///
    /// - Parameter deviceID: the chosen camera's catalog id
    ///   (`SourceIds.device`); nil warms the first discovered camera.
    /// - Returns: the warmed camera's identity, or a failure message when no
    ///   camera can be warmed (a missing optional input switches off and the
    ///   recording still starts).
    @discardableResult
    public func warmUp(deviceID: String?) async -> (identity: CameraDeviceIdentity?, failure: String?) {
        let configured = await withCheckedContinuation { (continuation: CheckedContinuation<
            (identity: CameraDeviceIdentity?, failure: String?), Never
        >) in
            sessionQueue.async { [self] in
                let outcome = configureAndStart(deviceID: deviceID)
                continuation.resume(returning: outcome)
            }
        }
        guard configured.identity != nil else { return configured }
        let deadline = DispatchTime.now().uptimeNanoseconds + 3_000_000_000
        while !lock.withLock({ receivedFrame }), DispatchTime.now().uptimeNanoseconds < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
        guard lock.withLock({ receivedFrame }) else {
            stop()
            return (nil, "camera did not deliver a frame within three seconds")
        }
        return configured
    }

    /// Session-queue-confined warm-up body.
    private func configureAndStart(
        deviceID: String?
    ) -> (identity: CameraDeviceIdentity?, failure: String?) {
        let discovered = devices.devices()
        let device: AVCaptureDevice?
        if let deviceID {
            device = discovered.first {
                SourceIds.device(uniqueID: $0.uniqueID, modelName: $0.localizedName) == deviceID
            } ?? discovered.first { $0.uniqueID == deviceID }
        } else {
            device = discovered.first
        }
        guard let device else {
            return (nil, "no camera available")
        }
        let identity = CameraDeviceIdentity(
            uniqueID: device.uniqueID,
            modelID: device.modelID,
            localizedName: device.localizedName)

        Self.applyFormatChoice(to: device)

        session.beginConfiguration()
        var configured = false
        if let input = try? makeInput.makeInput(device: device),
           session.canAddInput(input) {
            session.addInput(input)
            configured = true
        }
        if !configured {
            session.commitConfiguration()
            return (nil, "camera input could not be configured")
        }
        let output = makeVideoOutput()
        guard session.canAddOutput(output) else {
            session.commitConfiguration()
            return (nil, "camera video output could not be configured")
        }
        session.addOutput(output)
        session.commitConfiguration()
        // Empty videoSettings asks for the device's native format, which can
        // differ from the eight-bit pixel formats accepted by our movie path.
        // Query after attaching the output because availability follows the
        // connected device's active format (AVCaptureVideoDataOutput.h).
        guard let pixelFormat = CameraPixelFormatChoice.choose(
            from: output.availableVideoPixelFormatTypes) else {
            return (nil, "camera offers no supported eight-bit video output")
        }
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: pixelFormat]
        Self.pinFrameDuration(to: device)
        let forwarder = CameraFrameForwarder(owner: self, converter: nil)
        output.setSampleBufferDelegate(forwarder, queue: frameQueue)
        session.startRunning()
        let converter = session.makeClockConverter()
        frameQueue.sync { forwarder.setConverter(converter) }

        self.videoOutput = output
        self.activeDevice = device
        self.activeIdentity = identity
        self.forwarder = forwarder
        lock.lock()
        running = true
        lock.unlock()
        return (identity, nil)
    }

    /// Applies the plan's format choice (1080p30, else 720p30) to a device.
    static func applyFormatChoice(to device: AVCaptureDevice) {
        let options = device.formats.enumerated().map { index, format in
            CameraFormatOption(
                width: Self.formatWidth(format),
                height: Self.formatHeight(format),
                supports30fps: format.videoSupportedFrameRateRanges.contains {
                    $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
                },
                index: index)
        }
        guard let chosen = CameraFormatChoice.choose(from: options),
              chosen.index < device.formats.count else { return }
        do {
            try device.lockForConfiguration()
            defer { device.unlockForConfiguration() }
            device.activeFormat = device.formats[chosen.index]
        } catch {
            // A busy device keeps its current format; capture can continue.
        }
    }

    /// Pins the device to the chosen rate (docs/PLAN.md, capture-camera:
    /// frame duration pinned to the chosen rate). The device property is the
    /// live one; the connection-level property is deprecated on this SDK.
    static func pinFrameDuration(to device: AVCaptureDevice) {
        let duration = CMTime(value: 1, timescale: 30)
        do {
            try device.lockForConfiguration()
            if device.activeFormat.videoSupportedFrameRateRanges.contains(where: {
                $0.minFrameRate <= 30 && $0.maxFrameRate >= 30
            }) {
                device.activeVideoMinFrameDuration = duration
                device.activeVideoMaxFrameDuration = duration
            }
            device.unlockForConfiguration()
        } catch {
            // An unpinned duration is a quality nuisance, not a refused take.
        }
    }

    /// Points the warmed session's frames at the take's camera writer. The
    /// session keeps running; recording reuses the warmed pipeline.
    public func attach(writer: TrackWriter) {
        lock.lock()
        attachedWriter = writer
        lock.unlock()
    }

    public func setLossHandler(_ handler: @escaping @Sendable (String) -> Void) {
        lock.withLock { onCameraLost = handler }
    }

    public func detachWriter() {
        lock.withLock { attachedWriter = nil }
    }

    /// Detaches the writer and stops the session (Stop, or a camera that was
    /// selected but never recorded).
    public func stop() {
        sessionQueue.async { [self] in
            lock.lock()
            attachedWriter = nil
            let wasRunning = running
            running = false
            lock.unlock()
            if wasRunning {
                session.stopRunning()
            }
        }
    }

    /// Waits for the native session mutation queue to finish stopping. Used
    /// for explicit close so an acknowledgement means capture has stopped.
    public func stopAndWait() async {
        stop()
        await withCheckedContinuation { continuation in
            sessionQueue.async { continuation.resume() }
        }
        frameQueue.sync {}
    }

    /// The warmed camera's identity, if any.
    public var identity: CameraDeviceIdentity? {
        sessionQueue.sync { activeIdentity }
    }

    /// Whether the warmed session is running.
    public var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return running
    }

    /// Reports the loss of the active camera: a warning, not a failure. The
    /// recording continues; `camera.mov` simply ends at that time.
    public func noteDeviceLost() {
        if let identity = identity {
            detachWriter()
            let handler = lock.withLock { onCameraLost }
            handler(identity.localizedName)
        }
    }

    /// Feeds a device change into the reconnection decision. A camera that is
    /// back (unique id, else model id) rebinds the same session and restarts
    /// it; a camera still gone changes nothing - the loss was already a
    /// warning (docs/PLAN.md, Camera loss).
    public func handleDeviceReconnected(
        lost: CameraDeviceIdentity, nowAvailable: [CameraDeviceIdentity]
    ) {
        guard case .reconnect(let replacement) = CameraReconnection.decide(
            lost: lost, available: nowAvailable
        ) else {
            return
        }
        sessionQueue.async { [self] in
            let discovered = devices.devices()
            let device = discovered.first { $0.uniqueID == replacement.uniqueID }
                ?? discovered.first { $0.modelID == replacement.modelID }
            guard let device else { return }
            session.beginConfiguration()
            for input in session.inputs {
                session.removeInput(input)
            }
            if let input = try? makeInput.makeInput(device: device),
               session.canAddInput(input) {
                session.addInput(input)
            }
            session.commitConfiguration()
            lock.lock()
            let wasRunning = running
            lock.unlock()
            if !wasRunning {
                session.startRunning()
                lock.lock()
                running = true
                lock.unlock()
            }
            activeDevice = device
            activeIdentity = replacement
        }
    }

    /// One camera frame, on the frame queue (or a test thread): host-clock
    /// conversion, writer append, throttled preview tee. CMSampleBuffer stays
    /// on the calling thread; only preview `Data` crosses out.
    func acceptFrame(
        _ sampleBuffer: CMSampleBuffer,
        sessionTimeConversion: ((CMTime) -> CMTime)? = nil
    ) {
        // Camera timestamps live on the session's synchronization clock; the
        // writers take host time (docs/PLAN.md, Clock).
        let original = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let converted = sessionTimeConversion?(original) ?? original
        var forwarded = sampleBuffer
        if let retimed = AudioSampleTiming.retime(sampleBuffer, to: converted) {
            forwarded = retimed
        }
        lock.lock()
        let writer = attachedWriter
        receivedFrame = true
        lock.unlock()
        writer?.appendVideo(forwarded)

        guard let handler = previewHandler,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let hostNs = converted.nanosecondsI64 ?? 0
        lock.lock()
        let shouldEmit = throttle.shouldEmit(atHostNs: hostNs)
        let target = throttle.previewWidth(
            forSourceWidth: CVPixelBufferGetWidth(pixelBuffer))
        lock.unlock()
        guard shouldEmit else { return }
        let accepted = lock.withLock {
            if previewBusy { return false }
            previewBusy = true
            return true
        }
        guard accepted else { return }
        let frame = PreviewPixelBuffer(pixelBuffer)
        previewQueue.async { [self, frame] in
            defer { lock.withLock { previewBusy = false } }
            let (transform, generation) = lock.withLock { (previewTransform, previewTransformGeneration) }
            let processed: CVPixelBuffer
            if let transform {
                guard let output = transform(frame.value) else { return }
                processed = output
            } else { processed = frame.value }
            guard lock.withLock({ generation == previewTransformGeneration }) else { return }
            if let jpeg = previewEncoder.encode(processed, targetWidth: target),
               lock.withLock({ generation == previewTransformGeneration }) { handler(jpeg) }
        }
    }

    internal func waitForPreview() { previewQueue.sync {} }

    private static func formatWidth(_ format: AVCaptureDevice.Format) -> Int {
        Int(CMVideoFormatDescriptionGetDimensions(format.formatDescription).width)
    }

    private static func formatHeight(_ format: AVCaptureDevice.Format) -> Int {
        Int(CMVideoFormatDescriptionGetDimensions(format.formatDescription).height)
    }
}

/// The video output delegate: hands each frame to the source on the frame
/// queue, converting its timestamp onto the host clock on the way in. The
/// delegate object exists only to satisfy the AVFoundation protocol; all
/// logic lives in `CameraSource.acceptFrame`.
internal final class CameraFrameForwarder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {

    private weak var owner: CameraSource?
    private var converter: SessionClockConverter?

    init(owner: CameraSource, converter: SessionClockConverter?) {
        self.owner = owner
        self.converter = converter
    }

    func setConverter(_ converter: SessionClockConverter?) { self.converter = converter }

    func captureOutput(
        _ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection
    ) {
        guard let owner else { return }
        guard let converter else {
            // No live clock (fake session): timestamps pass through.
            owner.acceptFrame(sampleBuffer)
            return
        }
        owner.acceptFrame(sampleBuffer) { time in
            converter.hostTime(fromSessionTime: time)
        }
    }
}

private final class PreviewPixelBuffer: @unchecked Sendable {
    let value: CVPixelBuffer
    init(_ value: CVPixelBuffer) { self.value = value }
}
