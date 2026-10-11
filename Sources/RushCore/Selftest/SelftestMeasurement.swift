import Foundation

/// The measurement half of `selftest sync` and all of `analyze clap`
/// (docs/PLAN.md, Roadmap Phase 1 item 9): given finished track files, find
/// the signals and compute the offsets. Pure over files: everything here can
/// run headless, on synthetic files with known ground truth or on a real
/// take, with no capture hardware involved.

// MARK: - selftest sync measurement

/// The screen-to-system-audio measurement of one selftest take.
public struct SelftestSyncMeasurement: Equatable, Sendable {

    /// One flash/tone pair.
    public struct Pair: Equatable, Sendable {
        /// Where the white flash landed in `screen.mov` (media ms).
        public var flashMs: Double?
        /// Where the tone landed in `system.mov` (media ms).
        public var toneMs: Double?
        /// Tone minus flash: positive means system audio arrived that many
        /// milliseconds after the picture.
        public var rawOffsetMs: Double?

        init(flashMs: Double?, toneMs: Double?) {
            self.flashMs = flashMs
            self.toneMs = toneMs
            self.rawOffsetMs = flashMs.flatMap { flash in
                toneMs.map { tone in tone - flash }
            }
        }
    }

    public var pre: Pair
    public var post: Pair

    /// Finds the flash and the tone of both pairs inside their expected
    /// media-time windows. The windows come from the take's schedule mapped
    /// through the manifest clock, widened by `searchMs`.
    public static func measure(
        screenURL: URL,
        systemAudioURL: URL,
        preWindowMs: ClosedRange<Double>,
        postWindowMs: ClosedRange<Double>,
        searchMs: Double = 1_500
    ) async throws -> SelftestSyncMeasurement {
        let frames = try await VideoFrameSeries.samples(url: screenURL)
        let audioBlocks = try await AudioEnvelope.blocks(url: systemAudioURL)

        func widen(_ window: ClosedRange<Double>) -> ClosedRange<Double> {
            (window.lowerBound - searchMs)...(window.upperBound + searchMs)
        }
        let prePair = Pair(
            flashMs: VideoOnset.flashOnset(samples: frames, windowMs: widen(preWindowMs)),
            toneMs: AudioOnset.firstSustainedRise(
                blocks: audioBlocks, windowMs: widen(preWindowMs)))
        let postPair = Pair(
            flashMs: VideoOnset.flashOnset(samples: frames, windowMs: widen(postWindowMs)),
            toneMs: AudioOnset.firstSustainedRise(
                blocks: audioBlocks, windowMs: widen(postWindowMs)))
        return SelftestSyncMeasurement(pre: prePair, post: postPair)
    }

    /// Both pairs produced a raw offset.
    public var complete: Bool {
        pre.rawOffsetMs != nil && post.rawOffsetMs != nil
    }
}

/// The full `selftest sync` result: raw offsets, the latency that was
/// applied, the residuals after it, and the pass verdict against the plan's
/// one-frame (17 ms) target.
public struct SelftestSyncReport: Codable, Equatable, Sendable {

    /// One 60 fps frame (docs/PLAN.md, Measured targets: screen to system
    /// audio alignment within 17 ms after latency compensation).
    public static let toleranceMs: Double = 17

    public struct PairReport: Codable, Equatable, Sendable {
        public var flashMs: Double?
        public var toneMs: Double?
        public var rawOffsetMs: Double?
        /// Raw offset minus the applied latency.
        public var offsetMs: Double?
    }

    public var recordingId: String
    public var packagePath: String
    public var pre: PairReport
    public var post: PairReport
    /// The latency the previous run stored and this run applied.
    public var appliedLatencyMs: Double
    /// The latency this run measured and stored for the next run (the mean
    /// of both pairs' raw offsets).
    public var storedLatencyMs: Double?
    public var pass: Bool
    public var toleranceMs: Double

    init(
        recordingId: String,
        packagePath: String,
        measurement: SelftestSyncMeasurement,
        appliedLatencyMs: Double,
        measuredLatencyMs: Double?
    ) {
        func pair(_ pair: SelftestSyncMeasurement.Pair) -> PairReport {
            PairReport(
                flashMs: pair.flashMs,
                toneMs: pair.toneMs,
                rawOffsetMs: pair.rawOffsetMs,
                offsetMs: pair.rawOffsetMs.map { $0 - appliedLatencyMs })
        }
        self.recordingId = recordingId
        self.packagePath = packagePath
        self.pre = pair(measurement.pre)
        self.post = pair(measurement.post)
        self.appliedLatencyMs = appliedLatencyMs
        self.storedLatencyMs = measuredLatencyMs.map { ($0 * 10).rounded() / 10 }
        self.toleranceMs = Self.toleranceMs
        self.pass = measurement.complete
            && abs((self.pre.offsetMs ?? .infinity)) <= Self.toleranceMs
            && abs((self.post.offsetMs ?? .infinity)) <= Self.toleranceMs
    }
}

// MARK: - analyze clap

/// The camera-versus-microphone measurement of one recording
/// (docs/PLAN.md, Measured targets: camera to microphone alignment within
/// 40 ms).
public struct ClapAnalysis: Codable, Equatable, Sendable {

    public static let toleranceMs: Double = 40

    /// One clap: the audio onset in `mic.mov`, the strongest frame-to-frame
    /// change in `camera.mov` near it, and their difference (visual minus
    /// audio).
    public struct Clap: Codable, Equatable, Sendable {
        public var tMs: Double
        public var audioMs: Double
        public var visualMs: Double?
        public var offsetMs: Double?
    }

    public var claps: [Clap]
    public var toleranceMs: Double
    public var pass: Bool

    /// Finds the claps in one package's `mic.mov` and `camera.mov`.
    ///
    /// - Parameters:
    ///   - cameraURL: the camera master.
    ///   - microphoneURL: the microphone master.
    ///   - searchMs: how far around each audio onset the visual search looks
    ///     for the matching frame change.
    public static func analyze(
        cameraURL: URL,
        microphoneURL: URL,
        searchMs: Double = 250
    ) async throws -> ClapAnalysis {
        let audioBlocks = try await AudioEnvelope.blocks(url: microphoneURL)
        let frames = try await VideoFrameSeries.samples(url: cameraURL)
        let onsets = AudioOnset.sharpAttacks(blocks: audioBlocks)

        var claps: [Clap] = []
        for onset in onsets {
            let window = (onset - searchMs)...(onset + searchMs)
            let visual = VideoOnset.largestChange(samples: frames, windowMs: window)
            claps.append(
                Clap(
                    tMs: onset,
                    audioMs: onset,
                    visualMs: visual,
                    offsetMs: visual.map { visualMs in visualMs - onset }))
        }
        let pass = !claps.isEmpty && claps.allSatisfy {
            guard let offset = $0.offsetMs else { return false }
            return abs(offset) <= toleranceMs
        }
        return ClapAnalysis(claps: claps, toleranceMs: toleranceMs, pass: pass)
    }
}
