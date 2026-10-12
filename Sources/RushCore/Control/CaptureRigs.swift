import AppKit
import AVFoundation
import CoreGraphics
import CoreMedia
import CoreVideo
import Dispatch
import Foundation

// MARK: - The seam

/// Everything one take's capture is attached to. Built by the
/// `EngineController` after the session is armed (writers exist behind the
/// gate) and before the gate opens.
public struct CaptureContext: Sendable {

    /// The armed session. Writers are grabbed once through
    /// `trackWriter(for:)`; appends never hop into the actor.
    public let session: RecordingSession

    public let request: SessionRequest

    public let package: RecordingPackage

    /// A capture-level warning (camera-lost, mic-silent...): records into
    /// the manifest and surfaces as a `warning` event.
    public let warning: @Sendable (String, String?) -> Void

    /// The screen stream died (display change, sleep, permission revoked):
    /// the controller stops the take early and keeps the footage.
    public let streamFailure: @Sendable (String) -> Void

    /// Selftest mode (`selftest sync`): the stream includes the engine's own
    /// flash window and our own tone in system audio, which normal
    /// recordings exclude (docs/PLAN.md, Roadmap Phase 1 item 9).
    public let selftest: Bool
    public let shellBundleID: String?
    public let preview: @Sendable (Data) -> Void
    /// Receives microphone PCM on the writer's media timeline, after gate,
    /// pause and mute handling. Consumers must enqueue bounded work and return.
    public let microphoneObserver: @Sendable (CMSampleBuffer, CMTime) -> Void

    public init(
        session: RecordingSession,
        request: SessionRequest,
        package: RecordingPackage,
        selftest: Bool = false,
        shellBundleID: String? = nil,
        preview: @escaping @Sendable (Data) -> Void = { _ in },
        microphoneObserver: @escaping @Sendable (CMSampleBuffer, CMTime) -> Void = { _, _ in },
        warning: @escaping @Sendable (String, String?) -> Void,
        streamFailure: @escaping @Sendable (String) -> Void
    ) {
        self.session = session
        self.request = request
        self.package = package
        self.selftest = selftest
        self.shellBundleID = shellBundleID
        self.preview = preview
        self.microphoneObserver = microphoneObserver
        self.warning = warning
        self.streamFailure = streamFailure
    }
}

/// One take's live capture: started behind the gate, stopped before the
/// writers finalize.
public protocol CaptureRig: Sendable {
    /// The gate opened at `epochHostNs` (media time zero). The input
    /// recorder starts here, once the clock's epoch exists.
    func gateOpened(epochHostNs: Int64) async

    /// Stops all capture. Idempotent; called before `RecordingSession.stop`
    /// so no sample races a finalizing writer.
    func stop() async
    func adoptClock(_ clock: SessionClock) async
    func setDrawingWindow(windowID: String?) async throws
    func captureGeometry() async -> CaptureGeometry?
}

/// Builds the capture for one armed session. The production factory wires
/// `ScreenSource`, `CameraSource` and `InputRecorder`; tests (and the
/// engine's diagnostic mode) inject the stub factory.
public protocol CaptureRigFactory: Sendable {
    func attach(_ context: CaptureContext) async throws -> CaptureRig
    func warmCamera(cameraID: String?, preview: @escaping @Sendable (Data) -> Void,
                    warning: @escaping @Sendable (String, String?) -> Void) async throws -> JSONValue
    func stopPreview() async
    func setCameraPreviewTransform(_ transform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?) async
}

extension CaptureRig {
    public func adoptClock(_ clock: SessionClock) async {}
    public func setDrawingWindow(windowID: String?) async throws {}
    public func captureGeometry() async -> CaptureGeometry? { nil }
}

extension CaptureRigFactory {
    public func warmCamera(cameraID: String?, preview: @escaping @Sendable (Data) -> Void,
                           warning: @escaping @Sendable (String, String?) -> Void) async throws -> JSONValue {
        .object(["running": .bool(true), "camera": .string(cameraID), "capture": .string("stub")])
    }
    public func stopPreview() async {}
    public func setCameraPreviewTransform(_ transform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?) async {}
}

// MARK: - Production rig

/// The production capture rig (docs/PLAN.md, Sources per capture mode):
/// one ScreenCaptureKit stream with three outputs feeding the screen,
/// microphone and system-audio writers; one AVCaptureSession camera
/// feeding the camera writer; the listen-only input tap appending to
/// `input.ndjson`.
public struct ProductionCaptureRigFactory: CaptureRigFactory {

