import CoreGraphics
import CoreMedia
import CoreVideo
import Dispatch
import Foundation
import ScreenCaptureKit

/// Which of the stream's three outputs a sample buffer belongs to. Mirrors
/// `SCStreamOutputType`, and carries the routing decision (which track kind
/// each output feeds) so tests drive routing without ScreenCaptureKit
/// hardware.
public enum ScreenOutputStream: Equatable, Sendable {
    case screen
    case systemAudio
    case microphone

    /// Maps the SDK's output type.
    public init(_ type: SCStreamOutputType) {
        switch type {
        case .screen: self = .screen
        case .audio: self = .systemAudio
        case .microphone: self = .microphone
        @unknown default: self = .screen
        }
    }

    /// The track kind this stream output feeds.
    public var trackKind: TrackKind {
        switch self {
        case .screen: return .screen
        case .systemAudio: return .systemAudio
        case .microphone: return .microphone
        }
    }
}

/// Receives routed sample buffers. `WriterRoutingSink` is the production
/// conformer; tests drive the same routing rules with synthetic buffers and
/// stub writers.
internal protocol ScreenSampleSinking: AnyObject {
    /// One buffer from the stream, already classified. Called on the
    /// stream's sample-handler queue; the conformer performs the synchronous
    /// hop into the writer queues (the backpressure pattern below).
    func accept(_ sampleBuffer: CMSampleBuffer, from output: ScreenOutputStream)
}

/// Routes each stream output to its own track writer (docs/PLAN.md,
/// capture-audio: "Microphone and system audio go to `mic.mov` and
/// `system.mov` ... and are never mixed into the screen file").
///
/// Backpressure (docs/PLAN.md, Track settings): the ScreenCaptureKit callback
/// hops synchronously into the writer queue - `TrackWriter.appendVideo` and
/// `appendAudio` are `queue.sync` - and the stream's queue depth is 3. If the
/// encoder falls behind, the stream's own queue fills and ScreenCaptureKit
/// drops frames instead of the process holding full-size surfaces in memory.
/// This object deliberately performs no buffering of its own.
internal final class WriterRoutingSink: ScreenSampleSinking, @unchecked Sendable {

    private let lock = NSLock()
    private var writers: [TrackKind: TrackWriter] = [:]
    private var counters = ScreenSourceStatus()

    /// Installs the writers the session opened (grab each once via
    /// `RecordingSession.trackWriter(for:)`; no per-buffer actor hops).
    func setWriters(_ writers: [TrackKind: TrackWriter]) {
        lock.lock()
        self.writers = writers
        lock.unlock()
    }

    func accept(_ sampleBuffer: CMSampleBuffer, from output: ScreenOutputStream) {
        lock.lock()
        counters.framesReceived[output] = (counters.framesReceived[output] ?? 0) + 1
        let writer = writers[output.trackKind]
        lock.unlock()
        // The synchronous hop: this call does not return until the writer's
        // serial queue has taken the buffer, which is exactly what makes the
        // stream drop instead of pile up.
        switch output {
        case .screen:
            writer?.appendVideo(sampleBuffer)
        case .systemAudio, .microphone:
            writer?.appendAudio(sampleBuffer)
        }
    }

    /// A snapshot of the source's frame counters plus the writers' dropped
    /// counts (the plan's 1 % budget reads the writers' counter).
    func status() -> ScreenSourceStatus {
        lock.lock()
        defer { lock.unlock() }
        var snapshot = counters
        for (kind, writer) in writers {
            snapshot.writerDroppedFrames[kind] = Int(writer.status().framesDropped)
        }
        return snapshot
    }
}

/// Counters the engine reports for diagnostics; the dropped-frame counter
/// that matters for the plan's 1 % budget is `writerDroppedFrames`, which the
/// session layer writes into the manifest's per-track `droppedFrames`
/// (goal-3's stop path already does).
public struct ScreenSourceStatus: Sendable {
    public var framesReceived: [ScreenOutputStream: Int] = [:]
    public var writerDroppedFrames: [TrackKind: Int] = [:]

    public init() {}
}

