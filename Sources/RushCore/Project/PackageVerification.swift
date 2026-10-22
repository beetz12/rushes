import AVFoundation
import Foundation

/// The package-level decode test: the engine of `rushes verify`
/// (docs/PLAN.md, Phase 1: "`rushes verify <id>` reports every track
/// decodable, each track's duration within 50 ms of the manifest duration,
/// and `offsetMs` 0 on every track"; the post-stop decode test writes its
/// result into the manifest's `verified` block).
public struct PackageVerifier: Sendable {

    private struct CheckedTrack {
        let report: Report.TrackCheck
        let actualDuration: Double?
        init(kind: TrackKind, file: String, ok: Bool, skipped: Bool, issues: [String], actualDuration: Double? = nil) {
            report = .init(kind: kind, file: file, ok: ok, skipped: skipped, issues: issues)
            self.actualDuration = actualDuration
        }
    }

    /// AVFoundation's synchronous decoder can wait for codec work. Keep those
    /// waits outside Swift's cooperative executor, which must remain available
    /// to concurrent writers and cancellation tasks.
    private final class Decoder: @unchecked Sendable {
        let reader: AVAssetReader
        let output: AVAssetReaderTrackOutput
        private var started = false
        init(reader: AVAssetReader, output: AVAssetReaderTrackOutput) {
            self.reader = reader; self.output = output
        }
        // Called only by this reader's dedicated serial queue.
        func copyCount() -> Int? {
            if !started {
                started = true
                guard reader.startReading() else { return nil }
            }
            return output.copyNextSampleBuffer().map(CMSampleBufferGetNumSamples)
        }
    }

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
        if Task.isCancelled { return Report(packageID: package.id, ok: false, trackChecks: [], issues: ["verification cancelled"]) }
        guard !PendingWriterFiles.shared.contains(in: package.folderURL) else {
            return Report(packageID: package.id, ok: false, trackChecks: [], issues: ["native finalization is still pending; retained media has not been checked"])
        }

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
        if manifest.status != .complete && manifest.status != .recovered {
            packageIssues.append("package is not a finalized successful or recovered recording")
        }
        if manifest.warnings.contains(where: { $0.code == "ended-early" && ($0.message?.hasPrefix("stream-error") == true || $0.message?.hasPrefix("writer-failed") == true) }) {
            packageIssues.append("recording ended early because a capture stream or writer failed; playable surviving tracks do not make the take successful")
        }
        if !manifest.tracks.contains(where: \.present) {
            packageIssues.append("package has no recorded media tracks")
        }
        if Set(manifest.tracks.map { $0.kind.rawValue }).count != manifest.tracks.count {
            packageIssues.append("manifest has duplicate track roles")
        }
        var manifestDurationSeconds: Double?
        if let durationNs = clock.durationNs, durationNs > 0 {
            manifestDurationSeconds = Double(durationNs) / 1e9
        } else {
            packageIssues.append("manifest clock has no positive duration")
        }

        let recoveredTiming = manifest.status == .recovered
            && manifest.warnings.contains { $0.code == "recovered-track-timing" }
        let cameraLost = manifest.warnings.contains { $0.code == "camera-lost" }
        var measured: [CheckedTrack] = []
        for track in manifest.tracks {
            if Task.isCancelled { packageIssues.append("verification cancelled"); break }
            measured.append(await checkTrack(track, in: package, manifestDuration: manifestDurationSeconds,
                                            cameraLost: cameraLost, recoveredTiming: recoveredTiming))
        }
        if recoveredTiming {
            let present = measured.filter { !$0.report.skipped }
            let valid = present.filter { $0.actualDuration.map { $0.isFinite && $0 > 0 } == true }
            if valid.count != manifest.tracks.filter(\.present).count {
                packageIssues.append("recovered timing is missing a measurable present track")
            }
            let eligible = valid.filter { item in
                !(cameraLost && item.report.kind == .camera && valid.contains {
                    $0.report.kind != .camera && ($0.actualDuration ?? 0) > (item.actualDuration ?? 0)
                })
            }
            // Compare directly with file measurements; two tolerance checks
            // via declared durations must not permit a 100ms clock error.
            if let actualEnd = eligible.compactMap(\.actualDuration).min(), let expected = manifestDurationSeconds,
               abs(actualEnd - expected) * 1_000 > toleranceMs {
                packageIssues.append("recovered common timeline differs from measured available media")
            }
        }

