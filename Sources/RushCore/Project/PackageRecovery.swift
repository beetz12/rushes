import Foundation

/// The salvage seam for recovery: decode-level repair of a torn fragmented
/// movie (docs/PLAN.md, Crash safety and recovery, step 2).
///
/// The port of OpenScreen's box-walking salvage is a later goal; recovery
/// calls this protocol only when AVFoundation cannot open a track file, so
/// the seam is in place before that port lands. Implementations must never
/// delete or modify the original file: they write a repaired copy beside it
/// and return the copy's URL.
public protocol TrackSalvaging: Sendable {

    /// Attempts to repair the movie at `url`.
    ///
    /// - Returns: the URL of a playable repaired copy, or nil when salvage
    ///   is unavailable or fails. The original must be left untouched.
    func salvage(trackAt url: URL) async -> URL?
}

/// The default: no salvage. Recovery keeps the unopenable file untouched on
/// disk and records a warning, so no footage is ever lost waiting for the
/// salvage port.
public struct NoTrackSalvage: TrackSalvaging {
    public init() {}

    public func salvage(trackAt url: URL) async -> URL? { nil }
}

/// One interrupted package's recovery outcome.
public struct RecoveryReport: Equatable, Sendable {

    /// What happened to one track file.
    public struct TrackOutcome: Equatable, Sendable {
        public let kind: TrackKind
        public let file: String
        /// The file is still on disk (it always is; recovery never deletes).
        public let fileKept: Bool
        /// The file is counted as usable media of the recovered take.
        public let usable: Bool
        /// A repaired copy was produced by the salvage seam.
        public let salvaged: Bool

        init(kind: TrackKind, file: String, fileKept: Bool, usable: Bool, salvaged: Bool) {
            self.kind = kind
            self.file = file
            self.fileKept = fileKept
            self.usable = usable
            self.salvaged = salvaged
        }
    }

    public let packageID: String
    public let folderPath: String
    public let previousStatus: RecordingManifest.Status
    public let trackOutcomes: [TrackOutcome]
    public let warnings: [RecordingManifest.ManifestWarning]
    /// Media duration (seconds) recorded in the manifest after recovery, if
    /// a usable track could be measured.
    public let recoveredDurationSeconds: Double?

    /// Whether every track file the package had on disk stayed on disk.
    public var keptAllFiles: Bool { trackOutcomes.allSatisfy(\.fileKept) }
}

/// Launch-time recovery of interrupted recordings
/// (docs/PLAN.md, Crash safety and recovery).
///
/// A package whose manifest still says `recording` or `finishing` when this
/// pass runs belongs to no live session: the engine just started (or
/// `rushes recover` asked for a rescan). Recovery marks it `recovered`,
/// keeps every track file that holds more than 0.1 s of media, clears
/// `present` on files that vanished (unreadable existing files stay visible), sets the manifest
/// duration to the common available timeline, and records every measured tail
/// in the manifest's warnings. It never deletes footage: not a missing
/// manifest, not an unopenable file, not even an empty one.
public struct PackageRecovery: Sendable {

    /// Tracks shorter than this are not counted as recovered media
    /// (Screendrop rule).
    public static let minimumUsableSeconds: Double = 0.1

    public let root: URL
    public let salvage: any TrackSalvaging

    public init(
        root: URL = RecordingPackage.defaultRoot,
        salvage: any TrackSalvaging = NoTrackSalvage()
    ) {
        self.root = root
        self.salvage = salvage
    }

    /// Recovers every interrupted package under the root.
    ///
    /// - Parameter interruptedAtLaunch: true when the engine just started
    ///   (the manifest's persisted active-recording check), false for an
    ///   explicit on-demand rescan. The flag only changes the recorded
    ///   warning code; the recovery work is identical.
    @discardableResult
    public func recover(interruptedAtLaunch: Bool) async throws -> [RecoveryReport] {
        let entries = try RecordingPackage.scanManifests(root: root)
        var reports: [RecoveryReport] = []
        for entry in entries where entry.manifest.status.isInterrupted {
            let report = try await recoverOne(
                entry.package, manifest: entry.manifest, interruptedAtLaunch: interruptedAtLaunch)
            reports.append(report)
        }
        return reports
    }

