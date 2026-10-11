import Foundation

/// The manifest of one recording package: `manifest.json`
/// (docs/PLAN.md, manifest.json).
///
/// The manifest is written at start with status `recording` before the gate
/// opens (the Cap idea), rewritten with the epoch when it opens, and written
/// again at stop, during recovery, and after the decode test. It is the
/// source of truth; the SQLite index is a cache that can always be rebuilt
/// from it.
///
/// Decoding is tolerant of missing fields (defaults) and unknown fields, and
/// forward-only on the schema: a manifest whose `schema` string is newer than
/// the one this build understands is rejected rather than half-loaded.
public struct RecordingManifest: Equatable, Sendable {

    /// `rushes.recording/1`. Bumped only when a load-time migration is added.
    public static let currentSchema = "rushes.recording/1"

    /// Life-cycle states (docs/PLAN.md, Rules). Statuses `recording` and
    /// `finishing` mean the take was interrupted: no live session owns them
    /// any more, so launch-time recovery claims the package.
    public enum Status: String, Codable, Equatable, Sendable {
        case preparing
        case recording
        case finishing
        case complete
        case recovered
        case failed

        /// Whether a package left in this state at launch was interrupted.
        public var isInterrupted: Bool {
            self == .recording || self == .finishing
        }
    }

    /// Problems building a manifest from bytes.
    public enum ManifestError: Error, Equatable, Sendable {
        /// The schema string is not the one this build understands. Older
        /// manifests do not exist yet; anything else is from the future and
        /// is rejected whole (forward-only versioning).
        case unsupportedSchema(found: String?, expected: String)
        case missingIdentifier
        case unreadable(detail: String)
    }

    // MARK: - Nested types

    /// The recording clock as stored in the manifest: the epoch (host time
    /// where media time zero sits), the total media duration, and the
    /// completed pauses as host-time [start, end] pairs.
    public struct ManifestClock: Equatable, Sendable {
        public var epochHostNs: Int64
        public var durationNs: Int64?
        public var pausesNs: [[Int64]]

        /// Captures a `SessionClock` (epoch and pauses) plus a duration.
        public init(clock: SessionClock, durationNs: Int64?) {
            self.init(epochHostNs: clock.epochNs, durationNs: durationNs,
                      pausesNs: clock.pauses.map { [$0.startNs, $0.endNs] })
        }

        public init(epochHostNs: Int64, durationNs: Int64?, pausesNs: [[Int64]]) {
            self.epochHostNs = epochHostNs
            self.durationNs = durationNs
            self.pausesNs = pausesNs
        }

        /// The stored state as a live `SessionClock` (no open pause: a
        /// manifest only exists for a settled or crashed take).
        public var sessionClock: SessionClock {
            var clock = SessionClock(epochNs: epochHostNs)
            for pair in pausesNs.sorted(by: { ($0.first ?? 0) < ($1.first ?? 0) }) {
                guard pair.count == 2 else { continue }
                let start = pair[0]
                let end = pair[1]
                guard end > start, start >= epochHostNs else { continue }
                try? clock.beginPause(nowNs: start)
                try? clock.endPause(nowNs: end)
            }
            return clock
        }
    }

    /// The app build that wrote the manifest.
    public struct AppInfo: Equatable, Sendable {
        public var version: String
        public var build: Int?

        public init(version: String, build: Int? = nil) {
            self.version = version
            self.build = build
        }
    }

    /// The capture source ids used for the take, as produced by the catalog.
    public struct RecordingSources: Equatable, Sendable {
        public var mode: String?
        public var displayId: String?
        public var windowId: String?
        public var cameraId: String?
        public var microphoneId: String?
        public var systemAudio: Bool

        public init(
            mode: String? = nil,
            displayId: String? = nil,
            windowId: String? = nil,
            cameraId: String? = nil,
            microphoneId: String? = nil,
            systemAudio: Bool = false
        ) {
            self.mode = mode
            self.displayId = displayId
            self.windowId = windowId
            self.cameraId = cameraId
            self.microphoneId = microphoneId
            self.systemAudio = systemAudio
        }
    }

