import AVFoundation
import Foundation

/// The package-level decode test: the engine of `rushes verify`
/// (docs/PLAN.md, Phase 1: "`rushes verify <id>` reports every track
/// decodable, each track's duration within 50 ms of the manifest duration,
/// and `offsetMs` 0 on every track"; the post-stop decode test writes its
/// result into the manifest's `verified` block).
public struct PackageVerifier: Sendable {

    /// The report for one package.
    public struct Report: Equatable, Sendable {

        /// The decode test of one track.
        public struct TrackCheck: Equatable, Sendable {
            public let kind: TrackKind
            public let file: String
            /// False only when the track failed a check. Tracks whose entry
            /// says `present == false` are skipped, not failed: they carry
            /// no media to test.
            public let ok: Bool
            public let skipped: Bool
            public let issues: [String]
        }

        public let packageID: String
        public let ok: Bool
        public let trackChecks: [TrackCheck]
        /// Package-level problems (unreadable manifest, missing clock).
        public let issues: [String]
    }

    /// How far a track's decoded duration may sit from the manifest
    /// duration, in milliseconds.
    public let toleranceMs: Double

    public init(toleranceMs: Double = 50) {
        self.toleranceMs = toleranceMs
    }

    /// Verifies one package. Read-only: nothing on disk is modified.
    public func verify(_ package: RecordingPackage) async -> Report {
        var packageIssues: [String] = []

        let manifest: RecordingManifest
        do {
            manifest = try package.readManifest()
        } catch {
            return Report(
                packageID: package.id.isEmpty ? package.folderURL.lastPathComponent : package.id,
                ok: false, trackChecks: [], issues: ["manifest unreadable: \(error)"])
        }

        guard let clock = manifest.clock else {
            packageIssues.append("manifest clock missing")
            return Report(
                packageID: manifest.id, ok: false, trackChecks: [], issues: packageIssues)
        }
        var manifestDurationSeconds: Double?
        if let durationNs = clock.durationNs {
            manifestDurationSeconds = Double(durationNs) / 1e9
        } else {
            packageIssues.append("manifest clock has no duration")
        }

        var checks: [Report.TrackCheck] = []
        for track in manifest.tracks {
            checks.append(
                await checkTrack(track, in: package, manifestDuration: manifestDurationSeconds))
        }

        let allTracksOK = checks.allSatisfy(\.ok)
        return Report(
            packageID: manifest.id,
            ok: allTracksOK && packageIssues.isEmpty,
            trackChecks: checks,
            issues: packageIssues)
    }

    private func checkTrack(
        _ track: RecordingManifest.RecordingTrack,
        in package: RecordingPackage,
        manifestDuration: Double?
    ) async -> Report.TrackCheck {
        guard track.present else {
            return .init(kind: track.kind, file: track.file, ok: true, skipped: true, issues: [])
        }

        var issues: [String] = []
        let url = package.folderURL.appendingPathComponent(track.file)

        guard FileManager.default.fileExists(atPath: url.path) else {
            issues.append("\(track.file): file missing")
            return .init(kind: track.kind, file: track.file, ok: false, skipped: false, issues: issues)
        }

        // Offsets are present and agree with each other.
        if track.offsetMs != RecordingManifest.RecordingTrack.milliseconds(fromNs: track.offsetNs) {
            issues.append("\(track.file): offsetMs \(track.offsetMs) does not match offsetNs \(track.offsetNs)")
        }

        let probe = await MediaProbing.probe(url: url)
        guard probe.openable else {
            let reason = probe.errorDescription.map { ": \($0)" } ?? ""
            issues.append("\(track.file): could not be opened by AVFoundation\(reason)")
            return .init(kind: track.kind, file: track.file, ok: false, skipped: false, issues: issues)
        }
        if track.kind.carriesVideo, probe.videoTrackCount == 0 {
            issues.append("\(track.file): no video track")
        }
        if track.kind.carriesAudio, probe.audioTrackCount == 0 {
            issues.append("\(track.file): no audio track")
        }

        if let manifestDuration, let trackDuration = probe.durationSeconds {
            let deviationMs = abs(trackDuration - manifestDuration) * 1_000
            if deviationMs > toleranceMs {
                issues.append(
                    "\(track.file): duration \(String(format: "%.0f", trackDuration * 1_000)) ms"
                        + " is \(String(format: "%.0f", deviationMs)) ms off the manifest"
                        + " duration \(String(format: "%.0f", manifestDuration * 1_000)) ms"
                        + " (tolerance \(String(format: "%.0f", toleranceMs)) ms)")
            }
        }

        return .init(
            kind: track.kind, file: track.file, ok: issues.isEmpty, skipped: false, issues: issues)
    }
}