    private let cameras = CameraCoordinator()
    public init() {}

    public func warmCamera(cameraID: String?, preview: @escaping @Sendable (Data) -> Void,
                           warning: @escaping @Sendable (String, String?) -> Void) async throws -> JSONValue {
        let source = try await cameras.warm(cameraID: cameraID, preview: preview, warning: warning)
        return .object(["running": .bool(source.isRunning), "camera": .string(cameraID),
                        "name": .string(source.identity?.localizedName)])
    }

    public func stopPreview() async { await cameras.stop() }
    public func setCameraPreviewTransform(_ transform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?) async {
        await cameras.setPreviewTransform(transform)
    }

    public func attach(_ context: CaptureContext) async throws -> CaptureRig {
        let request = context.request
        var writers: [TrackKind: TrackWriter] = [:]
        for kind in request.trackKinds {
            if let writer = await context.session.trackWriter(for: kind) {
                if kind == .microphone { writer.setMicrophoneObserver(context.microphoneObserver) }
                writers[kind] = writer
            }
        }

        // Screen stream: display or window, system audio and microphone as
        // the stream's second and third outputs. The plan's output size
        // already lives in the request (the same number the writer uses).
        var screenSource: ScreenSource?
        if let screen = request.screen {
            let dimensions = request.screenDimensions
                ?? SessionRequest.Dimensions(width: 1920, height: 1080)
            let plan = ScreenStreamPlan(
                width: dimensions.width,
                height: dimensions.height,
                showsCursor: request.cursor != "data",
                capturesSystemAudio: request.systemAudio,
                excludesOwnProcessAudio: !context.selftest,
                capturesMicrophone: request.microphoneId != nil,
                microphoneDeviceID: Self.microphoneDeviceUniqueID(
                    for: request.microphoneId))
            let source = ScreenSource(
                plan: plan,
                onStreamFailure: { reason in context.streamFailure(reason) })
            var sinkWriters: [TrackKind: TrackWriter] = [:]
            if let writer = writers[.screen] { sinkWriters[.screen] = writer }
            if let writer = writers[.microphone] { sinkWriters[.microphone] = writer }
            if let writer = writers[.systemAudio] { sinkWriters[.systemAudio] = writer }
            source.setWriters(sinkWriters)
            try await source.start(
                surface: Self.surface(for: screen),
                exclusion: ScreenExclusionList(
                    shellBundleID: context.shellBundleID,
                    engineBundleID: Bundle.main.bundleIdentifier),
                selftest: context.selftest)
            screenSource = source
        }

        // Camera: warmed on attach, then pointed at the camera writer. A
        // camera that cannot warm is a warning, not a failed take
        // (docs/PLAN.md, Camera loss).
        var cameraSource: CameraSource?
        if let cameraId = request.cameraId {
            do {
                let source = try await cameras.warm(cameraID: cameraId, preview: context.preview, warning: context.warning)
                if let writer = writers[.camera] { source.attach(writer: writer) }
                cameraSource = source
            } catch {
                context.warning("camera-warmup-failed", String(describing: error))
            }
        }

        var microphoneSource: MicrophoneSource?
        if request.screen == nil, let microphoneID = request.microphoneId, let writer = writers[.microphone] {
            let source = MicrophoneSource(writer: writer)
            try await source.start(deviceID: microphoneID)
            microphoneSource = source
        }

        return ProductionCaptureRig(
            request: request,
            package: context.package,
            warning: context.warning,
            screenSource: screenSource,
            cameraSource: cameraSource,
            microphoneSource: microphoneSource)
    }

    /// Maps the request's screen target onto the capture surface.
    private static func surface(
        for target: SessionRequest.ScreenTarget
    ) -> ScreenSurface {
        switch target {
        case .display(let id): return .display(id: id)
        case .window(let id): return .window(id: id)
        case .area(let id, let r): return .area(displayID: id, rect: r.cgRect)
        }
    }

    /// The AVCaptureDevice uniqueID for a catalog microphone id, or nil
    /// (the system default) when it cannot be resolved. ScreenCaptureKit's
    /// microphone capture takes the device's own uniqueID, not the
    /// catalog's sanitized form.
    private static func microphoneDeviceUniqueID(for catalogID: String?) -> String? {
        guard let catalogID, !catalogID.isEmpty else { return nil }
        let devices = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        ).devices
        var namesSeen: [String: Int] = [:]
        for device in devices {
            let name = device.localizedName
            let position = namesSeen[name, default: 0]
            namesSeen[name, default: 0] += 1
            if SourceIds.device(
                uniqueID: device.uniqueID, modelName: name, position: position
            ) == catalogID || device.uniqueID == catalogID {
                return device.uniqueID
            }
        }
        return nil
    }
}