    /// One media file of the package. `present` records whether the file is
    /// expected on disk; recovery clears it for files that vanished, and the
    /// session layer clears it for inputs that never started.
    public struct RecordingTrack: Equatable, Sendable {
        public var kind: TrackKind
        public var file: String
        public var present: Bool
        public var codec: String?
        public var width: Int?
        public var height: Int?
        public var fps: Int?
        public var sampleRate: Int?
        public var channels: Int?
        /// Where the file's media time zero sits relative to the epoch.
        /// Zero by construction; kept so a future change or an imported file
        /// can carry a real offset without a schema change.
        public var offsetNs: Int64
        /// `offsetNs` rounded to whole milliseconds (OpenScreen's integer
        /// lesson: a fractional offset once failed an integer schema).
        public var offsetMs: Int
        /// When the device actually delivered its first sample (diagnostics).
        public var firstSampleNs: Int64?
        public var latencyMs: Int?
        public var droppedFrames: Int64?
        public var device: DeviceRef?

        public init(
            kind: TrackKind,
            file: String? = nil,
            present: Bool = true,
            codec: String? = nil,
            width: Int? = nil,
            height: Int? = nil,
            fps: Int? = nil,
            sampleRate: Int? = nil,
            channels: Int? = nil,
            offsetNs: Int64 = 0,
            firstSampleNs: Int64? = nil,
            latencyMs: Int? = nil,
            droppedFrames: Int64? = nil,
            device: DeviceRef? = nil
        ) {
            self.kind = kind
            self.file = file ?? RecordingPackage.trackFileName(for: kind)
            self.present = present
            self.codec = codec
            self.width = width
            self.height = height
            self.fps = fps
            self.sampleRate = sampleRate
            self.channels = channels
            self.offsetNs = offsetNs
            self.offsetMs = Self.milliseconds(fromNs: offsetNs)
            self.firstSampleNs = firstSampleNs
            self.latencyMs = latencyMs
            self.droppedFrames = droppedFrames
            self.device = device
        }

        /// Whole milliseconds for a nanosecond offset, round-half-away from
        /// zero on the magnitude.
        static func milliseconds(fromNs ns: Int64) -> Int {
            let quotient = ns / 1_000_000
            let remainder = ns % 1_000_000
            var result = Int(quotient)
            if remainder >= 500_000 { result += 1 }
            if remainder <= -500_000 { result -= 1 }
            return result
        }
    }

    /// A capture device reference for a track.
    public struct DeviceRef: Equatable, Sendable {
        public var uniqueId: String
        public var modelId: String?
        public var name: String?

        public init(uniqueId: String, modelId: String? = nil, name: String? = nil) {
            self.uniqueId = uniqueId
            self.modelId = modelId
            self.name = name
        }
    }

    /// The input timeline block.
    public struct RecordingInput: Equatable, Sendable {
        public var file: String
        public var pointer: Bool
        public var keys: Bool

        public init(file: String = "input.ndjson", pointer: Bool = true, keys: Bool = false) {
            self.file = file
            self.pointer = pointer
            self.keys = keys
        }
    }

    /// One recorded warning.
    public struct ManifestWarning: Equatable, Sendable {
        public var code: String
        public var atMs: Int?
        public var message: String?

        public init(code: String, atMs: Int? = nil, message: String? = nil) {
            self.code = code
            self.atMs = atMs
            self.message = message
        }
    }

    /// The result of the post-stop decode test.
    public struct VerificationStamp: Equatable, Sendable {
        public var at: String
        public var ok: Bool

        public init(at: String, ok: Bool) {
            self.at = at
            self.ok = ok
        }
    }

    // MARK: - Fields

