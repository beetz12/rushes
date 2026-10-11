import AppKit
import CoreGraphics
import Foundation

// MARK: - Result shapes

/// What `record.start` returns once the gate has opened.
public struct StartedRecording: Codable, Equatable, Sendable {
    public var id: String
    public var packagePath: String
    public var state: String

    init(recordingID: String, packagePath: String) {
        self.id = recordingID
        self.packagePath = packagePath
        self.state = "recording"
    }
}

/// What `record.stop` returns and `recording-stopped` carries.
public struct StoppedRecording: Codable, Equatable, Sendable {
    public var id: String
    public var packagePath: String
    public var status: String
    public var durationMs: Int64?
    public var tracks: [TrackWriterStatus]
    public var warnings: [RecordingManifest.ManifestWarning]

    init(outcome: SessionOutcome) {
        self.id = outcome.recordingID
        self.packagePath = outcome.packageURL.path
        self.status = outcome.status.rawValue
        self.durationMs = outcome.durationNs.map { $0 / 1_000_000 }
        self.tracks = outcome.tracks
        self.warnings = outcome.warnings
    }

    init(failedRecordingID: String, packagePath: String) {
        self.id = failedRecordingID
        self.packagePath = packagePath
        self.status = RecordingManifest.Status.failed.rawValue
        self.durationMs = nil
        self.tracks = []
        self.warnings = []
    }
}

// MARK: - Configuration

/// Everything `EngineController` runs on; every seam is injectable so the
/// suite runs headless against real sessions and writers with stub capture.
public struct EngineControllerConfig: Sendable {

    public var recordingsRoot: URL
    public var indexDatabaseURL: URL
    public var catalog: any SourceCataloging
    public var volumeProvider: @Sendable (URL) -> VolumeInfo
    public var permissionAdvisor: PermissionAdvisor
    public var makeWriter: TrackWriterOpener
    public var captureRigs: CaptureRigFactory
    public var hostNowNs: @Sendable () -> Int64
    public var version: String
    /// Echoed inside the guide so a reader knows where this engine listens.
    public var socketPath: String

    public init(
        recordingsRoot: URL = RecordingPackage.defaultRoot,
        indexDatabaseURL: URL = PackageIndex.defaultDatabaseURL,
        catalog: any SourceCataloging = SystemSourceCatalog(),
        volumeProvider: @escaping @Sendable (URL) -> VolumeInfo = {
            VolumeInfo.current(nearestAncestorOf: $0)
        },
        permissionAdvisor: PermissionAdvisor = .allAllowed,
        makeWriter: @escaping TrackWriterOpener = { configuration, clock in
            try TrackWriter(configuration: configuration, clock: clock)
        },
        captureRigs: CaptureRigFactory = ProductionCaptureRigFactory(),
        hostNowNs: @escaping @Sendable () -> Int64 = {
            Int64(DispatchTime.now().uptimeNanoseconds)
        },
        version: String = "0.1.0-dev",
        socketPath: String = ""
    ) {
        self.recordingsRoot = recordingsRoot
        self.indexDatabaseURL = indexDatabaseURL
        self.catalog = catalog
        self.volumeProvider = volumeProvider
        self.permissionAdvisor = permissionAdvisor
        self.makeWriter = makeWriter
        self.captureRigs = captureRigs
        self.hostNowNs = hostNowNs
        self.version = version
        self.socketPath = socketPath
    }
}

// MARK: - Internals

private struct ActiveRecording {
    let session: RecordingSession
    let rig: CaptureRig
    let package: RecordingPackage
    let recordingID: String
    /// The request tag events for this recording carry (the `--wait`
    /// client correlates on it).
    let startRequestID: String
}

private enum SessionTransition { case pause, resume }

// MARK: - Controller

