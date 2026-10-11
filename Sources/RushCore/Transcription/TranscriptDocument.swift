import Foundation

public struct TranscriptWord: Codable, Equatable, Sendable {
    public var id: String
    public var text: String
    public var startMs: Double
    public var endMs: Double
    public var source: String
    public var originalText: String
    public var timing: String

    public init(id: String = UUID().uuidString, text: String, startMs: Double, endMs: Double,
                source: String = "asr", originalText: String? = nil, timing: String = "audio-attribute") {
        self.id = id; self.text = text; self.startMs = startMs; self.endMs = endMs
        self.source = source; self.originalText = originalText ?? text; self.timing = timing
    }
}

public struct TranscriptCue: Codable, Equatable, Sendable {
    public var startMs: Double
    public var endMs: Double
    public var wordIds: [String]
    public var text: String
    public init(startMs: Double, endMs: Double, wordIds: [String], text: String) {
        self.startMs = startMs; self.endMs = endMs; self.wordIds = wordIds; self.text = text
    }
}

public struct TranscriptInterval: Codable, Equatable, Sendable {
    public var startMs: Double
    public var endMs: Double
    public init(startMs: Double, endMs: Double) { self.startMs = startMs; self.endMs = endMs }
}

public struct TranscriptDocument: Codable, Equatable, Sendable {
    public var schema: String = "rushes.transcript/1"
    public var locale: String
    public var inputFile: String
    public var durationMs: Double
    public var words: [TranscriptWord]
    public var cues: [TranscriptCue]
    public var engine: String
    public init(locale: String, inputFile: String, durationMs: Double, words: [TranscriptWord],
                cues: [TranscriptCue]? = nil, engine: String = "Apple SpeechAnalyzer") throws {
        self.locale = locale; self.inputFile = inputFile; self.durationMs = durationMs
        self.words = words; self.engine = engine
        self.cues = try cues ?? CaptionBuilder.build(words: words)
        try validate()
    }
    public var text: String { words.map(\.text).joined(separator: " ") }
    public func validate() throws {
        guard schema == "rushes.transcript/1", durationMs.isFinite, durationMs >= 0,
              Set(words.map(\.id)).count == words.count else {
            throw ControlFailure(code: "invalid-transcript", message: "Invalid transcript schema, duration or duplicate word identifiers.")
        }
        var previousStart = -Double.infinity, previousEnd = -Double.infinity
        for word in words {
            guard word.startMs.isFinite, word.endMs.isFinite, word.startMs >= 0,
                  word.endMs > word.startMs, !word.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  word.startMs >= previousStart else {
                throw ControlFailure(code: "invalid-transcript", message: "Word times must be finite, ordered and nonempty.")
            }
            previousStart = word.startMs
        }
        previousStart = -Double.infinity
        let ids = Set(words.map(\.id))
        for cue in cues {
            guard cue.startMs.isFinite, cue.endMs.isFinite, cue.startMs >= 0,
                  cue.startMs > previousStart, cue.endMs > previousEnd, cue.endMs > cue.startMs,
                  cue.endMs - cue.startMs <= 4000, cue.text.count <= 42,
                  cue.wordIds.allSatisfy(ids.contains) else {
                throw ControlFailure(code: "invalid-transcript", message: "Caption times or length exceed the caption limits.")
            }
            previousStart = cue.startMs; previousEnd = cue.endMs
        }
    }
}

public enum CaptionBuilder {
    public static func build(words: [TranscriptWord], silence: [TranscriptInterval] = []) throws -> [TranscriptCue] {
        let sorted = words.sorted { $0.startMs == $1.startMs ? $0.endMs < $1.endMs : $0.startMs < $1.startMs }
        var cues: [TranscriptCue] = []
        for word in sorted {
            guard word.startMs.isFinite, word.endMs.isFinite, word.startMs >= 0, word.endMs > word.startMs else {
                throw ControlFailure(code: "invalid-transcript", message: "Cannot caption malformed word times.")
            }
            if silence.contains(where: { $0.startMs <= word.startMs && $0.endMs >= word.endMs }) { continue }
            let characters = Array(word.text.trimmingCharacters(in: .whitespacesAndNewlines))
            guard !characters.isEmpty else { continue }
            let pieces = stride(from: 0, to: characters.count, by: 42).map {
                String(characters[$0..<min($0 + 42, characters.count)])
            }
            for (index, piece) in pieces.enumerated() {
                let fraction = (word.endMs - word.startMs) / Double(pieces.count)
                let rawStart = word.startMs + Double(index) * fraction
                let rawEnd = rawStart + fraction
                let start = max(rawStart, cues.last?.endMs ?? 0)
                let end = max(start + 1, min(rawEnd, start + 4000))
                if var last = cues.last,
                   pieces.count == 1, rawStart - last.endMs < 900,
                   end - last.startMs <= 4000,
                   (last.text + " " + piece).count <= 42 {
                    last.text += " " + piece; last.endMs = max(last.endMs + 1, end)
                    last.wordIds.append(word.id); cues[cues.count - 1] = last
                } else {
                    cues.append(.init(startMs: start, endMs: end, wordIds: [word.id], text: piece))
                }
            }
        }
        return cues
    }
}

public enum TranscriptFormat: String, Codable, CaseIterable, Sendable { case json, srt, vtt, txt }

public enum TranscriptFiles {
    public static func read(from packageURL: URL) throws -> TranscriptDocument {
        let document = try JSONDecoder().decode(TranscriptDocument.self,
            from: Data(contentsOf: packageURL.appendingPathComponent("transcript.json")))
        try document.validate(); return document
    }
    public static func write(_ document: TranscriptDocument, to packageURL: URL) throws {
        try document.validate()
        for format in TranscriptFormat.allCases {
            let name = format == .json ? "transcript.json" : format == .txt ? "transcript.txt" : "captions.\(format.rawValue)"
            try AtomicFileWriter.write(export(document, format: format), to: packageURL.appendingPathComponent(name))
        }
    }
    public static func export(_ document: TranscriptDocument, format: TranscriptFormat) throws -> Data {
        try document.validate()
        if format == .json {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            return try encoder.encode(document)
        }
        if format == .txt { return Data((document.text + "\n").utf8) }
        var text = format == .vtt ? "WEBVTT\n\n" : ""
        for (index, cue) in document.cues.enumerated() {
            if format == .srt { text += "\(index + 1)\n" }
            text += "\(timestamp(cue.startMs, separator: format == .srt ? "," : ".")) --> \(timestamp(cue.endMs, separator: format == .srt ? "," : "."))\n"
            // Subtitles are plain text. Escape markup so recognized '<' cannot become a cue tag.
            text += cue.text.replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;") + "\n\n"
        }
        return Data(text.utf8)
    }
    private static func timestamp(_ milliseconds: Double, separator: String) -> String {
        let ms = Int(milliseconds.rounded())
        return String(format: "%02d:%02d:%02d%@%03d", ms / 3_600_000, (ms / 60_000) % 60,
                      (ms / 1000) % 60, separator, ms % 1000)
    }
}