    public var schema: String
    public var id: String
    public var title: String?
    /// Wall-clock creation time, ISO 8601 UTC.
    public var createdAt: String?
    /// Host-clock nanoseconds for package creation, gate open and stop.
    /// `startedHostNs` mirrors `clock.epochHostNs` once the gate has opened.
    public var createdHostNs: Int64?
    public var startedHostNs: Int64?
    public var endedHostNs: Int64?
    public var status: Status
    public var app: AppInfo?
    public var clock: ManifestClock?
    public var sources: RecordingSources?
    public var tracks: [RecordingTrack]
    public var input: RecordingInput?
    public var warnings: [ManifestWarning]
    public var verified: VerificationStamp?

    public init(
        schema: String = RecordingManifest.currentSchema,
        id: String,
        title: String? = nil,
        createdAt: String? = nil,
        createdHostNs: Int64? = nil,
        startedHostNs: Int64? = nil,
        endedHostNs: Int64? = nil,
        status: Status = .failed,
        app: AppInfo? = nil,
        clock: ManifestClock? = nil,
        sources: RecordingSources? = nil,
        tracks: [RecordingTrack] = [],
        input: RecordingInput? = nil,
        warnings: [ManifestWarning] = [],
        verified: VerificationStamp? = nil
    ) {
        self.schema = schema
        self.id = id
        self.title = title
        self.createdAt = createdAt
        self.createdHostNs = createdHostNs
        self.startedHostNs = startedHostNs
        self.endedHostNs = endedHostNs
        self.status = status
        self.app = app
        self.clock = clock
        self.sources = sources
        self.tracks = tracks
        self.input = input
        self.warnings = warnings
        self.verified = verified
    }

    /// The camera offset David's editor consumes: positive means the
    /// camera's first frame belongs that many milliseconds after the
    /// screen's first frame (docs/PLAN.md, manifest.json).
    public var cameraOffsetMs: Int? {
        let camera = tracks.first { $0.kind == .camera }
        let screen = tracks.first { $0.kind == .screen }
        guard let camera, let screen else { return nil }
        return camera.offsetMs - screen.offsetMs
    }

    /// Parses and validates manifest bytes.
    public static func parse(_ data: Data) throws -> RecordingManifest {
        do {
            return try JSONDecoder().decode(RecordingManifest.self, from: data)
        } catch let error as ManifestError {
            throw error
        } catch {
            throw ManifestError.unreadable(detail: String(describing: error))
        }
    }
}

// MARK: - Track file naming

extension RecordingManifest.RecordingTrack {

    /// The manifest's role string for a track kind ("screen", "camera",
    /// "mic", "system" per the plan's manifest example).
    public static func roleString(for kind: TrackKind) -> String {
        switch kind {
        case .screen: return "screen"
        case .camera: return "camera"
        case .microphone: return "mic"
        case .systemAudio: return "system"
        }
    }

    /// The kind for a manifest role string.
    public static func kind(forRole role: String) -> TrackKind? {
        switch role {
        case "screen": return .screen
        case "camera": return .camera
        case "mic": return .microphone
        case "system": return .systemAudio
        default: return nil
        }
    }
}

// MARK: - Codable

/// The manifest is encoded with the plan's key names. Decoding is tolerant:
/// every field except `schema` and `id` falls back to a default, and unknown
/// keys are ignored, so a manifest written by an equal-schema build with
/// extra diagnostics still loads.
extension RecordingManifest: Codable {

