import CoreMedia
import Dispatch
import Foundation

/// The session's life-cycle states (docs/PLAN.md, Session states and
/// failure rules).
///
/// `idle -> preparing -> armed -> recording <-> paused -> finishing ->
/// complete | failed`. `armed` is the warm start: writers exist and capture
/// runs behind a closed gate while the caller's countdown runs. `recovered`
/// is not a session state; launch-time recovery sets it on interrupted
/// packages.
public enum SessionState: String, Codable, Sendable {
    case idle
    case preparing
    case armed
    case recording
    case paused
    case finishing
    case complete
    case failed
}

/// Errors a session method can throw, each with a machine-readable shape
/// for the control layer (docs/PLAN.md, Start failure: "Report the error
/// with a machine-readable code").
public enum SessionError: Error, Equatable, Sendable, CustomStringConvertible {

    /// Preflight refused the start.
    case preflightFailed(code: PreflightFailureCode, detail: String?)

    /// The package folder could not be created.
    case packageCreationFailed(String)

    /// The session log could not be opened.
    case logOpenFailed(String)

    /// A track writer could not start; the take never began.
    case writerFailedToStart(kind: TrackKind, reason: String)

    /// The event does not apply in the current state (for example pausing
    /// twice, or resuming without a pause).
    case wrongState(event: String, state: SessionState)

    /// The session clock refused the operation.
    case clock(SessionClock.ClockError)

    /// The manifest could not be written.
    case manifestWriteFailed(String)

    public var description: String {
        switch self {
        case .preflightFailed(let code, let detail):
            return "preflight refused the start (\(code.rawValue))"
                + (detail.map { ": \($0)" } ?? "")
        case .packageCreationFailed(let reason):
            return "could not create the recording package: \(reason)"
        case .logOpenFailed(let reason):
            return "could not open the session log: \(reason)"
        case .writerFailedToStart(let kind, let reason):
            return "the \(kind.rawValue) writer could not start: \(reason)"
        case .wrongState(let event, let state):
            return "\(event) is not allowed while \(state.rawValue)"
        case .clock(let error):
            return "session clock error: \(error)"
        case .manifestWriteFailed(let reason):
            return "could not write the manifest: \(reason)"
        }
    }
}

/// What a finished take produced.
public struct SessionOutcome: Equatable, Sendable {

    /// The package's life-cycle status after the writers finished:
    /// `complete` when requested tracks finished without a fatal failure.
    /// A failed take may still contain usable or partial footage.
    public let status: RecordingManifest.Status
    public let recordingID: String
    public let packageURL: URL
    /// Media duration of the take (wall time minus pauses), or nil when
    /// nothing was recorded.
    public let durationNs: Int64?
    public let warnings: [RecordingManifest.ManifestWarning]
    public let tracks: [TrackWriterStatus]

    public init(
        status: RecordingManifest.Status,
        recordingID: String,
        packageURL: URL,
        durationNs: Int64?,
        warnings: [RecordingManifest.ManifestWarning],
        tracks: [TrackWriterStatus]
    ) {
        self.status = status
        self.recordingID = recordingID
        self.packageURL = packageURL
        self.durationNs = durationNs
        self.warnings = warnings
        self.tracks = tracks
    }
}

/// Builds a `TrackWriter` for the session. Injectable so tests (and, if
/// ever needed, the engine) can substitute or refuse writers.
public typealias TrackWriterOpener = @Sendable (
    _ configuration: TrackWriterConfiguration,
    _ clock: SessionClock
) throws -> TrackWriter