/// The live rig's stoppable pieces. The input recorder is created at
/// `gateOpened`, because its clock needs the epoch.
private final class ProductionCaptureRig: CaptureRig, @unchecked Sendable {

    private let request: SessionRequest
    private let package: RecordingPackage
    private let warning: @Sendable (String, String?) -> Void
    private let screenSource: ScreenSource?
    private let cameraSource: CameraSource?
    private let microphoneSource: MicrophoneSource?
    private let stateLock = NSLock()
    private var recorder: InputRecorder?
    private var heartbeat: DispatchSourceTimer?

    init(
        request: SessionRequest,
        package: RecordingPackage,
        warning: @escaping @Sendable (String, String?) -> Void,
        screenSource: ScreenSource?,
        cameraSource: CameraSource?,
        microphoneSource: MicrophoneSource?
    ) {
        self.request = request
        self.package = package
        self.warning = warning
        self.screenSource = screenSource
        self.cameraSource = cameraSource
        self.microphoneSource = microphoneSource
    }

    func gateOpened(epochHostNs: Int64) async {
        guard request.screen != nil else { return }
        // The input timeline needs a content rectangle in global points and
        // the point-to-pixel scale for its geometry line. The catalog
        // exposes sizes, not origins, so display mode reads the display's
        // live bounds and window mode falls back to the main display's
        // (the Phase 2 shell replaces this with the picked rect).
        let contentRect = Self.contentRect(for: request)
        do {
            let recorder = try InputRecorder(
                url: package.inputURL,
                clock: SessionClock.gating(nowNs: epochHostNs),
                contentRect: contentRect,
                pointPixelScale: Self.pointPixelScale(contentRect: contentRect),
                keystrokes: false,
                ownWindowFrames: { [] },
                warnings: { text in self.warning("input-tap", text) })
            recorder.start()
            installRecorder(recorder)
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "rush.input.heartbeat"))
            timer.schedule(deadline: .now() + 1, repeating: 1)
            timer.setEventHandler { recorder.tick(nowHostNs: Int64(DispatchTime.now().uptimeNanoseconds)) }
            stateLock.withLock { heartbeat = timer }
            timer.resume()
        } catch {
            warning("input-recorder-failed", String(describing: error))
        }
    }

    func stop() async {
        let recorder = takeRecorder()
        recorder?.stop()
        await screenSource?.stop()
        cameraSource?.detachWriter()
        await microphoneSource?.stop()
        stateLock.withLock { heartbeat?.cancel(); heartbeat = nil }
    }

    func adoptClock(_ clock: SessionClock) async {
        stateLock.withLock { recorder?.adoptClock(clock) }
    }

    func setDrawingWindow(windowID: String?) async throws {
        guard let screenSource else {
            throw ControlFailure(code: "drawing-mode-not-supported", message: "drawing requires an active display or area recording")
        }
        try await screenSource.setDrawingWindow(windowID: windowID)
    }

    func captureGeometry() async -> CaptureGeometry? { CaptureGeometry.current(for: request) }

    /// Synchronous lock-confined accessors: the async surface must not hold
    /// an NSLock across a suspension point.
    private func installRecorder(_ recorder: InputRecorder) {
        stateLock.lock()
        self.recorder = recorder
        stateLock.unlock()
    }

    private func takeRecorder() -> InputRecorder? {
        stateLock.lock()
        defer { stateLock.unlock() }
        let recorder = self.recorder
        self.recorder = nil
        return recorder
    }

    private static func contentRect(for request: SessionRequest) -> CGRect {
        if case .area(_, let r)? = request.screen { return r.cgRect }
        if case .window(let id)? = request.screen,
           let number = UInt32(id.replacingOccurrences(of: "window-", with: "")),
           let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]],
           let metadata = rows.first {
            let payload = metadata[kCGWindowBounds as String]
            if let dimensions = payload as? [String: Any], let frame = CGRect(dictionaryRepresentation: dimensions as CFDictionary) { return frame }
        }
        if case .display(let id)? = request.screen,
           let cgID = UInt32(id.replacingOccurrences(of: "display-", with: "")) {
            return CGDisplayBounds(cgID)
        }
        return CGDisplayBounds(CGMainDisplayID())
    }

    /// The geometry line's scale: the display's backing factor, read from
    /// AppKit when the display is found, else the Retina default.
    private static func pointPixelScale(contentRect: CGRect) -> Double {
        let scale = NSScreen.screens.first {
            $0.frame.size == contentRect.size
        }?.backingScaleFactor ?? 2
        return Double(scale)
    }
}

