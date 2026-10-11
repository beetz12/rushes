import Foundation

/// Which macOS permission a preflight question is about. Prompting is not
/// the session's job: the shell or engine owns TCC, and this type only
/// describes the surfaces a recording touches (docs/PLAN.md, Preparing:
/// "Check permissions without prompting").
public enum PermissionKind: String, Codable, Sendable {
    case screen
    case camera
    case microphone
    case accessibility
    case inputMonitoring
}

/// One permission surface's state, with "not asked" and "denied" kept
/// separate (docs/PLAN.md, privacy-security; the Cap and OpenScreen idea).
public struct PermissionStatus: Codable, Equatable, Sendable {

    public enum State: String, Codable, Sendable {
        /// Granted (or the advisor decided capture may trigger the prompt).
        case allowed
        /// Never requested; a prompt is still possible.
        case notAsked
        /// Refused; only System Settings can change this.
        case denied
    }

    public var state: State

    /// A deep link to the right System Settings pane, surfaced after a
    /// denial (docs/PLAN.md, onboarding). Diagnostic only.
    public var settingsURL: String?

    public init(state: State, settingsURL: String? = nil) {
        self.state = state
        self.settingsURL = settingsURL
    }
}

/// The seam through which the caller answers permission questions. The
/// default says everything is allowed; the engine or shell sets a real
/// advisor that reads the preflight APIs without prompting.
public struct PermissionAdvisor: Sendable {

    public let check: @Sendable (PermissionKind) async -> PermissionStatus

    public init(check: @escaping @Sendable (PermissionKind) async -> PermissionStatus) {
        self.check = check
    }

    /// Everything allowed: the standalone Phase 1 engine's default, because
    /// starting capture itself triggers the system prompt.
    public static let allAllowed = PermissionAdvisor(check: { _ in
        PermissionStatus(state: .allowed)
    })
}

/// Free space on the volume that will hold the recording. Injectable so
/// tests can refuse a start without filling a disk.
public struct VolumeInfo: Equatable, Sendable {

    /// Bytes available for important-use writes.
    public let availableBytes: Int64

    public init(availableBytes: Int64) {
        self.availableBytes = availableBytes
    }

    /// Reads free space for the volume holding `url`, walking up to the
    /// nearest existing ancestor when the path does not exist yet (the
    /// recordings root is created on demand). Unreadable is reported as
    /// zero bytes free: a measurement failure must refuse, not pass.
    public static func current(nearestAncestorOf url: URL) -> VolumeInfo {
        let fileManager = FileManager.default
        var candidate = url
        while !fileManager.fileExists(atPath: candidate.path) {
            let parent = candidate.deletingLastPathComponent()
            if parent.path == candidate.path { break }
            candidate = parent
        }
        for path in [candidate.path, "/"] {
            if let attributes = try? fileManager.attributesOfFileSystem(forPath: path),
               let free = attributes[.systemFreeSize] as? NSNumber {
                return VolumeInfo(availableBytes: free.int64Value)
            }
        }
        return VolumeInfo(availableBytes: 0)
    }
}

/// Machine-readable reasons a preflight check refuses a start. The string
/// values are the error codes the control layer reports.
public enum PreflightFailureCode: String, Codable, Sendable {
    /// The request itself cannot describe a recording.
    case invalidRequest = "invalid-request"
    /// Another recording is already active.
    case alreadyActive = "already-active"
    /// Every requested track was switched off before the start.
    case nothingToRecord = "nothing-to-record"
    /// Less than the plan's minimum free space (2 GB).
    case lowDisk = "low-disk"
    /// The output root could not be created or written in.
    case outputNotWritable = "output-not-writable"
    /// The source catalog could not be read.
    case catalogUnavailable = "catalog-unavailable"
    /// A requested screen source (display or window) does not exist.
    case unknownSource = "unknown-source"
    /// Screen Recording was denied.
    case permissionDenied = "permission-denied"
    /// Screen Recording was never asked for.
    case permissionNotAsked = "permission-not-asked"
}

/// The outcome of one preflight check.
public struct PreflightCheck: Codable, Equatable, Sendable {

    public enum Outcome: Codable, Equatable, Sendable {
        /// The check passed.
        case ok
        /// The check refused the start; recording must not proceed.
        case failed(code: PreflightFailureCode)
    }

    /// Which check ran: "request", "already-active", "output-root",
    /// "disk-space", "sources", "permissions".
    public let name: String
    public let outcome: Outcome
    public let detail: String?

    public init(name: String, outcome: Outcome, detail: String? = nil) {
        self.name = name
        self.outcome = outcome
        self.detail = detail
    }
}