        let checks = measured.map(\.report)

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
        manifestDuration: Double?,
        cameraLost: Bool,
        recoveredTiming: Bool
    ) async -> CheckedTrack {
        let url: URL
        do {
            url = try package.validatedMediaURL(track.file)
        } catch {
            return .init(kind: track.kind, file: track.file, ok: false,
                         skipped: false, issues: ["\(track.file): unsafe media path"])
        }
        guard track.present else {
            return .init(kind: track.kind, file: track.file, ok: true, skipped: true, issues: [])
        }

        var issues: [String] = []
        var expectedDuration = manifestDuration
        if recoveredTiming {
            if let durationNs = track.durationNs, durationNs > 0 {
                expectedDuration = Double(durationNs) / 1e9
            } else { issues.append("\(track.file): recovered measured duration is missing or invalid") }
            if track.offsetNs != 0 { issues.append("\(track.file): recovered native input must start on the shared zero clock") }
        } else if let durationNs = track.durationNs {
            let duration = Double(durationNs) / 1e9
            if track.kind == .camera, cameraLost, durationNs > 0,
               let manifestDuration, duration <= manifestDuration {
                expectedDuration = duration
            } else {
                issues.append("\(track.file): custom duration requires a lost camera within the take")
            }
        }

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

        if let manifestDuration = expectedDuration, let trackDuration = probe.durationSeconds {
            let deviationMs = abs(trackDuration - manifestDuration) * 1_000
            if deviationMs > toleranceMs {
                issues.append(
                    "\(track.file): duration \(String(format: "%.0f", trackDuration * 1_000)) ms"
                        + " is \(String(format: "%.0f", deviationMs)) ms off the manifest"
                        + " duration \(String(format: "%.0f", manifestDuration * 1_000)) ms"
                        + " (tolerance \(String(format: "%.0f", toleranceMs)) ms)")
            }
        }
        if probe.durationSeconds == nil || probe.durationSeconds! <= 0 {
            issues.append("\(track.file): no positive media duration")
        }

        // Loading an AVURLAsset only validates its container metadata. Actually
        // decode every declared media stream so a broken payload cannot pass.
        do {
            let asset = AVURLAsset(url: url)
            let type: AVMediaType = track.kind.carriesVideo ? .video : .audio
            let streams = try await asset.loadTracks(withMediaType: type)
            for stream in streams {
                try Task.checkCancellation()
                let reader = try AVAssetReader(asset: asset)
                let settings: [String: Any] = track.kind.carriesVideo
                    ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
                    : [AVFormatIDKey: kAudioFormatLinearPCM]
                let output = AVAssetReaderTrackOutput(track: stream, outputSettings: settings)
                output.alwaysCopiesSampleData = false
                guard reader.canAdd(output) else {
                    issues.append("\(track.file): cannot create decode reader")
                    continue
                }
                reader.add(output)
                let decoder = Decoder(reader: reader, output: output)
                let reads = BoundedMediaRead<Int>(copy: { decoder.copyCount() },
                                                  cancel: { decoder.reader.cancelReading() })
                defer { reads.cancel() }
                var samples = 0
                while let count = try await reads.read() {
                    try Task.checkCancellation()
                    samples += count
                }
                if reader.status != .completed || samples == 0 {
                    issues.append("\(track.file): stream did not decode to completion")
                }
            }
        } catch {
            issues.append("\(track.file): decode failed: \(error)")
        }

        return .init(
            kind: track.kind, file: track.file, ok: issues.isEmpty, skipped: false, issues: issues,
            actualDuration: probe.durationSeconds)
    }
}