// MARK: - Diagnostic stub rig

/// A synthetic capture rig for headless tests and the engine's diagnostic
/// mode (`--capture-stub`): no ScreenCaptureKit, no camera, no event tap,
/// no permission prompts. It appends synthetic NV12 video frames and PCM
/// audio buffers straight into the session's writers on the real host
/// clock, so packages are produced, finalized and verified by exactly the
/// same session and writer code paths as a live take.
public struct StubCaptureRigFactory: CaptureRigFactory {

    public init() {}

    public func attach(_ context: CaptureContext) async throws -> CaptureRig {
        var writers: [TrackKind: TrackWriter] = [:]
        for kind in context.request.trackKinds {
            if let writer = await context.session.trackWriter(for: kind) {
                if kind == .microphone { writer.setMicrophoneObserver(context.microphoneObserver) }
                writers[kind] = writer
            }
        }
        return try StubCaptureRig(context: context, writers: writers)
    }
}

/// Synthetic media generator (the buffer shapes the session tests use): one
/// NV12 frame at the writer's configured size, one PCM buffer per requested
/// channel count, stamped on the host clock.
enum SyntheticMedia {

    static func videoBuffer(width: Int, height: Int, hostNs: Int64) -> CMSampleBuffer? {
        var pixelBuffer: CVPixelBuffer?
        CVPixelBufferCreate(
            kCFAllocatorDefault, width, height,
            kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, nil, &pixelBuffer)
        guard let buffer = pixelBuffer else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        for plane in 0..<CVPixelBufferGetPlaneCount(buffer) {
            if let base = CVPixelBufferGetBaseAddressOfPlane(buffer, plane) {
                memset(
                    base, 128,
                    CVPixelBufferGetHeightOfPlane(buffer, plane)
                        * CVPixelBufferGetBytesPerRowOfPlane(buffer, plane))
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        var format: CMVideoFormatDescription?
        CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer,
            formatDescriptionOut: &format)
        guard let format else { return nil }
        var timing = CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 30),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        CMSampleBufferCreateForImageBuffer(
            allocator: kCFAllocatorDefault, imageBuffer: buffer, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil,
            formatDescription: format, sampleTiming: &timing, sampleBufferOut: &sample)
        return sample
    }

    static func audioBuffer(channels: Int, hostNs: Int64) -> CMSampleBuffer? {
        let frames = 1024
        let bytesPerFrame = channels * 4
        let asbd = AudioStreamBasicDescription(
            mSampleRate: 48_000,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(bytesPerFrame),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(bytesPerFrame),
            mChannelsPerFrame: UInt32(channels),
            mBitsPerChannel: 32,
            mReserved: 0)
        var format: CMAudioFormatDescription?
        let status = withUnsafePointer(to: asbd) { asbdPtr in
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: asbdPtr, layoutSize: 0, layout: nil,
                magicCookieSize: 0, magicCookie: nil, extensions: nil,
                formatDescriptionOut: &format)
        }
        guard status == noErr, let format else { return nil }
        let totalBytes = frames * bytesPerFrame
        let memory = UnsafeMutableRawPointer.allocate(byteCount: totalBytes, alignment: 16)
        memory.initializeMemory(as: Float.self, repeating: 0, count: totalBytes / 4)
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault, memoryBlock: memory, blockLength: totalBytes,
            blockAllocator: kCFAllocatorMalloc, customBlockSource: nil, offsetToData: 0,
            dataLength: totalBytes, flags: 0, blockBufferOut: &block)
        guard let block else { return nil }
        var timing = [CMSampleTimingInfo(
            duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: CMTime(exactNanoseconds: hostNs),
            decodeTimeStamp: .invalid)]
        var sample: CMSampleBuffer?
        CMSampleBufferCreate(
            allocator: kCFAllocatorDefault, dataBuffer: block, dataReady: true,
            makeDataReadyCallback: nil, refcon: nil, formatDescription: format,
            sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample)
        return sample
    }
}

