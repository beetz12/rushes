import AppKit
import CoreGraphics
import Darwin
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
    public var permissionRequester: @Sendable (PermissionKind) async -> PermissionStatus
    public var shellBundleID: String?
    public var makeWriter: TrackWriterOpener
    public var captureRigs: CaptureRigFactory
    public var hostNowNs: @Sendable () -> Int64
    public var version: String
    /// Echoed inside the guide so a reader knows where this engine listens.
    public var socketPath: String
    /// Where `selftest sync` keeps the measured system-audio latency.
    public var selftestLatencyURL: URL
    /// Builds the selftest's signal emitter. Injectable so the suite runs the
    /// command path headless (a no-op signal) without flashing a window or
    /// playing a tone on the test machine.
    public var makeSelftestSignal: @Sendable () -> any SelftestSignaling

    public init(
        recordingsRoot: URL = RecordingPackage.defaultRoot,
        indexDatabaseURL: URL = PackageIndex.defaultDatabaseURL,
        catalog: any SourceCataloging = SystemSourceCatalog(),
        volumeProvider: @escaping @Sendable (URL) -> VolumeInfo = {
            VolumeInfo.current(nearestAncestorOf: $0)
        },
        permissionAdvisor: PermissionAdvisor = .allAllowed,
        permissionRequester: @escaping @Sendable (PermissionKind) async -> PermissionStatus = { SystemPermissions.check($0) },
        shellBundleID: String? = nil,
        makeWriter: @escaping TrackWriterOpener = { configuration, clock in
            try TrackWriter(configuration: configuration, clock: clock)
        },
        captureRigs: CaptureRigFactory = ProductionCaptureRigFactory(),
        hostNowNs: @escaping @Sendable () -> Int64 = {
            Int64(DispatchTime.now().uptimeNanoseconds)
        },
        version: String = "0.1.0-dev",
        socketPath: String = "",
        selftestLatencyURL: URL = SelftestLatencyStore.defaultURL,
        makeSelftestSignal: @escaping @Sendable () -> any SelftestSignaling = { SelftestSignalEmitter() }
    ) {
        self.recordingsRoot = recordingsRoot
        self.indexDatabaseURL = indexDatabaseURL
        self.catalog = catalog
        self.volumeProvider = volumeProvider
        self.permissionAdvisor = permissionAdvisor
        self.permissionRequester = permissionRequester
        self.shellBundleID = shellBundleID
        self.makeWriter = makeWriter
        self.captureRigs = captureRigs
        self.hostNowNs = hostNowNs
        self.version = version
        self.socketPath = socketPath
        self.selftestLatencyURL = selftestLatencyURL
        self.makeSelftestSignal = makeSelftestSignal
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
    private var previewEnabled = false
    private var silentMicReported = false
    private var starting = false
    private var finishing = false
    private var startGeneration = UUID()
    private var lastStartParams: [String: JSONValue] = [:]
    private var durationTimer: Task<Void, Never>?
    private var maintenanceTimer: Task<Void, Never>?
    private var activity: NSObjectProtocol?
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
        let result = active != nil ? try? await stopActive() : nil
        await config.captureRigs.stopPreview()
        return result
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
        case "permissions.check":
            return .success(id: request.id, result: await permissionsResult())
        case "permissions.request":
            let kind = try permissionKind(request)
            _ = await config.permissionRequester(kind)
            return .success(id: request.id, result: await permissionsResult())
        case "permissions.settings":
            return .success(id: request.id, result: .object(["url": .string(SystemPermissions.settingsURL(try permissionKind(request)))]))
        case "camera.preview.start":
            guard !starting, active == nil else { throw ControlFailure(code: "wrong-state", message: "preview selection cannot change during a take") }
            let camera = request.param("camera")?.string ?? "default"
            let catalog = try await config.catalog.cameras()
            let id = camera == "default" ? catalog.first?.id : camera
            guard let id else { throw ControlFailure(code: "camera-not-found", message: "no camera found") }
            let permission = await config.permissionAdvisor.check(.camera)
            guard permission.state == .allowed else { throw ControlFailure(code: "permission-denied", message: "grant camera access first") }
            previewEnabled = true
            let preview = previewPublisher()
            let result = try await config.captureRigs.warmCamera(cameraID: id, preview: preview, warning: { _, _ in })
            return .success(id: request.id, result: result)
        case "camera.preview.stop":
            guard active == nil else { throw ControlFailure(code: "wrong-state", message: "camera is recording") }
            previewEnabled = false
            await config.captureRigs.stopPreview()
            return .success(id: request.id)
        case "record.mute":
            let recording = try requireActive()
            let track = request.param("track")?.string
            guard let kind: TrackKind = track == "microphone" ? .microphone : (track == "systemAudio" ? .systemAudio : nil),
                  let muted = request.param("muted")?.bool else { throw ControlFailure(code: "invalid-params", message: "mute needs track microphone|systemAudio and muted Boolean") }
            try await recording.session.setMuted(muted, for: kind)
            return .success(id: request.id, result: .object(["track": .string(track), "muted": .bool(muted)]))
        case "record.bubble":
            let recording = try requireActive()
            guard let center = request.param("center")?.array?.compactMap(\.double), center.count == 2,
                  center.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { throw ControlFailure(code: "invalid-params", message: "bubble center needs two fractions between 0 and 1") }
            let size = Int(request.param("size")?.int ?? 200)
            guard [160, 200, 280].contains(size) else { throw ControlFailure(code: "invalid-params", message: "bubble size must be 160, 200 or 280") }
            try await recording.session.setBubble(BubbleMetadata(center: center, size: size, visible: request.param("visible")?.bool ?? true))
            return .success(id: request.id)
        case "record.cancel":
            startGeneration = UUID()
            if let current = active, await current.session.state == .armed {
                _ = try await discardActive()
            } else if active != nil {
                throw ControlFailure(code: "wrong-state", message: "cancel applies during countdown; use discard for an active take")
            }
            return .success(id: request.id, result: .object(["state": .string("idle")]))
        case "record.discard":
            startGeneration = UUID()
            return .success(id: request.id, result: try await discardActive())
        case "record.restart":
            let params = lastStartParams
            guard !params.isEmpty else { throw ControlFailure(code: "not-recording", message: "no prior take to restart") }
            startGeneration = UUID()
            if active != nil { _ = try await discardActive() }
            return try await recordStart(ControlRequest(id: request.id, cmd: "record.start", args: .object(params)))
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
        case "selftest.sync":
            return try await selftestSyncResult(request)
        case "analyze.clap":
            return .success(id: request.id, result: try await analyzeClapResult(request))
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
                "state": .string(starting ? "preparing" : (finishing ? "finishing" : "idle")),
                "permissions": await permissionsResult(),
                "version": .string(config.version),
                "pid": .int(Int64(getpid())),
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

    // MARK: - selftest sync

    /// Runs the whole selftest take in the engine process (docs/PLAN.md,
    /// Roadmap Phase 1 item 9): record the main display plus system audio in
    /// selftest mode (the stream includes the engine's own flash window and
    /// its own tone), flash and tone together twice - once before the pause,
    /// once after it - stop, measure both files, apply the stored latency and
    /// report the residuals. The freshly measured latency is stored for the
    /// next run after this run's offsets are computed, so a run always tests
    /// against what a previous run measured, never against itself.
    private func selftestSyncResult(_ request: ControlRequest) async throws -> ControlResponse? {
        guard active == nil else {
            throw ControlFailure(
                code: ControlErrorCode.alreadyActive,
                message: "a recording is already active; stop it before running the selftest")
        }
        func invalid(_ message: String) -> ControlFailure {
            ControlFailure(code: ControlErrorCode.invalidParams, message: message)
        }
        let seconds = request.param("seconds")?.double ?? 20
        guard request.param("seconds") == nil || request.param("seconds")?.double != nil else { throw invalid("seconds must be numeric") }
        guard seconds.isFinite, seconds >= 6, seconds <= 600 else {
            throw invalid("seconds must be between 6 and 600")
        }
        // `--pause-at S` (optionally a list): the media second at which the
        // shared clock pauses for three seconds.
        let pauseAtSeconds: Double?
        if let pauseParam = request.param("pauseAt")?.string?.nilIfEmpty {
            guard let first = pauseParam.split(separator: ",").first,
                  let value = Double(first), value > 1, value < seconds - 3 else {
                throw invalid("pauseAt must name a second between 1 and seconds-3")
            }
            pauseAtSeconds = value
        } else if let value = request.param("pauseAt")?.double {
            guard value > 1, value < seconds - 3 else {
                throw invalid("pauseAt must name a second between 1 and seconds-3")
            }
            pauseAtSeconds = value
        } else {
            pauseAtSeconds = nil
        }
        let pauseLengthSeconds: Double = 3

        // The take: display + system audio only; the selftest flag opens the
        // filter and the system-audio stream to our own window and tone.
        let startRequest = ControlRequest(
            id: request.id, cmd: "record.start",
            args: .object([
                "display": .string("main"),
                "systemAudio": .bool(true),
                "selftest": .bool(true),
                "title": .string("selftest sync"),
                "wait": .bool(false),
            ]))
        _ = try await recordStart(startRequest)
        guard let recording = active else {
            throw ControlFailure(
                code: ControlErrorCode.internalError,
                message: "the selftest take did not stay active")
        }

        // Schedule on the host clock. Flash targets sit well clear of the
        // pause edges, and the stop lands at a media duration of `seconds`.
        let snapshot = await recording.session.snapshot()
        let epochHostNs = snapshot.epochHostNs ?? config.hostNowNs()
        let flashPreOffset: Double
        let pauseStartOffset: Double?
        let flashPostOffset: Double
        let stopOffset: Double
        if let pauseAt = pauseAtSeconds {
            flashPreOffset = min(2.5, max(1.0, pauseAt - 2.5))
            pauseStartOffset = pauseAt
            flashPostOffset = pauseAt + pauseLengthSeconds + 2
            stopOffset = pauseAt + pauseLengthSeconds + (seconds - pauseAt)
        } else {
            flashPreOffset = seconds * 0.35
            pauseStartOffset = nil
            flashPostOffset = seconds * 0.75
            stopOffset = seconds
        }

        func sleepUntil(hostNs: Int64) async {
            let remaining = hostNs - config.hostNowNs()
            if remaining > 0 {
                try? await Task.sleep(nanoseconds: UInt64(remaining))
            }
        }

        // Prepare the signal before committing to the schedule: an engine
        // with no audio output must fail the selftest, not the take.
        let emitter = config.makeSelftestSignal()
        do {
            try emitter.prepare()
        } catch {
            _ = try? await stopActive()
            throw ControlFailure(
                code: "selftest-signal-failed", message: String(describing: error))
        }

        let preFlashHostNs = epochHostNs + Int64(flashPreOffset * 1e9)
        let postFlashHostNs = epochHostNs + Int64(flashPostOffset * 1e9)
        await sleepUntil(hostNs: preFlashHostNs - 300_000_000)
        emitter.fire(atHostNs: preFlashHostNs)

        if let pauseStart = pauseStartOffset {
            await sleepUntil(hostNs: epochHostNs + Int64(pauseStart * 1e9))
            try? await transition(.pause)
            await sleepUntil(hostNs: epochHostNs + Int64((pauseStart + pauseLengthSeconds) * 1e9))
            try? await transition(.resume)
        }

        await sleepUntil(hostNs: postFlashHostNs - 300_000_000)
        emitter.fire(atHostNs: postFlashHostNs)
        await sleepUntil(hostNs: epochHostNs + Int64(stopOffset * 1e9))

        let stopped: StoppedRecording
        do {
            stopped = try await stopActive()
        } catch {
            emitter.stop()
            throw error
        }
        emitter.stop()

        // Measure off the actor: AVAssetReader work must not block commands.
        let screenURL = recording.package.trackURL(for: .screen)
        let systemURL = recording.package.trackURL(for: .systemAudio)
        let clock: SessionClock
        if let manifestClock = (try? recording.package.readManifest())?.clock {
            clock = manifestClock.sessionClock
        } else {
            clock = SessionClock(epochNs: epochHostNs)
        }
        func mediaMs(ofHostNs hostNs: Int64) -> Double {
            Double(clock.mediaTimeNs(atHostNs: hostNs)) / 1_000_000
        }
        let preFlashMediaMs = mediaMs(ofHostNs: preFlashHostNs)
        let postFlashMediaMs = mediaMs(ofHostNs: postFlashHostNs)
        let preWindow = ClosedRange(
            uncheckedBounds: (preFlashMediaMs - 200, preFlashMediaMs + 1_200))
        let postWindow = ClosedRange(
            uncheckedBounds: (postFlashMediaMs - 200, postFlashMediaMs + 1_200))

        let measurement: SelftestSyncMeasurement
        do {
            measurement = try await Task.detached(priority: .userInitiated) {
                try await SelftestSyncMeasurement.measure(
                    screenURL: screenURL,
                    systemAudioURL: systemURL,
                    preWindowMs: preWindow,
                    postWindowMs: postWindow)
            }.value
        } catch {
            throw ControlFailure(
                code: "selftest-measurement-failed", message: String(describing: error))
        }
        guard measurement.complete else {
            func text(_ value: Double?) -> String {
                value.map { String(format: "%.1f", $0) } ?? "nil"
            }
            let detail = "pre flash=\(text(measurement.pre.flashMs))"
                + " tone=\(text(measurement.pre.toneMs));"
                + " post flash=\(text(measurement.post.flashMs))"
                + " tone=\(text(measurement.post.toneMs))"
            throw ControlFailure(
                code: "selftest-measurement-failed",
                message: "the flash or the tone was not found in the recorded files: \(detail)")
        }

        // Apply the previously stored latency, then store the fresh one.
        let store = SelftestLatencyStore(url: config.selftestLatencyURL)
        let appliedLatencyMs = store.load()?.systemAudioLatencyMs ?? 0
        let measuredLatencyMs = (
            (measurement.pre.rawOffsetMs ?? 0) + (measurement.post.rawOffsetMs ?? 0)) / 2
        var report = SelftestSyncReport(
            recordingId: stopped.id,
            packagePath: stopped.packagePath,
            measurement: measurement,
            appliedLatencyMs: appliedLatencyMs,
            measuredLatencyMs: measuredLatencyMs)
        report.pass = report.pass && stopped.status == RecordingManifest.Status.complete.rawValue
        if var manifest = try? recording.package.readManifest() {
            if let index = manifest.tracks.firstIndex(where: { $0.kind == .systemAudio }) {
                manifest.tracks[index].latencyMs = Int(measuredLatencyMs.rounded())
            }
            try? recording.package.writeManifest(manifest)
            await upsertIndexRow(for: recording.package)
        }
        try? store.save(SelftestLatencyStore.Stored(
            systemAudioLatencyMs: measuredLatencyMs,
            measuredAt: ISO8601DateFormatter().string(from: Date()),
            recordingId: stopped.id))
        return .success(id: request.id, result: try JSONValue(encoding: report))
    }

    // MARK: - analyze clap

    /// Camera-versus-microphone offset of a finished recording: claps are
    /// audio attacks in `mic.mov`, each matched with the strongest
    /// frame-to-frame change in `camera.mov` near it
    /// (docs/PLAN.md, Roadmap Phase 1 item 9).
    private func analyzeClapResult(_ request: ControlRequest) async throws -> JSONValue {
        guard let id = requiredID(request, command: "analyze clap") else {
            throw ControlFailure(
                code: ControlErrorCode.invalidParams, message: "analyze clap needs a recording id")
        }
        let package = try await resolvePackage(id: id)
        let cameraURL = package.trackURL(for: .camera)
        let microphoneURL = package.trackURL(for: .microphone)
        for (url, name) in [(cameraURL, "camera.mov"), (microphoneURL, "mic.mov")] {
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw ControlFailure(
                    code: ControlErrorCode.notFound,
                    message: "\(name) is missing in \(package.folderURL.path)")
            }
        }
        let analysis: ClapAnalysis
        do {
            analysis = try await Task.detached(priority: .userInitiated) {
                try await ClapAnalysis.analyze(
                    cameraURL: cameraURL, microphoneURL: microphoneURL)
            }.value
        } catch {
            throw ControlFailure(
                code: "clap-analysis-failed", message: String(describing: error))
        }
        return try JSONValue(encoding: analysis)
    }

    // MARK: - record.start

    private func recordStart(_ request: ControlRequest) async throws -> ControlResponse? {
        guard !starting, !finishing else { throw ControlFailure(code: "already-active", message: "a take is preparing or finishing") }
        if let current = active {
            throw ControlFailure(
                code: ControlErrorCode.alreadyActive,
                message: "a recording is already active (\(current.recordingID));"
                    + " stop it first")
        }
        starting = true
        let generation = UUID()
        startGeneration = generation
        defer { starting = false }
        lastStartParams = request.params.filter { $0.key != "wait" }
        if let duration = request.param("duration") {
            guard let value = duration.double, value.isFinite, value > 0, value <= 86_400 else {
                throw ControlFailure(code: "invalid-params", message: "duration must be a finite number between 0 and 86400 seconds")
            }
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
                request: await session.effectiveRequest() ?? sessionRequest,
                package: startedPackage,
                selftest: request.param("selftest")?.bool == true,
                shellBundleID: config.shellBundleID,
                preview: previewPublisher(),
                warning: { [weak self] code, message in
                    Task {
                        await session.recordWarning(code: code, message: message)
                        await self?.publishCaptureWarning(code: code, message: message)
                    }
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

        guard startGeneration == generation else {
            await rig.stop()
            _ = try? await session.stop()
            try? FileManager.default.removeItem(at: startedPackage.folderURL)
            throw ControlFailure(code: "cancelled", message: "recording start cancelled")
        }
        let recording = ActiveRecording(session: session, rig: rig, package: startedPackage,
                                        recordingID: startedPackage.id, startRequestID: request.id)
        active = recording
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "Recording a Rushes video")
        lastStopResult = nil
        silentMicReported = false
        emit(ControlEvent(kind: .stateChanged, id: request.id, recordingId: recording.recordingID, state: "armed"))

        // The caller owns the countdown's timing; the pipeline stays armed
        // behind the gate while it runs.
        let countdownEnd = config.hostNowNs() + Int64(sessionRequest.countdownSeconds) * 1_000_000_000
        if sessionRequest.countdownSeconds > 0 {
            for remaining in stride(from: sessionRequest.countdownSeconds, through: 1, by: -1) {
                guard startGeneration == generation else { break }
                emit(ControlEvent(kind: .countdown, id: request.id, recordingId: recording.recordingID,
                                  result: .object(["remaining": .int(Int64(remaining))])))
                let target = countdownEnd - Int64(remaining - 1) * 1_000_000_000
                if target > config.hostNowNs() { try? await Task.sleep(nanoseconds: UInt64(target - config.hostNowNs())) }
            }
        }
        emit(ControlEvent(kind: .countdown, id: request.id, recordingId: recording.recordingID, result: .object(["remaining": .int(0)])))
        guard startGeneration == generation, active?.recordingID == recording.recordingID else {
            throw ControlFailure(code: "cancelled", message: "countdown cancelled")
        }
        let epoch: Int64
        do {
            epoch = try await session.openGate(atHostNs: sessionRequest.countdownSeconds > 0 ? countdownEnd : nil)
        } catch {
            await rig.stop()
            _ = try? await session.stop()
            await upsertIndexRow(for: startedPackage)
            throw Self.failure(forSessionError: error)
        }
        await rig.gateOpened(epochHostNs: epoch)
        scheduleMaintenance(recordingID: recording.recordingID)
        starting = false

        emit(ControlEvent(
            kind: .recordingStarted,
            id: request.id,
            recordingId: recording.recordingID,
            t: 0))
        await upsertIndexRow(for: startedPackage)

        if let duration = request.param("duration")?.double, duration > 0 {
            scheduleDurationStop(seconds: duration, recordingID: recording.recordingID, epochHostNs: epoch)
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
        maintenanceTimer?.cancel()
        maintenanceTimer = nil
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
        active = nil
        finishing = true
        defer { finishing = false }

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
        maintenanceTimer?.cancel()
        maintenanceTimer = nil
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
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
        let report = await PackageVerifier().verify(recording.package)
        if var manifest = try? recording.package.readManifest() {
            manifest.verified = RecordingManifest.VerificationStamp(at: ISO8601DateFormatter().string(from: Date()), ok: report.ok)
            try? recording.package.writeManifest(manifest)
        }
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
        if let clock = await recording.session.currentClock() { await recording.rig.adoptClock(clock) }
        emit(ControlEvent(
            kind: .stateChanged,
            id: recording.startRequestID,
            recordingId: recording.recordingID,
            state: newState))
    }

    private func publishCaptureWarning(code: String, message: String?) async {
        if code == "camera-lost", let recording = active { await recording.session.endCameraAtLoss() }
        emit(ControlEvent(kind: .warning, recordingId: active?.recordingID, code: code, message: message))
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

    private func scheduleMaintenance(recordingID: String) {
        maintenanceTimer = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 100_000_000) } catch { break }
                await self?.maintain(recordingID: recordingID)
            }
        }
    }

    private func maintain(recordingID: String) async {
        guard let recording = active, recording.recordingID == recordingID else { return }
        for kind in [TrackKind.microphone, .systemAudio] {
            await recording.session.trackWriter(for: kind)?.tick(nowHostNs: config.hostNowNs())
        }
        if config.volumeProvider(config.recordingsRoot).availableBytes < 1024 * 1024 * 1024 {
            await captureStreamFailure("less than 1 GB free; saved footage before disk fills")
            return
        }
        let snapshot = await recording.session.snapshot()
        if !silentMicReported, snapshot.tracks.contains(where: { $0.kind == .microphone && $0.microphoneSilent == true }) {
            silentMicReported = true
            await captureWarning(code: "mic-silent", message: "microphone has been near digital silence for three seconds")
        }
        if let failed = snapshot.tracks.first(where: { $0.errorDescription != nil }) {
            await captureStreamFailure("\(failed.kind.rawValue) writer: \(failed.errorDescription ?? "failed")")
        }
    }

    private func scheduleDurationStop(seconds: Double, recordingID: String, epochHostNs: Int64) {
        let remaining = max(0, epochHostNs + Int64(seconds * 1e9) - config.hostNowNs())
        durationTimer = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remaining))
            await self?.durationElapsed(recordingID: recordingID)
        }
    }

    private func durationElapsed(recordingID: String) async {
        guard active?.recordingID == recordingID else { return }
        _ = try? await stopActive()
    }

    private func discardActive() async throws -> JSONValue {
        let recording = try requireActive()
        let result = try await stopActive()
        try FileManager.default.removeItem(at: recording.package.folderURL)
        _ = try await index.rebuild(root: config.recordingsRoot)
        return .object(["id": .string(result.id), "discarded": .bool(true), "state": .string("idle")])
    }

    private func previewPublisher() -> @Sendable (Data) -> Void {
        let sink = previewEnabled ? eventSink : nil
        return { jpeg in
            sink?(ControlEvent(kind: .cameraPreview, result: .object([
                "jpeg": .string(jpeg.base64EncodedString()), "mime": .string("image/jpeg"), "mirrored": .bool(true)])))
        }
    }

    private func permissionKind(_ request: ControlRequest) throws -> PermissionKind {
        guard let text = request.param("permission")?.string, let kind = PermissionKind(rawValue: text) else {
            throw ControlFailure(code: "invalid-params", message: "unknown permission")
        }
        return kind
    }

    private func permissionsResult() async -> JSONValue {
        var values: [String: JSONValue] = [:]
        var details: [String: JSONValue] = [:]
        for kind in [PermissionKind.screen, .camera, .microphone, .accessibility, .inputMonitoring] {
            let status = await config.permissionAdvisor.check(kind)
            values[kind.rawValue] = .string(SystemPermissions.wireState(status.state))
            details[kind.rawValue] = .object(["settingsURL": .string(status.settingsURL), "relaunchRequired": .bool(kind == .screen && status.state != .allowed)])
        }
        values["details"] = .object(details)
        return .object(values)
    }

    private static func windowRect(_ id: String) -> CGRect? {
        guard let number = UInt32(id.replacingOccurrences(of: "window-", with: "")),
              let rows = CGWindowListCopyWindowInfo(.optionIncludingWindow, number) as? [[String: Any]],
              let bounds = rows.first?[kCGWindowBounds as String] as? [String: Any] else { return nil }
        return CGRect(dictionaryRepresentation: bounds as CFDictionary)
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

        for key in ["display", "window", "camera", "mic", "cursor", "title"] {
            if let raw = params[key], raw.string == nil { throw invalid("\(key) must be a string") }
        }
        for key in ["systemAudio", "wait", "selftest"] {
            if let raw = params[key], raw.bool == nil { throw invalid("\(key) must be Boolean") }
        }
        if params["display"] != nil && params["window"] != nil { throw invalid("choose display or window") }
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
            if let rect = Self.windowRect(window) {
                let size = captureOutputSize(contentSize: rect.size, pointPixelScale: Self.backingScale(matchingPoints: rect.size), maxWidth: 3840, maxHeight: 3840)
                request.screenDimensions = .init(width: size.width, height: size.height)
            } else { throw invalid("window is unavailable") }
        }

        if let area = params["area"]?.object {
            guard params["window"] == nil, let x = area["x"]?.double, let y = area["y"]?.double,
                  let width = area["width"]?.double, let height = area["height"]?.double,
                  [x,y,width,height].allSatisfy(\.isFinite), width > 0, height > 0 else { throw invalid("area needs finite x,y,width,height") }
            let display = params["display"]?.string ?? "main"
            guard let target = display == "main" ? (displays.first(where: \.isMain) ?? displays.first) : displays.first(where: { $0.id == display }) else { throw invalid("no area display found") }
            let id = UInt32(target.id.replacingOccurrences(of: "display-", with: "")) ?? CGMainDisplayID()
            let frame = CGDisplayBounds(id)
            guard let rect = AreaRectMath.clamp(CGRect(x: x, y: y, width: width, height: height), toDisplay: frame) else { throw invalid("area lies outside display") }
            request.screen = .area(displayID: target.id, rect: CaptureArea(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height))
            let size = AreaRectMath.outputSize(area: rect, pointPixelScale: Self.backingScale(matchingPoints: frame.size))
            request.screenDimensions = .init(width: size.width, height: size.height)
        }
        if let cursor = params["cursor"]?.string {
            guard ["baked", "data"].contains(cursor) else { throw invalid("cursor must be baked or data") }
            request.cursor = cursor
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
        if let rawCountdown = params["countdownSeconds"] {
            guard let countdown = rawCountdown.int, countdown >= 0, countdown <= 10 else {
                throw invalid("countdownSeconds must be between 0 and 10")
            }
            request.countdownSeconds = Int(rawCountdown.int!)
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
