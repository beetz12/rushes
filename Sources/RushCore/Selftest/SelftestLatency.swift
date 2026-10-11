import Foundation

/// Where `selftest sync` keeps the measured system-audio latency
/// (docs/PLAN.md, Latency compensation: "Phase 1's `selftest sync` measures
/// this on David's Mac and stores the value as the default. The masters are
/// never shifted; exports and the offsets file apply the value.").
///
/// One JSON file beside the control socket, written atomically. The value is
/// engine-global, not per-recording: it is the default every later take's
/// exports apply.
public struct SelftestLatencyStore: Sendable {

    /// The persisted shape, tolerant of missing fields.
    public struct Stored: Codable, Equatable, Sendable {
        /// Measured system-audio latency in milliseconds: how much later the
        /// tone's onset lands in `system.mov` than the flash's onset in
        /// `screen.mov`.
        public var systemAudioLatencyMs: Double
        /// When the value was measured (ISO 8601 UTC).
        public var measuredAt: String
        /// The recording id whose take produced the value.
        public var recordingId: String?

        public init(systemAudioLatencyMs: Double, measuredAt: String, recordingId: String? = nil) {
            self.systemAudioLatencyMs = systemAudioLatencyMs
            self.measuredAt = measuredAt
            self.recordingId = recordingId
        }
    }

    /// `~/Library/Application Support/Rushes/selftest-latency.json`.
    public static var defaultURL: URL {
        ControlServer.defaultSocketPath.deletingLastPathComponent()
            .appendingPathComponent("selftest-latency.json")
    }

    public let url: URL

    public init(url: URL = SelftestLatencyStore.defaultURL) {
        self.url = url
    }

    /// The stored latency, or nil when nothing was ever measured.
    public func load() -> Stored? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Stored.self, from: data)
    }

    /// Writes the value atomically (temporary file, fsync, rename).
    public func save(_ stored: Stored) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]
        try AtomicFileWriter.writeEncodable(stored, to: url, encoder: encoder)
    }
}