    private enum Keys: String, CodingKey {
        case schema, id, title, createdAt, status, app, clock, sources, tracks
        case input, warnings, verified
        case createdHostNs, startedHostNs, endedHostNs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let schema = try container.decodeIfPresent(String.self, forKey: .schema)
        guard let schema else {
            throw ManifestError.unsupportedSchema(found: nil, expected: Self.currentSchema)
        }
        guard schema == Self.currentSchema else {
            throw ManifestError.unsupportedSchema(found: schema, expected: Self.currentSchema)
        }
        guard let id = try container.decodeIfPresent(String.self, forKey: .id), !id.isEmpty else {
            throw ManifestError.missingIdentifier
        }
        self.schema = schema
        self.id = id
        title = try container.decodeIfPresent(String.self, forKey: .title)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        createdHostNs = try container.decodeIfPresent(Int64.self, forKey: .createdHostNs)
        startedHostNs = try container.decodeIfPresent(Int64.self, forKey: .startedHostNs)
        endedHostNs = try container.decodeIfPresent(Int64.self, forKey: .endedHostNs)
        status = try container.decodeIfPresent(Status.self, forKey: .status) ?? .failed
        app = try container.decodeIfPresent(AppInfo.self, forKey: .app)
        clock = try container.decodeIfPresent(ManifestClock.self, forKey: .clock)
        sources = try container.decodeIfPresent(RecordingSources.self, forKey: .sources)
        tracks = try container.decodeIfPresent([RecordingTrack].self, forKey: .tracks) ?? []
        input = try container.decodeIfPresent(RecordingInput.self, forKey: .input)
        warnings = try container.decodeIfPresent([ManifestWarning].self, forKey: .warnings) ?? []
        verified = try container.decodeIfPresent(VerificationStamp.self, forKey: .verified)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(id, forKey: .id)
        try container.encodeIfPresent(title, forKey: .title)
        try container.encodeIfPresent(createdAt, forKey: .createdAt)
        try container.encodeIfPresent(createdHostNs, forKey: .createdHostNs)
        try container.encodeIfPresent(startedHostNs, forKey: .startedHostNs)
        try container.encodeIfPresent(endedHostNs, forKey: .endedHostNs)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(app, forKey: .app)
        try container.encodeIfPresent(clock, forKey: .clock)
        try container.encodeIfPresent(sources, forKey: .sources)
        try container.encode(tracks, forKey: .tracks)
        try container.encodeIfPresent(input, forKey: .input)
        try container.encode(warnings, forKey: .warnings)
        try container.encodeIfPresent(verified, forKey: .verified)
    }
}

extension RecordingManifest.ManifestClock: Codable {
    private enum Keys: String, CodingKey {
        case epochHostNs, durationNs, pausesNs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        epochHostNs = try container.decodeIfPresent(Int64.self, forKey: .epochHostNs) ?? 0
        durationNs = try container.decodeIfPresent(Int64.self, forKey: .durationNs)
        pausesNs = try container.decodeIfPresent([[Int64]].self, forKey: .pausesNs) ?? []
    }
}

extension RecordingManifest.AppInfo: Codable {
    private enum Keys: String, CodingKey {
        case version, build
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        version = try container.decodeIfPresent(String.self, forKey: .version) ?? "0"
        build = try container.decodeIfPresent(Int.self, forKey: .build)
    }
}

extension RecordingManifest.RecordingSources: Codable {
    private enum Keys: String, CodingKey {
        case mode, displayId, windowId, cameraId, microphoneId, systemAudio
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        mode = try container.decodeIfPresent(String.self, forKey: .mode)
        displayId = try container.decodeIfPresent(String.self, forKey: .displayId)
        windowId = try container.decodeIfPresent(String.self, forKey: .windowId)
        cameraId = try container.decodeIfPresent(String.self, forKey: .cameraId)
        microphoneId = try container.decodeIfPresent(String.self, forKey: .microphoneId)
        systemAudio = try container.decodeIfPresent(Bool.self, forKey: .systemAudio) ?? false
    }
}