/// The SCStreamOutput forwarder: one instance per output type, handed to
/// `SCStream.addStreamOutput`.
///
/// Screen frames only move when their status is `.complete`: ScreenCaptureKit
/// also emits `.idle`/`.blank`/`.suspended` buffers that carry no new pixels
/// (docs/PLAN.md, Frame at zero). Audio and microphone buffers always carry
/// samples.
internal final class ScreenStreamOutputForwarder: NSObject, SCStreamOutput {

    let output: ScreenOutputStream
    private let sink: any ScreenSampleSinking

    init(output: ScreenOutputStream, sink: any ScreenSampleSinking) {
        self.output = output
        self.sink = sink
    }

    func stream(
        _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType
    ) {
        let target = ScreenOutputStream(type)
        if target == .screen, !Self.isCompleteFrame(sampleBuffer) {
            return
        }
        sink.accept(sampleBuffer, from: target)
    }

    /// Reads the frame status ScreenCaptureKit attaches to every screen
    /// buffer.
    static func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int,
            let status = SCFrameStatus(rawValue: raw) else {
            return false
        }
        return status == .complete
    }
}

/// Forwards stream failures to the session's stopEarly path (docs/PLAN.md,
/// During recording: "A stream error ... moves to `finishing` and keeps the
/// footage, with an 'ended early' warning").
internal final class ScreenStreamFailureForwarder: NSObject, SCStreamDelegate {

    /// The engine wires this to `RecordingSession.stopEarly(code:message:)`.
    private let onStreamFailure: @Sendable (String) -> Void
    private let lock = NSLock()
    private var reported = false

    init(onStreamFailure: @escaping @Sendable (String) -> Void) {
        self.onStreamFailure = onStreamFailure
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        let first = !reported
        reported = true
        lock.unlock()
        // Report once: after a stop-with-error the stream delivers nothing
        // more, and the session's finishing path is idempotent anyway.
        guard first else { return }
        onStreamFailure(error.localizedDescription)
    }
}

/// A live `SCStream` behind the protocol `ScreenSource` drives, so tests can
/// substitute a scripted stream.
internal protocol ScreenStreamDriving: AnyObject {
    func addOutput(
        _ forwarder: ScreenStreamOutputForwarder, type: SCStreamOutputType, queue: DispatchQueue?
    ) async throws
    func startCapture() async throws
    func stopCapture() async throws
}

extension SCStream: ScreenStreamDriving {
    func addOutput(
        _ forwarder: ScreenStreamOutputForwarder, type: SCStreamOutputType, queue: DispatchQueue?
    ) async throws {
        // The SDK exposes this as a synchronous throwing method (the async
        // overload does not exist for addStreamOutput on this SDK).
        try addStreamOutput(forwarder, type: type, sampleHandlerQueue: queue)
    }
}

/// Errors a source can refuse to start with.
public enum ScreenSourceError: Error, CustomStringConvertible, Sendable {
    case sourceUnavailable(String)

    public var description: String {
        switch self {
        case .sourceUnavailable(let detail):
            return "capture source unavailable: \(detail)"
        }
    }
}

/// One ScreenCaptureKit stream per take (docs/PLAN.md, capture-screen).
///
/// The source resolves the surface through an injectable content resolver,
/// builds the filter (display excluding our apps / desktop-independent window
/// / display with a source rectangle) and the configuration from a
/// `ScreenStreamPlan`, installs the three outputs - screen video, system
/// audio, microphone - and starts capture. Buffer routing goes through the
/// routing sink; failures go to the injected `onStreamFailure` seam, which
/// the engine wires to the session's stopEarly path.
///
/// Confinement: buffers stay on the stream's handler queues
/// (CMSampleBuffer is non-Sendable), the routing sink is lock-confined, and
/// the stream reference itself is guarded by synchronous accessors used from
/// the async surface.
public final class ScreenSource: @unchecked Sendable {

    /// Resolves a surface into the live ScreenCaptureKit objects a filter
    /// needs. `SystemScreenContentResolver` is the production conformer.
    internal protocol ContentResolving: Sendable {
        func resolve(
            surface: ScreenSurface, excludingBundleIDs: [String]
        ) async throws -> ResolvedContent
    }