/// The recording state machine (docs/PLAN.md, Session states and failure
/// rules; module table: "RecordingSession actor: the state machine,
/// preflight checks, warnings").
///
/// One `RecordingSession` runs one take: a fresh package per recording, so
/// a new take can never overwrite the last one. The session owns its
/// writers, built from the request and the package at start, and capture
/// (goal-4) only forwards buffers: grab each writer once with
/// `trackWriter(for:)` and append from the capture queue, or use the
/// forwarding conveniences `appendVideo`/`appendAudio`, which never hop
/// into the actor.
///
/// Start order per the plan: preflight (no prompting) -> package created
/// and manifest written with status `preparing` -> writers opened -> status
/// `recording` written with all track entries while still behind the gate
/// -> the gate opens (`openGate`) and the manifest is rewritten with the
/// epoch that same instant. Pauses go through the one shared `SessionClock`
/// and every writer adopts it. Stop finalizes every track bounded by five
/// seconds each, keeps all footage, and never sets the `verified` stamp
/// (the decode test is a separate pass).
///
/// The session never deletes a package. A start failure cancels writers it
/// opened (their files hold no samples); every byte of recorded media is
/// kept.
public actor RecordingSession {

    // MARK: - Configuration (immutable)

    private let outputRoot: URL
    private let catalog: any SourceCataloging
    private let volumeProvider: @Sendable (URL) -> VolumeInfo
    private let permissionAdvisor: PermissionAdvisor
    private let minimumFreeBytes: Int64
    private let hostNowNs: @Sendable () -> Int64
    private let makeWriter: TrackWriterOpener
    private let writerTable = WriterTable()

    // MARK: - Session state

    /// The current life-cycle state. Read it through `snapshot()` from
    /// outside the actor.
    public private(set) var state: SessionState = .idle

    private var request: SessionRequest?
    private var package: RecordingPackage?
    private var manifest: RecordingManifest?
    private var log: NDJSONAppendFile?
    private var clock: SessionClock?
    private var warnings: [RecordingManifest.ManifestWarning] = []
    private var cameraEndedNs: Int64?
    private var cameraFinalize: Task<TrackWriterStatus, Never>?

    /// Track order used for statuses and manifest entries.
    private static let trackOrder: [TrackKind] = [.screen, .camera, .microphone, .systemAudio]

    public init(
        outputRoot: URL = RecordingPackage.defaultRoot,
        catalog: any SourceCataloging = SystemSourceCatalog(),
        volumeProvider: @escaping @Sendable (URL) -> VolumeInfo = {
            VolumeInfo.current(nearestAncestorOf: $0)
        },
        permissionAdvisor: PermissionAdvisor = .allAllowed,
        minimumFreeBytes: Int64 = Preflight.startFloorBytes,
        hostNowNs: @escaping @Sendable () -> Int64 = {
            Int64(DispatchTime.now().uptimeNanoseconds)
        },
        makeWriter: @escaping TrackWriterOpener = { configuration, clock in
            try TrackWriter(configuration: configuration, clock: clock)
        }
    ) {
        self.outputRoot = outputRoot
        self.catalog = catalog
        self.volumeProvider = volumeProvider
        self.permissionAdvisor = permissionAdvisor
        self.minimumFreeBytes = minimumFreeBytes
        self.hostNowNs = hostNowNs
        self.makeWriter = makeWriter
    }

    // MARK: - Start

    /// Runs preflight, creates the package, writes the manifest (status
    /// `preparing`, then `recording` with all track entries while still
    /// behind the gate) and opens the track writers.
    ///
    /// A preflight refusal or a writer that cannot start throws and leaves
    /// the session `failed`; the package, once created, is kept. The
    /// returned package names the take. After `start`, the caller times the
    /// countdown and opens the gate.
    @discardableResult
    public func start(_ request: SessionRequest) async throws -> RecordingPackage {
        guard state == .idle else {
            throw SessionError.preflightFailed(
                code: .alreadyActive, detail: "this session is \(state.rawValue)")
        }
        state = .preparing

        let preflight = Preflight(
            catalog: catalog,
            outputRoot: outputRoot,
            volume: volumeProvider(outputRoot),
            minimumFreeBytes: minimumFreeBytes,
            permissionAdvisor: permissionAdvisor,
            alreadyActive: false)
        let result = await preflight.run(request: request)
        guard result.ok, let effective = result.effectiveRequest else {
            state = .failed
            throw SessionError.preflightFailed(
                code: result.failureCode ?? .invalidRequest, detail: result.failureDetail)
        }
        self.request = effective
        self.warnings = result.warnings

        let created: RecordingPackage
        do {
            created = try RecordingPackage.create(root: outputRoot)
        } catch {
            state = .failed
            throw SessionError.packageCreationFailed(String(describing: error))
        }
        package = created
        do {
            log = try NDJSONAppendFile(url: created.logURL)
        } catch {
            state = .failed
            throw SessionError.logOpenFailed(String(describing: error))
        }
        logStateChange(from: .idle, to: .preparing)

        manifest = Self.buildManifest(
            request: effective,
            package: created,
            warnings: warnings,
            deviceNames: result.resolvedDeviceNames,
            createdHostNs: nowNs())
        do {
            try persistManifest()
        } catch {
            state = .failed
            throw SessionError.manifestWriteFailed(String(describing: error))
        }

        // Writers open behind the gate: until it opens, every sample counts
        // as pre-gate, so video is cached for media time zero and audio is
        // discarded. openGate hands every writer the real clock.
        let gatedClock = SessionClock(epochNs: Int64.max)
        var opened: [TrackKind: TrackWriter] = [:]
        for kind in effective.trackKinds {
            do {
                opened[kind] = try makeWriter(
                    Self.writerConfiguration(for: kind, request: effective, package: created),
                    gatedClock)
            } catch {
                await cancelWriters(opened)
                appendWarning(
                    RecordingManifest.ManifestWarning(
                        code: "writer-failed-to-start",
                        message: "\(kind.rawValue): \(error)"))
                manifest?.status = .failed
                try? persistManifest()
                logStateChange(from: .preparing, to: .failed)
                state = .failed
                throw SessionError.writerFailedToStart(
                    kind: kind, reason: String(describing: error))
            }
        }
        // The HEVC-to-H.264 fallback is a warning per the plan (Track
        // settings), recorded as soon as the writer reports it.
        for kind in opened.keys.sorted(by: { $0.rawValue < $1.rawValue }) {
            if opened[kind]!.status().usedFallbackCodec {
                appendWarning(RecordingManifest.ManifestWarning(
                    code: "codec-fallback",
                    message: "the \(kind.rawValue) writer fell back to h264"))
            }
        }
        writerTable.set(opened)

        state = .armed
        manifest?.status = .recording
        do {
            try persistManifest()
        } catch {
            await cancelWriters(opened)
            state = .failed
            throw SessionError.manifestWriteFailed(String(describing: error))
        }
        logStateChange(from: .preparing, to: .armed)
        return created
    }

    /// Opens the start gate: sets the epoch, hands every writer the real
    /// session clock and rewrites the manifest with the epoch, all at the
    /// gate instant (docs/PLAN.md, Armed).
    ///
    /// The caller owns the countdown's timing; pass `atHostNs` to name the
    /// instant captured when the countdown ended, or omit it to use now.
    /// Returns the epoch: media time zero for every track.
    @discardableResult
    public func openGate(atHostNs explicit: Int64? = nil) async throws -> Int64 {
        guard state == .armed else {
            throw SessionError.wrongState(event: "openGate", state: state)
        }
        let epoch = explicit ?? nowNs()
        let openedClock = SessionClock.gating(nowNs: epoch)
        clock = openedClock
        for writer in writerTable.all.values {
            writer.adoptClock(openedClock)
        }
        manifest?.startedHostNs = epoch
        manifest?.clock = .init(clock: openedClock, durationNs: nil)
        manifest?.status = .recording
        do {
            try persistManifest()
        } catch {
            throw SessionError.manifestWriteFailed(String(describing: error))
        }
        state = .recording
        logStateChange(from: .armed, to: .recording)
        return epoch
    }

    // MARK: - Pause and resume

    /// Pauses the shared clock. Every writer adopts it and drops samples
    /// that arrive inside the pause; later samples shift by the same total.
    public func pause() async throws {
        guard state == .recording, var workingClock = clock else {
            throw SessionError.wrongState(event: "pause", state: state)
        }
        do {
            try workingClock.beginPause(nowNs: nowNs())
        } catch let error as SessionClock.ClockError {
            throw SessionError.clock(error)
        }
        clock = workingClock
        for writer in writerTable.all.values {
            writer.adoptClock(workingClock)
        }
        state = .paused
        manifest?.clock = .init(clock: workingClock, durationNs: nil)
        do {
            try persistManifest()
        } catch {
            throw SessionError.manifestWriteFailed(String(describing: error))
        }
        logStateChange(from: .recording, to: .paused)
    }

    /// Resumes the shared clock, closing the open pause.
    public func resume() async throws {
        guard state == .paused, var workingClock = clock else {
            throw SessionError.wrongState(event: "resume", state: state)
        }
        do {
            try workingClock.endPause(nowNs: nowNs())
        } catch let error as SessionClock.ClockError {
            throw SessionError.clock(error)
        }
        clock = workingClock
        for writer in writerTable.all.values {
            writer.adoptClock(workingClock)
        }
        state = .recording
        manifest?.clock = .init(clock: workingClock, durationNs: nil)
        do {
            try persistManifest()
        } catch {
            throw SessionError.manifestWriteFailed(String(describing: error))
        }
        logStateChange(from: .paused, to: .recording)
    }

    // MARK: - Buffer forwarding (capture path)

    /// The writer for one track, for direct appends from the capture queue.
    /// Writers are `TrackWriter` instances and safe to call from any thread;
    /// grabbing each writer once at start keeps capture free of actor hops.
    public func trackWriter(for kind: TrackKind) -> TrackWriter? {
        writerTable.writer(for: kind)
    }

    /// Forwards one video sample buffer to a track's writer. Never hops
    /// into the actor and never blocks: this is the path goal-4's capture
    /// callbacks use. A missing writer (track not requested, or the take
    /// already finished) is a no-op.
    nonisolated public func appendVideo(_ sampleBuffer: CMSampleBuffer, for kind: TrackKind) {
        writerTable.writer(for: kind)?.appendVideo(sampleBuffer)
    }

    /// Forwards one audio sample buffer to a track's writer, on the same
    /// contract as `appendVideo(_:for:)`.
    nonisolated public func appendAudio(_ sampleBuffer: CMSampleBuffer, for kind: TrackKind) {
        writerTable.writer(for: kind)?.appendAudio(sampleBuffer)
    }

    // MARK: - Warnings

    /// Records a warning into the manifest and the session log. Capture
    /// (goal-4) uses this for `camera-lost` and `mic-silent`; the control
    /// layer can surface anything it observes. `atMs` is media time when
    /// the gate has opened.
    public func recordWarning(code: String, message: String? = nil) {
        guard package != nil else { return }
        appendWarning(RecordingManifest.ManifestWarning(
            code: code, message: message))
        try? persistManifest()
        logWarning(code: code, message: message)
    }

    // MARK: - Stop

    /// Stops the take: every track is finalized to one common media end
    /// time, each bounded by five seconds, and the manifest is written with
    /// status `complete` when requested tracks finished, otherwise `failed`.
    ///
    /// Stopping from `armed` (the countdown was cancelled) simply finds no
    /// samples: the writers report empty tracks and the take ends `failed`
    /// with the empty package kept. The `verified` stamp is not set here;
    /// the decode test is a separate pass.
    public func stop() async throws -> SessionOutcome {
        try await finishInternal()
    }

    /// Stops the take early, recording an `ended-early` warning first. This
    /// is the path for stream errors, writer failures and the below-1 GB
    /// disk floor during recording (docs/PLAN.md, During recording): the
    /// footage is finalized and kept.
    public func stopEarly(code: String, message: String? = nil) async throws -> SessionOutcome {
        guard package != nil else {
            throw SessionError.wrongState(event: "stopEarly", state: state)
        }
        var text = code
        if let message { text += ": \(message)" }
        recordWarning(code: "ended-early", message: text)
        return try await finishInternal(failedEarly: true)
    }

    private func finishInternal(failedEarly: Bool = false) async throws -> SessionOutcome {
        guard [.armed, .recording, .paused].contains(state) else {
            throw SessionError.wrongState(event: "stop", state: state)
        }
        let from = state

        // A crash while the writers finish must leave a recoverable
        // package: `finishing` counts as interrupted at launch.
        if state == .paused, var workingClock = clock {
            try? workingClock.endPause(nowNs: nowNs())
            clock = workingClock
        }
        state = .finishing
        manifest?.status = .finishing
        try? persistManifest()

        // Common end: all tracks end at the same media time; video repeats
        // its last frame there, audio is padded with silence.
        let endMediaNs = clock.map { $0.durationNs(nowNs: nowNs()) }
        if let cameraFinalize { _ = await cameraFinalize.value }
        var statuses: [TrackKind: TrackWriterStatus] = [:]
        await withTaskGroup(of: (TrackKind, TrackWriterStatus).self) { group in
            for (kind, writer) in writerTable.all {
                group.addTask {
                    (kind, await writer.finalize(endMediaTimeNs: endMediaNs, deadline: .seconds(5)))
                }
            }
            for await (kind, status) in group {
                statuses[kind] = status
            }
        }

        var anyFootage = false
        var failedTrack = false
        if var workingManifest = manifest {
            for index in workingManifest.tracks.indices {
                let kind = workingManifest.tracks[index].kind
                guard let status = statuses[kind] else { continue }
                var track = workingManifest.tracks[index]
                if let reason = status.errorDescription {
                    failedTrack = true
                    appendWarning(RecordingManifest.ManifestWarning(
                        code: "track-failed", message: "\(track.file): \(reason)"))
                }
                switch status.finalizeState {
                case .finalized, .degraded:
                    track.present = true
                    anyFootage = true
                    if status.usedFallbackCodec { track.codec = VideoCodec.h264.rawValue }
                    if status.finalizeState == .degraded {
                        failedTrack = true
                        track.present = status.framesWritten > 0
                        if let file = package?.trackURL(for: kind) {
                            track.present = track.present || FileManager.default.fileExists(atPath: file.path)
                        }
                        appendWarning(RecordingManifest.ManifestWarning(
                            code: "finalize-degraded",
                            message: "\(track.file) missed the finalize deadline; "
                                + "retained media is unchecked and may still be finishing. Relaunch Rushes if checking cannot resume."))
                    }
                case .failed, .cancelled, .idle, .finalizing:
                    // An encoder can fail after flushing playable fragments.
                    // Keep that file visible for recovery/verification, while
                    // reporting the take's failure independently of retention.
                    track.present = status.framesWritten > 0
                    anyFootage = anyFootage || track.present
                    let emptyLostCamera = kind == .camera && cameraEndedNs != nil
                        && status.framesWritten == 0 && status.errorDescription == nil
                    if !emptyLostCamera { failedTrack = true }
                    if status.errorDescription == nil {
                        appendWarning(RecordingManifest.ManifestWarning(
                            code: "track-empty", message: "\(track.file) holds no samples"))
                    }
                }
                track.droppedFrames = status.framesDropped
                track.firstSampleNs = status.firstMediaTimeNs
                if kind == .camera, let cameraEndedNs { track.durationNs = cameraEndedNs }
                workingManifest.tracks[index] = track
            }
            // appendWarning updated the session's warning list; carry it in.
            workingManifest.warnings = warnings
            manifest = workingManifest
        }

        let finalStatus: RecordingManifest.Status = anyFootage && !failedEarly && !failedTrack
            ? .complete : .failed
        manifest?.status = finalStatus
        manifest?.endedHostNs = nowNs()
        if let clock {
            manifest?.clock = .init(clock: clock, durationNs: endMediaNs)
        }

        state = finalStatus == .complete ? .complete : .failed
        logStateChange(from: from, to: state)
        log?.close()
        log = nil

        let orderedStatuses = Self.trackOrder.compactMap { statuses[$0] }
        let outcome = SessionOutcome(
            status: finalStatus,
            recordingID: package?.id ?? "",
            packageURL: package?.folderURL ?? outputRoot,
            durationNs: anyFootage ? endMediaNs : nil,
            warnings: warnings,
            tracks: orderedStatuses)

        do {
            try persistManifest()
        } catch {
            throw SessionError.manifestWriteFailed(String(describing: error))
        }
        return outcome
    }

    public func endCameraAtLoss() async {
        guard cameraEndedNs == nil, let clock, let writer = writerTable.writer(for: .camera) else { return }
        let end = clock.durationNs(nowNs: nowNs())
        cameraEndedNs = end
        let finalize = Task { await writer.finalize(endMediaTimeNs: end) }
        cameraFinalize = finalize
        _ = await finalize.value
    }

    public func effectiveRequest() -> SessionRequest? { request }

    public func currentClock() -> SessionClock? { clock }

    public func setBubble(_ bubble: BubbleMetadata) throws {
        manifest?.bubble = bubble
        try persistManifest()
    }

    public func setMuted(_ muted: Bool, for kind: TrackKind) throws {
        guard [.recording, .paused].contains(state), kind.carriesAudio,
              let writer = writerTable.writer(for: kind) else {
            throw SessionError.wrongState(event: "mute", state: state)
        }
        writer.setMuted(muted)
    }

    // MARK: - Snapshot

    /// A consistent, Codable report for the control layer.
    public func snapshot() -> SessionSnapshot {
        let nowNs = nowNs()
        return SessionSnapshot(
            state: state,
            recordingID: package?.id,
            packagePath: package?.folderURL.path,
            epochHostNs: clock?.epochNs,
            elapsedMediaNs: clock.map { $0.durationNs(nowNs: nowNs) },
            paused: state == .paused,
            warnings: warnings,
            tracks: Self.trackOrder.compactMap { writerTable.writer(for: $0)?.status() })
    }

    // MARK: - Internals

    private func nowNs() -> Int64 {
        hostNowNs()
    }

    private func appendWarning(_ warning: RecordingManifest.ManifestWarning) {
        if let clock {
            let atMs = clock.durationNs(nowNs: nowNs()) / 1_000_000
            warnings.append(
                RecordingManifest.ManifestWarning(
                    code: warning.code, atMs: Int(atMs), message: warning.message))
        } else {
            warnings.append(warning)
        }
        manifest?.warnings = warnings
    }

    private func cancelWriters(_ writers: [TrackKind: TrackWriter]) async {
        for writer in writers.values {
            await writer.cancel()
        }
    }

    /// Writes the manifest through the package's atomic writer.
    private func persistManifest() throws {
        guard let package, let manifest else { return }
        try package.writeManifest(manifest)
    }

    private func logStateChange(from: SessionState, to: SessionState) {
        logEvent(SessionLogEvent(hostNs: nowNs(), event: "state", from: from.rawValue, to: to.rawValue))
    }

    private func logWarning(code: String, message: String?) {
        let atMs = clock.map { Int($0.durationNs(nowNs: nowNs()) / 1_000_000) }
        logEvent(SessionLogEvent(
            hostNs: nowNs(), event: "warning", code: code, message: message, atMs: atMs))
    }

    private func logEvent(_ event: SessionLogEvent) {
        guard let log else { return }
        try? log.append(event)
    }

    // MARK: - Manifest and writer construction

    /// The manifest as first written at start: status set by the caller.
    private static func buildManifest(
        request: SessionRequest,
        package: RecordingPackage,
        warnings: [RecordingManifest.ManifestWarning],
        deviceNames: [String: String],
        createdHostNs: Int64
    ) -> RecordingManifest {
        let formatter = ISO8601DateFormatter()
        let tracks = request.trackKinds.map { kind in
            makeTrack(kind: kind, request: request, deviceNames: deviceNames)
        }
        var sources = RecordingManifest.RecordingSources(
            mode: request.screen?.modeString ?? "camera-only",
            displayId: {
                switch request.screen {
                case .display(let id), .area(let id, _): return id
                default: return nil
                }
            }(),
            windowId: {
                if case .window(let id) = request.screen { return id }
                return nil
            }(),
            cameraId: request.cameraId,
            microphoneId: request.microphoneId,
            systemAudio: request.systemAudio)
        if case .area(_, let area) = request.screen { sources.area = area }
        sources.cursor = request.cursor
        return RecordingManifest(
            id: package.id,
            title: request.title,
            createdAt: formatter.string(from: Date()),
            createdHostNs: createdHostNs,
            status: .preparing,
            sources: sources,
            tracks: tracks,
            input: RecordingManifest.RecordingInput(),
            warnings: warnings)
    }

    /// One manifest track entry at start, with the plan's Track settings
    /// table as the declared intent (the writer's finalize updates codec,
    /// first sample and drops).
    private static func makeTrack(
        kind: TrackKind,
        request: SessionRequest,
        deviceNames: [String: String]
    ) -> RecordingManifest.RecordingTrack {
        switch kind {
        case .screen:
            let dimensions = request.screenDimensions!
            return RecordingManifest.RecordingTrack(
                kind: .screen, present: true, codec: VideoCodec.hevc.rawValue,
                width: dimensions.width, height: dimensions.height, fps: 60)
        case .camera:
            let dimensions = request.effectiveCameraDimensions
            return RecordingManifest.RecordingTrack(
                kind: .camera, present: true, codec: VideoCodec.hevc.rawValue,
                width: dimensions.width, height: dimensions.height, fps: 30,
                device: request.cameraId.map {
                    RecordingManifest.DeviceRef(uniqueId: $0, name: deviceNames[$0])
                })
        case .microphone:
            return RecordingManifest.RecordingTrack(
                kind: .microphone, present: true, codec: "aac",
                sampleRate: 48_000, channels: 1,
                device: request.microphoneId.map {
                    RecordingManifest.DeviceRef(uniqueId: $0, name: deviceNames[$0])
                })
        case .systemAudio:
            return RecordingManifest.RecordingTrack(
                kind: .systemAudio, present: true, codec: "aac",
                sampleRate: 48_000, channels: 2)
        }
    }

    /// The writer configuration for one requested track. Dimensions are
    /// guaranteed by preflight.
    private static func writerConfiguration(
        for kind: TrackKind,
        request: SessionRequest,
        package: RecordingPackage
    ) -> TrackWriterConfiguration {
        switch kind {
        case .screen:
            guard let dimensions = request.screenDimensions else {
                preconditionFailure("preflight guarantees screen dimensions")
            }
            return TrackWriterConfiguration.screen(
                outputURL: package.trackURL(for: .screen),
                width: dimensions.width, height: dimensions.height)
        case .camera:
            let dimensions = request.effectiveCameraDimensions
            return TrackWriterConfiguration.camera(
                outputURL: package.trackURL(for: .camera),
                width: dimensions.width, height: dimensions.height)
        case .microphone:
            return TrackWriterConfiguration.microphone(
                outputURL: package.trackURL(for: .microphone))
        case .systemAudio:
            return TrackWriterConfiguration.systemAudio(
                outputURL: package.trackURL(for: .systemAudio))
        }
    }
}

/// Thread-safe home for the open writers. Filled once at start, emptied
/// never: after the take finishes the writers simply refuse more samples.
/// Keeping them outside actor isolation is what makes the nonisolated
/// forwarding methods possible, so capture never waits on the actor.
private final class WriterTable: @unchecked Sendable {
    private let lock = NSLock()
    private var writers: [TrackKind: TrackWriter] = [:]

    func set(_ writers: [TrackKind: TrackWriter]) {
        lock.lock()
        self.writers = writers
        lock.unlock()
    }

    func writer(for kind: TrackKind) -> TrackWriter? {
        lock.lock()
        defer { lock.unlock() }
        return writers[kind]
    }

    var all: [TrackKind: TrackWriter] {
        lock.lock()
        defer { lock.unlock() }
        return writers
    }
}

/// One `log.ndjson` line: a state change or a warning, stamped with host
/// time and (for warnings) media time. Never secrets or signed URLs
/// (docs/PLAN.md, Package layout).
private struct SessionLogEvent: Codable {
    let hostNs: Int64
    let event: String
    var from: String?
    var to: String?
    var code: String?
    var message: String?
    var atMs: Int?
}