/// The glue between the control socket and the engine's modules
/// (docs/PLAN.md, Control interface). Owns at most one active
/// `RecordingSession` and its capture rig; every command in the guide maps
/// onto one method here, so the app, the CLI and the later MCP server
/// cannot drift apart.
public actor EngineController: ControlHandling {

    private let config: EngineControllerConfig
    private let index: PackageIndex

    private var active: ActiveRecording?
    private var durationTimer: Task<Void, Never>?
    private var completionWaiters: [CheckedContinuation<StoppedRecording, Never>] = []
    /// The most recent stop outcome, kept so a `--wait` client whose
    /// recording ended between start and wait still receives it.
    private var lastStopResult: StoppedRecording?

    /// Where events go. Every `handle` call refreshes this from the serving
    /// context (all contexts share the server's broadcast, so this is one
    /// wire, whichever client spoke last); tests install their own sink.
    private var eventSink: (@Sendable (ControlEvent) -> Void)?

    public init(config: EngineControllerConfig) throws {
        self.config = config
        self.index = try PackageIndex(databaseURL: config.indexDatabaseURL)
    }

    // MARK: - Boot and shutdown

    /// Launch-time pass: recover interrupted packages, then rebuild the
    /// index from the manifests (docs/PLAN.md, Crash safety and recovery;
    /// the manifest is the source of truth, the index is a cache).
    public func prepare() async {
        _ = try? await PackageRecovery(root: config.recordingsRoot)
            .recover(interruptedAtLaunch: true)
        _ = try? await index.rebuild(root: config.recordingsRoot)
    }

    /// Installs a test-side event collector.
    public func setEventSink(_ sink: @escaping @Sendable (ControlEvent) -> Void) {
        eventSink = sink
    }

    /// Stops any active recording (bounded: each writer's finalize is raced
    /// against five seconds) so the engine can exit on a signal without
    /// losing footage.
    @discardableResult
    public func shutdown() async -> StoppedRecording? {
        guard active != nil else { return nil }
        return try? await stopActive()
    }

    // MARK: - ControlHandling

    public func handle(_ request: ControlRequest, context: ControlCommandContext) async {
        eventSink = context.broadcast
        do {
            if let response = try await dispatch(request) {
                context.reply(response)
            }
        } catch let failure as ControlFailure {
            context.reply(ControlResponse(
                id: request.id, ok: false, result: nil, error: failure.payload))
        } catch {
            context.reply(ControlResponse.failure(
                id: request.id, code: ControlErrorCode.internalError,
                message: String(describing: error)))
        }
    }

    private func dispatch(_ request: ControlRequest) async throws -> ControlResponse? {
        switch request.cmd {
        case "ping":
            return .success(
                id: request.id,
                result: .object(["pong": .bool(true), "nowNs": .int(config.hostNowNs())]))
        case "version":
            return .success(
                id: request.id,
                result: .object([
                    "name": .string("rushcore-engine"),
                    "version": .string(config.version),
                    "protocol": .string("1"),
                ]))
        case "guide":
            let guide = ControlGuide.make(
                version: config.version, socketPath: config.socketPath)
            return .success(id: request.id, result: try JSONValue(encoding: guide))
        case "status":
            return .success(id: request.id, result: try await statusResult())
        case "targets":
            return .success(id: request.id, result: try await targetsResult())
        case "record.start":
            return try await recordStart(request)
        case "record.stop":
            let result: StoppedRecording
            if let wanted = request.param("id")?.string, !wanted.isEmpty {
                result = try await stopRecording(id: wanted)
            } else {
                result = try await stopActive()
            }
            return .success(id: request.id, result: try JSONValue(encoding: result))
        case "record.pause":
            try await transition(.pause)
            return .success(id: request.id, result: .object(["state": .string("paused")]))
        case "record.resume":
            try await transition(.resume)
            return .success(id: request.id, result: .object(["state": .string("recording")]))
        case "list":
            return .success(id: request.id, result: try await listResult(request))
        case "show":
            return .success(id: request.id, result: try await showResult(request))
        case "verify":
            return .success(id: request.id, result: try await verifyResult(request))
        default:
            throw ControlFailure(
                code: ControlErrorCode.unknownCommand,
                message: "no command named \(request.cmd); run guide")
        }
    }

    // MARK: - Read-only commands

    private func statusResult() async throws -> JSONValue {
        guard let recording = active else {
            var object: [String: JSONValue] = [
                "state": .string("idle"),
                "version": .string(config.version),
            ]
            if !config.socketPath.isEmpty {
                object["socket"] = .string(config.socketPath)
            }
            return .object(object)
        }
        let snapshot = await recording.session.snapshot()
        return .object([
            "state": .string(snapshot.state.rawValue),
            "recording": try JSONValue(encoding: snapshot),
        ])
    }

    private func targetsResult() async throws -> JSONValue {
        .object([
            "displays": try JSONValue(encoding: try await config.catalog.displays()),
            "windows": try JSONValue(encoding: try await config.catalog.windows()),
            "cameras": try JSONValue(encoding: try await config.catalog.cameras()),
            "microphones": try JSONValue(encoding: try await config.catalog.microphones()),
        ])
    }

    private func listResult(_ request: ControlRequest) async throws -> JSONValue {
        var rows = try await index.allRows()
        if let limit = request.param("limit")?.int, limit > 0 {
            rows = Array(rows.prefix(Int(limit)))
        }
        return .object(["recordings": try JSONValue(encoding: rows)])
    }

    private func showResult(_ request: ControlRequest) async throws -> JSONValue {
        guard let id = requiredID(request, command: "show") else {
            throw ControlFailure(
                code: ControlErrorCode.invalidParams, message: "show needs a recording id")
        }
        let package = try await resolvePackage(id: id)
        let manifest: RecordingManifest
        do {
            manifest = try package.readManifest()
        } catch {
            throw ControlFailure(
                code: "manifest-unreadable",
                message: "\(package.folderURL.path): \(error)")
        }
        let tracks: [JSONValue] = manifest.tracks.map { track in
            .object([
                "role": .string(RecordingManifest.RecordingTrack.roleString(for: track.kind)),
                "file": .string(track.file),
                "path": .string(
                    package.folderURL.appendingPathComponent(track.file).path),
                "present": .bool(track.present),
            ])
        }
        return .object([
            "id": .string(manifest.id),
            "packagePath": .string(package.folderURL.path),
            "tracks": .array(tracks),
            "manifest": try JSONValue(encoding: manifest),
        ])
    }

    private func verifyResult(_ request: ControlRequest) async throws -> JSONValue {
        guard let id = requiredID(request, command: "verify") else {
            throw ControlFailure(
                code: ControlErrorCode.invalidParams, message: "verify needs a recording id")
        }
        let package = try await resolvePackage(id: id)
        let report = await PackageVerifier().verify(package)
        return Self.reportJSON(report)
    }

    /// The verifier's report as JSON (its type is not Codable; the wire
    /// shape is defined here, beside the command that serves it).
    private static func reportJSON(_ report: PackageVerifier.Report) -> JSONValue {
        let checks: [JSONValue] = report.trackChecks.map { check in
            .object([
                "kind": .string(check.kind.rawValue),
                "file": .string(check.file),
                "ok": .bool(check.ok),
                "skipped": .bool(check.skipped),
                "issues": .array(check.issues.map(JSONValue.string)),
            ])
        }
        return .object([
            "packageId": .string(report.packageID),
            "ok": .bool(report.ok),
            "trackChecks": .array(checks),
            "issues": .array(report.issues.map(JSONValue.string)),
        ])
    }

    private func requiredID(_ request: ControlRequest, command: String) -> String? {
        request.param("id")?.string?.nilIfEmpty
    }

    // MARK: - record.start

    private func recordStart(_ request: ControlRequest) async throws -> ControlResponse? {
        if let current = active {
            throw ControlFailure(
                code: ControlErrorCode.alreadyActive,
                message: "a recording is already active (\(current.recordingID));"
                    + " stop it first")
        }
        let sessionRequest = try await resolveSessionRequest(params: request.params)

        let session = RecordingSession(
            outputRoot: config.recordingsRoot,
            catalog: config.catalog,
            volumeProvider: config.volumeProvider,
            permissionAdvisor: config.permissionAdvisor,
            hostNowNs: config.hostNowNs,
            makeWriter: config.makeWriter)

        let startedPackage: RecordingPackage
        do {
            startedPackage = try await session.start(sessionRequest)
        } catch {
            throw Self.failure(forSessionError: error)
        }

        // Capture attaches behind the gate: pre-gate video frames are
        // cached for media time zero, pre-gate audio is discarded.
        let rig: CaptureRig
        do {
            rig = try await config.captureRigs.attach(CaptureContext(
                session: session,
                request: sessionRequest,
                package: startedPackage,
                warning: { [weak self] code, message in
                    Task { await self?.captureWarning(code: code, message: message) }
                },
                streamFailure: { [weak self] reason in
                    Task { await self?.captureStreamFailure(reason) }
                }))
        } catch {
            _ = try? await session.stopEarly(
                code: "capture-failed", message: String(describing: error))
            await upsertIndexRow(for: startedPackage)
            throw ControlFailure(
                code: "capture-failed",
                message: "capture could not start: \(error)")
        }

        // The caller owns the countdown's timing; the pipeline stays armed
        // behind the gate while it runs.
        if sessionRequest.countdownSeconds > 0 {
            try? await Task.sleep(
                nanoseconds: UInt64(sessionRequest.countdownSeconds) * 1_000_000_000)
        }
        do {
            _ = try await session.openGate()
        } catch {
            await rig.stop()
            _ = try? await session.stop()
            await upsertIndexRow(for: startedPackage)
            throw Self.failure(forSessionError: error)
        }
        await rig.gateOpened(epochHostNs: config.hostNowNs())

        let recording = ActiveRecording(
            session: session,
            rig: rig,
            package: startedPackage,
            recordingID: startedPackage.id,
            startRequestID: request.id)
        active = recording
        lastStopResult = nil
        await upsertIndexRow(for: startedPackage)

        emit(ControlEvent(
            kind: .recordingStarted,
            id: request.id,
            recordingId: recording.recordingID,
            t: 0))

        if let duration = request.param("duration")?.double, duration > 0 {
            scheduleDurationStop(seconds: duration, recordingID: recording.recordingID)
        }

        // Without wait, the response is the start result; with wait, events
        // stream first and the response is the stop outcome.
        guard request.param("wait")?.bool == true else {
            let started = StartedRecording(
                recordingID: recording.recordingID,
                packagePath: startedPackage.folderURL.path)
            return .success(id: request.id, result: try JSONValue(encoding: started))
        }
        let stopped = try await waitForCompletion(recordingID: recording.recordingID)
        return .success(id: request.id, result: try JSONValue(encoding: stopped))
    }

    // MARK: - Stop / pause / resume

    /// Stops by recording id. The id must name the active take: a finished
    /// recording cannot be stopped again (that is `not-found`, so a stale
    /// `--id` never looks like success).
    private func stopRecording(id: String) async throws -> StoppedRecording {
        guard let recording = active else {
            throw ControlFailure(
                code: ControlErrorCode.notRecording,
                message: "no recording is active")
        }
        guard recording.recordingID == id else {
            throw ControlFailure(
                code: ControlErrorCode.notFound,
                message: "recording \(id) is not the active recording"
                    + " (\(recording.recordingID))")
        }
        return try await stopActive()
    }

    private func stopActive() async throws -> StoppedRecording {
        let recording = try requireActive()
        durationTimer?.cancel()
        durationTimer = nil
        active = nil

        await recording.rig.stop()
        do {
            let outcome = try await recording.session.stop()
            return await finish(recording, outcome: outcome)
        } catch {
            let failure = Self.failure(forSessionError: error)
            resumeWaiters(with: StoppedRecording(
                failedRecordingID: recording.recordingID,
                packagePath: recording.package.folderURL.path))
            await upsertIndexRow(for: recording.package)
            throw failure
        }
    }

    /// A stream failure stops the take early and keeps the footage
    /// (docs/PLAN.md, During recording), with an `ended-early` warning.
    private func captureStreamFailure(_ reason: String) async {
        guard let recording = active else { return }
        durationTimer?.cancel()
        durationTimer = nil
        active = nil
        await recording.rig.stop()
        let outcome = try? await recording.session.stopEarly(
            code: "stream-error", message: reason)
        let result: StoppedRecording
        if let outcome {
            result = StoppedRecording(outcome: outcome)
        } else {
            result = StoppedRecording(
                failedRecordingID: recording.recordingID,
                packagePath: recording.package.folderURL.path)
        }
        lastStopResult = result
        await upsertIndexRow(for: recording.package)
        emitStopped(result, tag: recording.startRequestID)
        resumeWaiters(with: result)
    }

    private func finish(
        _ recording: ActiveRecording, outcome: SessionOutcome
    ) async -> StoppedRecording {
        let result = StoppedRecording(outcome: outcome)
        lastStopResult = result
        await upsertIndexRow(for: recording.package)
        emitStopped(result, tag: recording.startRequestID)
        resumeWaiters(with: result)
        return result
    }

    private func requireActive() throws -> ActiveRecording {
        guard let recording = active else {
            throw ControlFailure(
                code: ControlErrorCode.notRecording,
                message: "no recording is active")
        }
        return recording
    }

    private func transition(_ event: SessionTransition) async throws {
        let recording = try requireActive()
        let newState: String
        do {
            switch event {
            case .pause:
                try await recording.session.pause()
                newState = "paused"
            case .resume:
                try await recording.session.resume()
                newState = "recording"
            }
        } catch {
            throw Self.failure(forSessionError: error)
        }
        emit(ControlEvent(
            kind: .stateChanged,
            id: recording.startRequestID,
            recordingId: recording.recordingID,
            state: newState))
    }

    /// Capture-level warning: recorded into the manifest and surfaced as a
    /// `warning` event at the current media time.
    private func captureWarning(code: String, message: String?) async {
        guard let recording = active else { return }
        let snapshot = await recording.session.snapshot()
        let atMs = snapshot.elapsedMediaNs.map { Double($0) / 1_000_000 }
        await recording.session.recordWarning(code: code, message: message)
        emit(ControlEvent(
            kind: .warning,
            id: recording.startRequestID,
            recordingId: recording.recordingID,
            t: atMs,
            code: code,
            message: message))
    }

    /// Resolves `--wait` callers: the stop outcome for `recordingID`, when
    /// it stops (or has already stopped).
    private func waitForCompletion(recordingID: String) async throws -> StoppedRecording {
        if let last = lastStopResult, last.id == recordingID {
            return last
        }
        guard active?.recordingID == recordingID else {
            throw ControlFailure(
                code: ControlErrorCode.notFound,
                message: "recording \(recordingID) is not active")
        }
        return await withCheckedContinuation { continuation in
            completionWaiters.append(continuation)
        }
    }

    private func resumeWaiters(with result: StoppedRecording) {
        let waiters = completionWaiters
        completionWaiters = []
        for waiter in waiters {
            waiter.resume(returning: result)
        }
    }

    private func scheduleDurationStop(seconds: Double, recordingID: String) {
        durationTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            await self?.durationElapsed(recordingID: recordingID)
        }
    }

    private func durationElapsed(recordingID: String) async {
        guard active?.recordingID == recordingID else { return }
        _ = try? await stopActive()
    }

    // MARK: - Package resolution

    private func resolvePackage(id: String) async throws -> RecordingPackage {
        if let row = try await index.row(id: id), !row.folder.isEmpty {
            var isDirectory: ObjCBool = false
            if FileManager.default.fileExists(atPath: row.folder, isDirectory: &isDirectory),
               isDirectory.boolValue {
                return RecordingPackage(
                    root: URL(fileURLWithPath: row.folder).deletingLastPathComponent(),
                    id: id,
                    folderURL: URL(fileURLWithPath: row.folder, isDirectory: true))
            }
        }
        if let resolved = RecordingPackage.resolve(root: config.recordingsRoot, id: id) {
            return resolved
        }
        throw ControlFailure(
            code: ControlErrorCode.notFound,
            message: "no recording with id \(id) under \(config.recordingsRoot.path)")
    }

    // MARK: - Request resolution

    /// Maps socket/CLI parameters onto a `SessionRequest`, resolving
    /// "main"/"default"/"none" against the catalog and computing the
    /// screen's output size (content points times the backing scale, even,
    /// long edge at most 3840 px).
    private func resolveSessionRequest(params: [String: JSONValue]) async throws -> SessionRequest {
        func invalid(_ message: String) -> ControlFailure {
            ControlFailure(code: ControlErrorCode.invalidParams, message: message)
        }

        let displays = (try? await config.catalog.displays()) ?? []
        let cameras = (try? await config.catalog.cameras()) ?? []
        let microphones = (try? await config.catalog.microphones()) ?? []

        var request = SessionRequest()

        if let display = params["display"]?.string?.nilIfEmpty {
            guard !displays.isEmpty || display != "main" else {
                throw invalid("no display found in the catalog")
            }
            let target: DisplaySource?
            if display == "main" {
                target = displays.first(where: \.isMain) ?? displays.first
            } else {
                target = displays.first { $0.id == display }
            }
            guard let target else {
                throw ControlFailure(
                    code: PreflightFailureCode.unknownSource.rawValue,
                    message: "display \(display) is not in the catalog; run targets")
            }
            request.screen = .display(id: target.id)
            request.screenDimensions = Self.screenOutputSize(for: target)
        } else if let window = params["window"]?.string?.nilIfEmpty {
            request.screen = .window(id: window)
            // The catalog carries no window geometry; the main display's
            // output size bounds it (the stream only scales down).
            let bounds = displays.first(where: \.isMain) ?? displays.first
            request.screenDimensions = bounds.map(Self.screenOutputSize(for:))
                ?? SessionRequest.Dimensions(width: 1920, height: 1080)
        }

        if let camera = params["camera"]?.string?.nilIfEmpty {
            switch camera {
            case "none":
                break
            case "default":
                guard let first = cameras.first else {
                    throw invalid("no camera found in the catalog")
                }
                request.cameraId = first.id
            default:
                request.cameraId = camera
            }
        }
        if let mic = params["mic"]?.string?.nilIfEmpty {
            switch mic {
            case "none":
                break
            case "default":
                guard let first = microphones.first else {
                    throw invalid("no microphone found in the catalog")
                }
                request.microphoneId = first.id
            default:
                request.microphoneId = mic
            }
        }
        if let systemAudio = params["systemAudio"]?.bool {
            request.systemAudio = systemAudio
        }
        if let countdown = params["countdownSeconds"]?.int {
            guard countdown >= 0, countdown <= 10 else {
                throw invalid("countdownSeconds must be between 0 and 10")
            }
            request.countdownSeconds = Int(countdown)
        }
        if let title = params["title"]?.string?.nilIfEmpty {
            request.title = title
        }

        guard !request.trackKinds.isEmpty else {
            throw invalid(
                "nothing to record: pass a screen target (--display/--window)"
                    + " or an input (--camera/--mic/--system-audio)")
        }
        return request
    }

    /// Content points times the display's backing scale, even, capped per
    /// the plan's capture-screen rule.
    static func screenOutputSize(for display: DisplaySource) -> SessionRequest.Dimensions {
        let points = CGSize(width: display.widthPoints, height: display.heightPoints)
        let size = captureOutputSize(
            contentSize: points,
            pointPixelScale: Self.backingScale(matchingPoints: points),
            maxWidth: ScreenStreamPlan.maxLongEdgePixels,
            maxHeight: ScreenStreamPlan.maxLongEdgePixels)
        return SessionRequest.Dimensions(width: size.width, height: size.height)
    }

    private static func backingScale(matchingPoints size: CGSize) -> CGFloat {
        for screen in NSScreen.screens where screen.frame.size == size {
            return screen.backingScaleFactor
        }
        // A size no screen reports exactly is likely a window target; the
        // Retina default matches the hardware this product runs on.
        return 2
    }

    // MARK: - Index and events

    private func upsertIndexRow(for package: RecordingPackage) async {
        if let manifest = try? package.readManifest() {
            try? await index.upsert(PackageIndex.Row(entry: .init(
                package: package, manifest: manifest)))
        }
    }

    private func emit(_ event: ControlEvent) {
        eventSink?(event)
    }

    private func emitStopped(_ result: StoppedRecording, tag: String) {
        let payload = try? JSONValue(encoding: result)
        emit(ControlEvent(
            kind: .recordingStopped,
            id: tag,
            recordingId: result.id,
            result: payload))
    }

    // MARK: - Error mapping

    /// Maps a `SessionError` onto the control table's codes. Preflight
    /// codes pass through unchanged (low-disk, unknown-source,
    /// permission-denied...), so the CLI's exit-code mapping holds.
    static func failure(forSessionError error: Error) -> ControlFailure {
        guard let sessionError = error as? SessionError else {
            return ControlFailure(
                code: ControlErrorCode.internalError,
                message: String(describing: error))
        }
        switch sessionError {
        case .preflightFailed(let code, let detail):
            return ControlFailure(code: code.rawValue, message: detail)
        case .wrongState(let event, let state):
            return ControlFailure(
                code: "wrong-state",
                message: "\(event) is not allowed while \(state.rawValue)")
        case .packageCreationFailed(let reason):
            return ControlFailure(code: "package-create-failed", message: reason)
        case .logOpenFailed(let reason):
            return ControlFailure(code: "log-open-failed", message: reason)
        case .writerFailedToStart(let kind, let reason):
            return ControlFailure(
                code: "writer-failed-to-start",
                message: "\(kind.rawValue): \(reason)")
        case .clock(let clockError):
            return ControlFailure(
                code: "clock-error", message: String(describing: clockError))
        case .manifestWriteFailed(let reason):
            return ControlFailure(code: "manifest-write-failed", message: reason)
        }
    }
}

// MARK: - Small string helper

extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