    /// The live objects one filter is built from.
    internal struct ResolvedContent {
        let display: SCDisplay
        /// The display's frame in global unflipped points (the same space the
        /// input recorder and the area picker use).
        let displayFrame: CGRect
        let window: SCWindow?
        let excludedApplications: [SCRunningApplication]
    }

    /// The plan's values for the take (sizing, frame rate, queue depth,
    /// pixel format, audio flags), built before the stream exists.
    public let plan: ScreenStreamPlan

    private let resolver: any ContentResolving
    private let streamFactory: @Sendable (
        _ filter: SCContentFilter, _ configuration: SCStreamConfiguration, _ delegate: SCStreamDelegate?
    ) -> any ScreenStreamDriving
    private let queueFactory: @Sendable (String) -> DispatchQueue
    private let failureForwarder: ScreenStreamFailureForwarder
    private let lock = NSLock()
    private var streamStorage: (any ScreenStreamDriving)?
    private var startedFlag = false

    /// The routing sink the session's writers install into.
    internal let routingSink = WriterRoutingSink()

    /// Public entry point with the production seams.
    public convenience init(plan: ScreenStreamPlan, onStreamFailure: @escaping @Sendable (String) -> Void) {
        self.init(
            plan: plan,
            resolver: SystemScreenContentResolver(),
            onStreamFailure: onStreamFailure)
    }

    /// Designated init with injectable seams (tests).
    internal init(
        plan: ScreenStreamPlan,
        resolver: any ContentResolving,
        onStreamFailure: @escaping @Sendable (String) -> Void,
        streamFactory: @escaping @Sendable (
            _ filter: SCContentFilter, _ configuration: SCStreamConfiguration, _ delegate: SCStreamDelegate?
        ) -> any ScreenStreamDriving = { filter, configuration, delegate in
            SCStream(filter: filter, configuration: configuration, delegate: delegate)
        },
        queueFactory: @escaping @Sendable (String) -> DispatchQueue = { label in
            DispatchQueue(label: label, qos: .userInitiated)
        }
    ) {
        self.plan = plan
        self.resolver = resolver
        self.failureForwarder = ScreenStreamFailureForwarder(onStreamFailure: onStreamFailure)
        self.streamFactory = streamFactory
        self.queueFactory = queueFactory
    }

    /// Installs the session's writers into the routing sink (before or after
    /// `start`; the sink forwards nothing until a writer exists).
    public func setWriters(_ writers: [TrackKind: TrackWriter]) {
        routingSink.setWriters(writers)
    }