/// The stub rig's running state. The pump timer runs on its own queue;
/// buffers go through `TrackWriter.appendVideo/appendAudio`, the same
/// synchronous-hop contract the real sources use. Video arrives once per
/// tick (the writer repeats the last frame to the stop time); audio is
/// emitted contiguously from the gate to every tick, with leading silence
/// covering the first tick's gap, so every track spans the whole take.
private final class StubCaptureRig: CaptureRig, @unchecked Sendable {

    private let context: CaptureContext
    private let writers: [TrackKind: TrackWriter]
    private let inputFile: NDJSONAppendFile?
    private let pumpQueue = DispatchQueue(label: "rush.rushcore.control.stubrig")
    private let stateLock = NSLock()
    private var epochHostNs: Int64?
    private var inputClock: SessionClock?
    private var pump: DispatchSourceTimer?
    /// Where each audio track's next synthetic buffer starts, on the host clock.
    private var nextAudioHostNs: [TrackKind: Int64] = [:]
    /// One 1024-sample buffer at 48 kHz.
    private static let audioBufferNs: Int64 = Int64(Double(1024) / 48_000 * 1e9)
    /// Where each video track's next synthetic frame sits, on the host clock.
    private var nextVideoHostNs: [TrackKind: Int64] = [:]
    /// One 30 fps frame interval.
    private static let videoFrameNs: Int64 = 33_333_333

    init(context: CaptureContext, writers: [TrackKind: TrackWriter]) throws {
        self.context = context
        self.writers = writers
        self.inputFile = try NDJSONAppendFile(
            url: context.package.inputURL, fsyncPerLine: false)
    }