/// Everything a start attempt learned before any package was created.
///
/// A failed result carries the first refusing check; a passing result
/// carries the request with optional inputs switched off (docs/PLAN.md,
/// Preparing: a missing or denied optional input is dropped with a warning
/// and the recording still starts) plus the device names the catalog
/// resolved, for the manifest.
public struct PreflightResult: Codable, Equatable, Sendable {
    public let ok: Bool
    public let checks: [PreflightCheck]
    public let warnings: [RecordingManifest.ManifestWarning]
    /// The request as it should be recorded, nil when `ok` is false.
    public let effectiveRequest: SessionRequest?
    /// Catalog display names by source id, for the manifest's device refs.
    public let resolvedDeviceNames: [String: String]

    public init(
        ok: Bool,
        checks: [PreflightCheck],
        warnings: [RecordingManifest.ManifestWarning] = [],
        effectiveRequest: SessionRequest? = nil,
        resolvedDeviceNames: [String: String] = [:]
    ) {
        self.ok = ok
        self.checks = checks
        self.warnings = warnings
        self.effectiveRequest = effectiveRequest
        self.resolvedDeviceNames = resolvedDeviceNames
    }

    /// The first refusing check's code, or nil.
    public var failureCode: PreflightFailureCode? {
        for check in checks {
            if case .failed(let code) = check.outcome { return code }
        }
        return nil
    }

    /// The first refusing check's detail, or nil.
    public var failureDetail: String? {
        for check in checks {
            if case .failed = check.outcome { return check.detail }
        }
        return nil
    }
}

/// The checks that can run before a recording starts, without prompting
/// (docs/PLAN.md, Session states and failure rules / Preparing).
///
/// Every input is injectable: the catalog, the volume's free space, the
/// permission advisor and the output root. The struct is a value: running
/// it creates the recordings root when missing (which the package creation
/// would do anyway) and touches nothing else.
public struct Preflight: Sendable {

    /// Refuse to start below 2 GB free. Our own threshold: HEVC masters at
    /// 20 Mbit/s or more (docs/PLAN.md, Preparing; Disk use).
    public static let startFloorBytes: Int64 = 2 * 1024 * 1024 * 1024

    public let catalog: any SourceCataloging
    public let outputRoot: URL
    public let volume: VolumeInfo
    public let minimumFreeBytes: Int64
    public let permissionAdvisor: PermissionAdvisor
    public let alreadyActive: Bool

    public init(
        catalog: any SourceCataloging,
        outputRoot: URL,
        volume: VolumeInfo,
        minimumFreeBytes: Int64 = Preflight.startFloorBytes,
        permissionAdvisor: PermissionAdvisor = .allAllowed,
        alreadyActive: Bool = false
    ) {
        self.catalog = catalog
        self.outputRoot = outputRoot
        self.volume = volume
        self.minimumFreeBytes = minimumFreeBytes
        self.permissionAdvisor = permissionAdvisor
        self.alreadyActive = alreadyActive
    }