    private func recoverOne(
        _ package: RecordingPackage,
        manifest: RecordingManifest,
        interruptedAtLaunch: Bool
    ) async throws -> RecoveryReport {
        var updated = manifest
        var warnings: [RecordingManifest.ManifestWarning] = []
        var outcomes: [RecoveryReport.TrackOutcome] = []
        var durations: [(kind: TrackKind, seconds: Double)] = []

        for index in manifest.tracks.indices {
            let track = manifest.tracks[index]
            guard let url = try? package.validatedMediaURL(track.file) else {
                updated.tracks[index].present = false
                warnings.append(.init(code: "unsafe-track-path",
                                      message: "Refused a media path outside its package"))
                outcomes.append(.init(kind: track.kind, file: track.file,
                                      fileKept: false, usable: false, salvaged: false))
                continue
            }
            let fileManager = FileManager.default

            guard track.present, fileManager.fileExists(atPath: url.path) else {
                let wasPresent = track.present
                updated.tracks[index].present = false
                if wasPresent {
                    warnings.append(
                        .init(code: "track-missing", message: "\(track.file) was not found"))
                }
                outcomes.append(
                    .init(kind: track.kind, file: track.file, fileKept: false, usable: false,
                          salvaged: false))
                continue
            }

            var probe = await MediaProbing.probe(url: url)
            var salvaged = false
            if !probe.openable, let repairedURL = await salvage.salvage(trackAt: url) {
                let repairedProbe = await MediaProbing.probe(url: repairedURL)
                if repairedProbe.openable {
                    probe = repairedProbe
                    salvaged = true
                    warnings.append(
                        .init(code: "track-salvaged", message: "repaired copy of \(track.file)"))
                }
            }

            let seconds = probe.durationSeconds ?? 0
            let usable = probe.openable && seconds.isFinite
                && seconds > Self.minimumUsableSeconds && seconds < Double(Int64.max) / 1e9
            if usable {
                durations.append((track.kind, seconds))
                updated.tracks[index].durationNs = Int64((seconds * 1e9).rounded())
            } else {
                warnings.append(
                    .init(
                        code: "track-unreadable",
                        message: "\(track.file) has no usable media and was kept untouched"))
            }
            outcomes.append(
                .init(kind: track.kind, file: track.file, fileKept: true, usable: usable,
                      salvaged: salvaged))
        }

        // Independently flushed fragments need not end together. Keep the raw
        // files and declare each measured tail; playback uses their common
        // available end. A deliberately lost camera does not truncate another
        // input that continued recording after that loss.
        let cameraLost = manifest.warnings.contains { $0.code == "camera-lost" }
        let eligible = durations.filter { item in
            !(cameraLost && item.kind == .camera
              && durations.contains { $0.kind != .camera && $0.seconds > item.seconds })
        }
        let recoveredDuration = eligible.map(\.seconds).min()
        if let recoveredDuration {
            let durationNs = Int64((recoveredDuration * 1e9).rounded())
            if updated.clock == nil {
                updated.clock = RecordingManifest.ManifestClock(
                    clock: SessionClock(epochNs: 0), durationNs: durationNs)
            } else {
                updated.clock?.durationNs = durationNs
            }
            let tails = durations.map { "\($0.kind.rawValue): \(String(format: "%.3f", $0.seconds)) s" }.joined(separator: "; ")
            warnings.append(.init(code: "recovered-track-timing",
                message: "Recovered \(String(format: "%.3f", recoveredDuration)) s of shared playback. \(tails). Original files kept."))
        }

        updated.status = .recovered
        warnings.append(
            .init(
                code: interruptedAtLaunch ? "recovered-at-launch" : "recovered-on-demand",
                message: "was \(manifest.status.rawValue) when the recovery pass ran"))
        updated.warnings.append(contentsOf: warnings)
        try package.writeManifest(updated)

        return RecoveryReport(
            packageID: manifest.id,
            folderPath: package.folderURL.path,
            previousStatus: manifest.status,
            trackOutcomes: outcomes,
            warnings: warnings,
            recoveredDurationSeconds: recoveredDuration)
    }
}
