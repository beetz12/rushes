import Foundation

/// A point-in-time report of the session for the control layer
/// (`rushes status` and the shell's bar), readable while recording.
///
/// Everything here is a value: taking a snapshot never blocks capture. The
/// per-track statuses come from the writers' own snapshots, so the control
/// layer sees backpressure (`pendingDepth`) and health exactly as the
/// writers report them.
public struct SessionSnapshot: Codable, Equatable, Sendable {

    /// Where the session's life cycle stands. `recovered` never appears
    /// here: it is set by launch-time recovery on packages whose session
    /// is gone (docs/PLAN.md, Session states).
    public var state: SessionState

    /// The recording id, once a package exists.
    public var recordingID: String?

    /// The package folder's path, once a package exists.
    public var packagePath: String?

    /// The gate-open instant (media time zero), once the gate has opened.
    public var epochHostNs: Int64?

    /// Media time reached so far: wall time since the epoch minus every
    /// pause, so it freezes while paused.
    public var elapsedMediaNs: Int64?

    /// Whether the session sits in an open pause.
    public var paused: Bool

    /// Warnings accumulated so far, as they are stored in the manifest.
    public var warnings: [RecordingManifest.ManifestWarning]

    /// Per-track writer statuses in manifest order.
    public var tracks: [TrackWriterStatus]

    public init(
        state: SessionState,
        recordingID: String? = nil,
        packagePath: String? = nil,
        epochHostNs: Int64? = nil,
        elapsedMediaNs: Int64? = nil,
        paused: Bool = false,
        warnings: [RecordingManifest.ManifestWarning] = [],
        tracks: [TrackWriterStatus] = []
    ) {
        self.state = state
        self.recordingID = recordingID
        self.packagePath = packagePath
        self.epochHostNs = epochHostNs
        self.elapsedMediaNs = elapsedMediaNs
        self.paused = paused
        self.warnings = warnings
        self.tracks = tracks
    }
}