    /// Builds the plan's `SCStreamConfiguration` (pure; used by unit tests
    /// and the live configure-only checks alike).
    public static func makeConfiguration(for plan: ScreenStreamPlan) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = plan.width
        configuration.height = plan.height
        configuration.minimumFrameInterval = plan.minimumFrameInterval
        configuration.queueDepth = plan.queueDepth
        configuration.pixelFormat = plan.pixelFormat
        configuration.showsCursor = plan.showsCursor
        configuration.capturesAudio = plan.capturesSystemAudio
        configuration.excludesCurrentProcessAudio = plan.excludesOwnProcessAudio
        configuration.captureMicrophone = plan.capturesMicrophone
        configuration.microphoneCaptureDeviceID = plan.microphoneDeviceID
        if let sourceRect = plan.sourceRect {
            configuration.sourceRect = sourceRect
        }
        return configuration
    }

    /// Resolves the surface, builds the filter and the stream, installs the
    /// three outputs and starts capture.
    public func start(surface: ScreenSurface, exclusion: ScreenExclusionList, selftest: Bool) async throws {
        let resolved = try await resolver.resolve(
            surface: surface, excludingBundleIDs: exclusion.bundleIDs(selftest: selftest))
        let filter = Self.makeFilter(resolved: resolved, surface: surface)
        let stream = streamFactory(filter, Self.makeConfiguration(for: plan), failureForwarder)
        let screenQueue = queueFactory("rush.rushcore.sck.screen")
        let audioQueue = queueFactory("rush.rushcore.sck.audio")
        try await stream.addOutput(
            ScreenStreamOutputForwarder(output: .screen, sink: routingSink),
            type: .screen, queue: screenQueue)
        if plan.capturesSystemAudio {
            try await stream.addOutput(
                ScreenStreamOutputForwarder(output: .systemAudio, sink: routingSink),
                type: .audio, queue: audioQueue)
        }
        if plan.capturesMicrophone {
            try await stream.addOutput(
                ScreenStreamOutputForwarder(output: .microphone, sink: routingSink),
                type: .microphone, queue: audioQueue)
        }
        try await stream.startCapture()
        install(stream: stream)
    }

    /// Stops capture. Safe to call twice; a stream that never started is a
    /// no-op.
    public func stop() async {
        guard let current = takeStream() else { return }
        try? await current.stopCapture()
    }

    /// Whether the stream is running.
    public var isStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return startedFlag
    }

    /// Frame counters plus the writers' dropped-frame counts.
    public func status() -> ScreenSourceStatus {
        routingSink.status()
    }

    // Synchronous state helpers (called from the async surface; keeping the
    // lock out of async frames satisfies strict concurrency).
    private func install(stream: any ScreenStreamDriving) {
        lock.lock()
        streamStorage = stream
        startedFlag = true
        lock.unlock()
    }

    private func takeStream() -> (any ScreenStreamDriving)? {
        lock.lock()
        defer { lock.unlock() }
        startedFlag = false
        return streamStorage
    }

    /// Filter construction (docs/PLAN.md, Sources per capture mode):
    /// display and area use the display filter that excludes our own
    /// applications; window uses the desktop-independent window filter; the
    /// area's source rectangle rides the configuration, not the filter.
    static func makeFilter(resolved: ResolvedContent, surface: ScreenSurface) -> SCContentFilter {
        switch surface {
        case .display, .area:
            return SCContentFilter(
                display: resolved.display,
                excludingApplications: resolved.excludedApplications,
                exceptingWindows: [])
        case .window:
            if let window = resolved.window {
                return SCContentFilter(desktopIndependentWindow: window)
            }
            // A vanished window degrades to its display rather than crashing
            // the take; the stream delegate reports the loss.
            return SCContentFilter(
                display: resolved.display,
                excludingApplications: resolved.excludedApplications,
                exceptingWindows: [])
        }
    }
}

/// The production content resolver: matches catalog ids against live
/// `SCShareableContent`.
internal struct SystemScreenContentResolver: ScreenSource.ContentResolving {

    init() {}

    func resolve(
        surface: ScreenSurface, excludingBundleIDs: [String]
    ) async throws -> ScreenSource.ResolvedContent {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)

        // Window mode: find the window first, then the display that holds it
        // (the filter itself is desktop-independent; the display only feeds
        // sizing and the fallback display filter).
        var resolvedWindow: SCWindow? = nil
        if case .window(let id) = surface {
            guard let found = content.windows.first(where: {
                SourceIds.window(Int($0.windowID)) == id
            }) else {
                throw ScreenSourceError.sourceUnavailable("no window matched \(id)")
            }
            resolvedWindow = found
        }

        let wantedDisplayID: String
        switch surface {
        case .display(let id), .area(let id, _):
            wantedDisplayID = id
        case .window:
            if let frame = resolvedWindow?.frame {
                let holding = content.displays.first {
                    $0.frame.contains(CGPoint(x: frame.midX, y: frame.midY))
                }
                wantedDisplayID = holding.map { SourceIds.display($0.displayID) }
                    ?? SourceIds.display(CGMainDisplayID())
            } else {
                wantedDisplayID = SourceIds.display(CGMainDisplayID())
            }
        }

        guard let display = content.displays.first(where: {
            SourceIds.display($0.displayID) == wantedDisplayID
        }) else {
            throw ScreenSourceError.sourceUnavailable("no display matched \(wantedDisplayID)")
        }

        let excluded = content.applications.filter { application in
            excludingBundleIDs.contains(application.bundleIdentifier)
        }
        return ScreenSource.ResolvedContent(
            display: display,
            displayFrame: display.frame,
            window: resolvedWindow,
            excludedApplications: excluded)
    }
}