    func gateOpened(epochHostNs: Int64) async {
        setEpoch(epochHostNs)
        let width = writers[.screen]?.configuration.videoWidth ?? 0
        let height = writers[.screen]?.configuration.videoHeight ?? 0
        try? inputFile?.append(InputEventLine(
            t: 0, k: InputEventLine.Kind.geom,
            content: [0, 0, Double(width), Double(height)], scale: 1))

        let timer = DispatchSource.makeTimerSource(queue: pumpQueue)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in
            self?.pumpOnce()
        }
        installPump(timer)
        timer.resume()
    }

    func captureGeometry() async -> CaptureGeometry? { CaptureGeometry.synthetic(for: context.request) }

    /// Synchronous lock-confined accessors: the async surface must not hold
    /// an NSLock across a suspension point.
    private func setEpoch(_ epochHostNs: Int64) {
        stateLock.lock()
        self.epochHostNs = epochHostNs
        inputClock = .gating(nowNs: epochHostNs)
        for kind in [TrackKind.microphone, .systemAudio] {
            nextAudioHostNs[kind] = epochHostNs
        }
        for kind in [TrackKind.screen, .camera] {
            nextVideoHostNs[kind] = epochHostNs
        }
        stateLock.unlock()
    }

    func adoptClock(_ clock: SessionClock) async {
        stateLock.withLock { inputClock = clock }
    }

    private func installPump(_ timer: DispatchSourceTimer) {
        stateLock.lock()
        pump = timer
        stateLock.unlock()
    }

    private func currentEpoch() -> Int64? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return epochHostNs
    }

    private func takeVideoCursor(_ kind: TrackKind, now: Int64) -> Int64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        let cursor = nextVideoHostNs[kind] ?? now
        nextVideoHostNs[kind] = now
        return cursor
    }

    private func takeAudioCursor(_ kind: TrackKind, now: Int64) -> Int64 {
        stateLock.lock()
        defer { stateLock.unlock() }
        let cursor = nextAudioHostNs[kind] ?? now
        nextAudioHostNs[kind] = now
        return cursor
    }

    private func advanceAudioCursor(_ kind: TrackKind, to cursor: Int64) {
        stateLock.lock()
        nextAudioHostNs[kind] = cursor
        stateLock.unlock()
    }

    private func advanceVideoCursor(_ kind: TrackKind, to cursor: Int64) {
        stateLock.lock()
        nextVideoHostNs[kind] = cursor
        stateLock.unlock()
    }

    private func cancelPump() {
        stateLock.lock()
        let timer = pump
        pump = nil
        stateLock.unlock()
        timer?.cancel()
    }

    /// One pump tick: catch every track up to now on its natural cadence -
    /// video at 30 fps (the writer's tail pad inherits the frame interval,
    /// so a sparser rhythm would stretch the file past the stop time) and
    /// audio contiguously - so all files span the whole take exactly as a
    /// live capture's would.
    ///
    /// With `pinFinalVideoFrame`, one extra video frame lands 1 ms before
    /// now: the finalize tail pad's inferred duration is the gap to the
    /// previous frame, and pinning that gap to ~1 ms (instead of one frame
    /// interval) is what keeps the finished file within the verify
    /// tolerance of the manifest duration even when the stop's actor hop
    /// stretches under load.
    private func pumpOnce(pinFinalVideoFrame: Bool = false) {
        guard currentEpoch() != nil else { return }
        let now = Int64(DispatchTime.now().uptimeNanoseconds)

        for (kind, writer) in writers {
            switch kind {
            case .screen, .camera:
                let width = writer.configuration.videoWidth ?? 320
                let height = writer.configuration.videoHeight ?? 240
                var cursor = takeVideoCursor(kind, now: now)
                while cursor + Self.videoFrameNs <= now {
                    if let buffer = SyntheticMedia.videoBuffer(
                        width: width, height: height, hostNs: cursor) {
                        writer.appendVideo(buffer)
                    }
                    cursor += Self.videoFrameNs
                }
                if pinFinalVideoFrame {
                    let pin = now - 1_000_000
                    if pin > cursor,
                       let buffer = SyntheticMedia.videoBuffer(
                        width: width, height: height, hostNs: pin) {
                        writer.appendVideo(buffer)
                        cursor = pin
                    }
                }
                advanceVideoCursor(kind, to: cursor)
            case .microphone, .systemAudio:
                let channels = kind == .microphone ? 1 : 2
                var cursor = takeAudioCursor(kind, now: now)
                while cursor + Self.audioBufferNs <= now {
                    if let buffer = SyntheticMedia.audioBuffer(
                        channels: channels, hostNs: cursor) {
                        writer.appendAudio(buffer)
                    }
                    cursor += Self.audioBufferNs
                }
                advanceAudioCursor(kind, to: cursor)
            }
        }
        if let inputFile, let clock = stateLock.withLock({ inputClock }), !clock.isPaused(atHostNs: now) {
            let mediaMs = Double(clock.mediaTimeNs(atHostNs: now)) / 1_000_000
            try? inputFile.append(InputEventLine(
                t: mediaMs, k: InputEventLine.Kind.move, x: 0.5, y: 0.5))
        }
    }

    func stop() async {
        // Final catch-up before the pump dies: one last pass lands each
        // track's newest sample as close to now as possible (video pinned
        // 1 ms behind now), so the session's end time - computed after this
        // call - is never behind a sample and the finalize tail pad spans
        // only the actor hop.
        pumpQueue.sync { self.pumpOnce(pinFinalVideoFrame: true) }
        cancelPump()
        inputFile?.close()
    }
}

/// One reusable camera for warm preview and recording. The actor owns lifecycle;
/// CameraSource confines device/session mutation to its own session queue.
public actor CameraCoordinator {
    private var source: CameraSource?
    private var selectedID: String?
    private var previewTransform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?
    public init() {}

    /// Publication processing has no device lifecycle effects. A transform
    /// also persists for the next explicit warm operation.
    public func setPreviewTransform(_ transform: (@Sendable (CVPixelBuffer) -> CVPixelBuffer?)?) {
        previewTransform = transform
        source?.setPreviewTransform(transform)
    }

    public func warm(cameraID: String?, preview: @escaping @Sendable (Data) -> Void,
                     warning: @escaping @Sendable (String, String?) -> Void) async throws -> CameraSource {
        if let source, selectedID == cameraID, source.isRunning {
            source.previewHandler = preview
            source.setPreviewTransform(previewTransform)
            source.setLossHandler { name in warning("camera-lost", name) }
            return source
        }
        if let source { await source.stopAndWait() }
        let newSource = CameraSource(onCameraLost: { name in warning("camera-lost", name) })
        newSource.previewHandler = preview
        newSource.setPreviewTransform(previewTransform)
        source = newSource
        selectedID = cameraID
        let result = await newSource.warmUp(deviceID: cameraID)
        guard result.identity != nil else {
            throw ControlFailure(code: "camera-warmup-failed", message: result.failure)
        }
        return newSource
    }

    public func stop() async {
        if let source { await source.stopAndWait() }
        source = nil
        selectedID = nil
    }
}