    /// Runs the checks against `request`, first refusal wins.
    public func run(request: SessionRequest) async -> PreflightResult {
        var checks: [PreflightCheck] = []
        var warnings: [RecordingManifest.ManifestWarning] = []
        var effective = request

        func refuse(
            _ code: PreflightFailureCode, _ name: String, _ detail: String
        ) -> PreflightResult {
            checks.append(PreflightCheck(name: name, outcome: .failed(code: code), detail: detail))
            return PreflightResult(ok: false, checks: checks)
        }
        func pass(_ name: String, _ detail: String? = nil) {
            checks.append(PreflightCheck(name: name, outcome: .ok, detail: detail))
        }

        // 1. The request itself describes a recordable take.
        if let failure = Self.requestProblem(in: request) {
            return refuse(.invalidRequest, "request", failure)
        }
        pass("request")

        // 2. One recording at a time.
        if alreadyActive {
            return refuse(.alreadyActive, "already-active", "another recording is active")
        }
        pass("already-active")

        // 3. The output root exists and can be written in.
        if let failure = Self.outputRootProblem(at: outputRoot) {
            return refuse(.outputNotWritable, "output-root", failure)
        }
        pass("output-root", outputRoot.path)

        // 4. Free space on the output volume.
        if volume.availableBytes < minimumFreeBytes {
            return refuse(
                .lowDisk, "disk-space",
                "\(volume.availableBytes) bytes free, \(minimumFreeBytes) required")
        }
        pass("disk-space", "\(volume.availableBytes) bytes free")

        // SCShareableContent can request screen access itself. Refuse before
        // any catalog calls so only the explicit permission command prompts.
        if effective.screen != nil {
            let permission = await permissionAdvisor.check(.screen)
            if permission.state != .allowed {
                return refuse(permission.state == .denied ? .permissionDenied : .permissionNotAsked,
                              "permissions", "grant screen recording access explicitly before recording")
            }
        }

        // 5. Requested sources exist. The screen source is the recording:
        // an unknown display or window refuses. A missing optional device
        // is switched off with a warning and the take continues.
        let displays: [DisplaySource]
        let windows: [WindowSource]
        let cameras: [CameraDevice]
        let microphones: [MicrophoneDevice]
        do {
            displays = effective.screen != nil ? try await catalog.displays() : []
            windows = effective.screen != nil ? try await catalog.windows() : []
            cameras = try await catalog.cameras()
            microphones = try await catalog.microphones()
        } catch {
            return refuse(.catalogUnavailable, "sources", String(describing: error))
        }

        switch effective.screen {
        case .display(let id), .area(let id, _):
            guard displays.contains(where: { $0.id == id }) else {
                return refuse(.unknownSource, "sources", "display \(id) is not in the catalog")
            }
        case .window(let id):
            guard windows.contains(where: { $0.id == id }) else {
                return refuse(.unknownSource, "sources", "window \(id) is not in the catalog")
            }
        case nil:
            break
        }

        var deviceNames: [String: String] = [:]
        if let cameraId = effective.cameraId {
            if let camera = cameras.first(where: { $0.id == cameraId }) {
                deviceNames[cameraId] = camera.name
            } else {
                warnings.append(RecordingManifest.ManifestWarning(
                    code: "camera-not-found",
                    message: "camera \(cameraId) is not in the catalog; recording without it"))
                effective.cameraId = nil
            }
        }
        if let microphoneId = effective.microphoneId {
            if let microphone = microphones.first(where: { $0.id == microphoneId }) {
                deviceNames[microphoneId] = microphone.name
            } else {
                warnings.append(RecordingManifest.ManifestWarning(
                    code: "microphone-not-found",
                    message: "microphone \(microphoneId) is not in the catalog; recording without it"))
                effective.microphoneId = nil
            }
        }
        pass("sources")

        // 6. Permissions, never prompting. A denied or unasked screen
        // surface refuses; a denied or unasked optional input is dropped
        // with a warning and the recording still starts.
        if effective.screen != nil {
            let status = await permissionAdvisor.check(.screen)
            switch status.state {
            case .allowed:
                break
            case .denied:
                return refuse(
                    .permissionDenied, "permissions",
                    "screen recording permission was denied"
                        + (status.settingsURL.map { "; settings: \($0)" } ?? ""))
            case .notAsked:
                return refuse(
                    .permissionNotAsked, "permissions",
                    "screen recording permission has not been asked for yet")
            }
        }
        if effective.cameraId != nil {
            let status = await permissionAdvisor.check(.camera)
            if status.state != .allowed {
                warnings.append(RecordingManifest.ManifestWarning(
                    code: "camera-off-permission",
                    message: "camera permission is \(status.state.rawValue); recording without camera"))
                effective.cameraId = nil
            }
        }
        if effective.microphoneId != nil {
            let status = await permissionAdvisor.check(.microphone)
            if status.state != .allowed {
                warnings.append(RecordingManifest.ManifestWarning(
                    code: "microphone-off-permission",
                    message: "microphone permission is \(status.state.rawValue); recording without microphone"))
                effective.microphoneId = nil
            }
        }
        pass("permissions")

        // Every input was dropped: nothing would be recorded.
        if effective.trackKinds.isEmpty {
            return refuse(
                .nothingToRecord, "sources",
                "every requested input was unavailable; nothing to record")
        }

        return PreflightResult(
            ok: true,
            checks: checks,
            warnings: warnings,
            effectiveRequest: effective,
            resolvedDeviceNames: deviceNames)
    }

    /// Shape problems in the request itself, or nil when it is recordable.
    private static func requestProblem(in request: SessionRequest) -> String? {
        if request.trackKinds.isEmpty {
            return "the request asks for no track"
        }
        if let dimensions = request.screenDimensions {
            if request.screen == nil {
                return "screen dimensions without a screen target"
            }
            if dimensions.width <= 0 || dimensions.height <= 0 {
                return "screen dimensions must be positive"
            }
        } else if request.screen != nil {
            return "a screen target needs output dimensions"
        }
        if let dimensions = request.cameraDimensions,
           dimensions.width <= 0 || dimensions.height <= 0 {
            return "camera dimensions must be positive"
        }
        if request.countdownSeconds < 0 {
            return "countdown seconds must not be negative"
        }
        return nil
    }

    /// Creates the output root when missing and probes it with a real
    /// write; returns the problem, or nil when the root is writable.
    private static func outputRootProblem(at root: URL) -> String? {
        do {
            try FileManager.default.createDirectory(
                at: root, withIntermediateDirectories: true)
        } catch {
            return "could not create \(root.path): \(error)"
        }
        let probe = root.appendingPathComponent(".preflight-probe-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: probe.path, contents: Data([0x70])) else {
            return "could not write in \(root.path)"
        }
        try? FileManager.default.removeItem(at: probe)
        return nil
    }
}