extension RecordingManifest.RecordingTrack: Codable {
    private enum Keys: String, CodingKey {
        case role, file, present, codec, width, height, fps
        case sampleRate, channels, offsetNs, offsetMs, firstSampleNs
        case latencyMs, droppedFrames, device
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let role = try container.decodeIfPresent(String.self, forKey: .role) ?? "screen"
        guard let kind = Self.kind(forRole: role) else {
            throw RecordingManifest.ManifestError.unreadable(detail: "unknown track role \(role)")
        }
        self.init(
            kind: kind,
            file: try container.decodeIfPresent(String.self, forKey: .file),
            present: try container.decodeIfPresent(Bool.self, forKey: .present) ?? true,
            codec: try container.decodeIfPresent(String.self, forKey: .codec),
            width: try container.decodeIfPresent(Int.self, forKey: .width),
            height: try container.decodeIfPresent(Int.self, forKey: .height),
            fps: try container.decodeIfPresent(Int.self, forKey: .fps),
            sampleRate: try container.decodeIfPresent(Int.self, forKey: .sampleRate),
            channels: try container.decodeIfPresent(Int.self, forKey: .channels),
            offsetNs: try container.decodeIfPresent(Int64.self, forKey: .offsetNs) ?? 0,
            firstSampleNs: try container.decodeIfPresent(Int64.self, forKey: .firstSampleNs),
            latencyMs: try container.decodeIfPresent(Int.self, forKey: .latencyMs),
            droppedFrames: try container.decodeIfPresent(Int64.self, forKey: .droppedFrames),
            device: try container.decodeIfPresent(RecordingManifest.DeviceRef.self, forKey: .device))
        // Keep the stored milliseconds exactly as written: `offsetMs` is
        // derived on construction, but a pair that disagrees on disk is a
        // finding `verify` must be able to report.
        if let storedOffsetMs = try container.decodeIfPresent(Int.self, forKey: .offsetMs) {
            self.offsetMs = storedOffsetMs
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        try container.encode(Self.roleString(for: kind), forKey: .role)
        try container.encode(file, forKey: .file)
        try container.encode(present, forKey: .present)
        try container.encodeIfPresent(codec, forKey: .codec)
        try container.encodeIfPresent(width, forKey: .width)
        try container.encodeIfPresent(height, forKey: .height)
        try container.encodeIfPresent(fps, forKey: .fps)
        try container.encodeIfPresent(sampleRate, forKey: .sampleRate)
        try container.encodeIfPresent(channels, forKey: .channels)
        try container.encode(offsetNs, forKey: .offsetNs)
        try container.encode(offsetMs, forKey: .offsetMs)
        try container.encodeIfPresent(firstSampleNs, forKey: .firstSampleNs)
        try container.encodeIfPresent(latencyMs, forKey: .latencyMs)
        try container.encodeIfPresent(droppedFrames, forKey: .droppedFrames)
        try container.encodeIfPresent(device, forKey: .device)
    }
}

extension RecordingManifest.DeviceRef: Codable {
    private enum Keys: String, CodingKey {
        case uniqueId, modelId, name
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        uniqueId = try container.decodeIfPresent(String.self, forKey: .uniqueId) ?? ""
        modelId = try container.decodeIfPresent(String.self, forKey: .modelId)
        name = try container.decodeIfPresent(String.self, forKey: .name)
    }
}

extension RecordingManifest.RecordingInput: Codable {
    private enum Keys: String, CodingKey {
        case file, pointer, keys
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        file = try container.decodeIfPresent(String.self, forKey: .file) ?? "input.ndjson"
        pointer = try container.decodeIfPresent(Bool.self, forKey: .pointer) ?? true
        keys = try container.decodeIfPresent(Bool.self, forKey: .keys) ?? false
    }
}

extension RecordingManifest.ManifestWarning: Codable {
    private enum Keys: String, CodingKey {
        case code, atMs, message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        code = try container.decodeIfPresent(String.self, forKey: .code) ?? "unknown"
        atMs = try container.decodeIfPresent(Int.self, forKey: .atMs)
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }
}

extension RecordingManifest.VerificationStamp: Codable {
    private enum Keys: String, CodingKey {
        case at, ok
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        at = try container.decodeIfPresent(String.self, forKey: .at) ?? ""
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? false
    }
}
