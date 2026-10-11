import Foundation

public struct TranscriptCutSuggestion: Codable, Equatable, Sendable {
    public var sourceStartMs: Double
    public var sourceEndMs: Double
    public var reason: String
    public var wordIds: [String]
    public init(sourceStartMs: Double, sourceEndMs: Double, reason: String, wordIds: [String] = []) {
        self.sourceStartMs = sourceStartMs; self.sourceEndMs = sourceEndMs
        self.reason = reason; self.wordIds = wordIds
    }
}

public enum TranscriptEditPlanner {
    public static let fillers: Set<String> = ["um", "uh", "erm", "er", "umm", "uhh"]
    public static func suggestions(words: [TranscriptWord], durationMs: Double, selectedWordIds: Set<String> = [],
                                   removeFillers: Bool = false, removeSilence: Bool = false,
                                   measuredSilence: [TranscriptInterval] = []) throws -> [TranscriptCutSuggestion] {
        guard durationMs.isFinite, durationMs >= 0 else { throw ControlFailure(code: "invalid-params") }
        _ = try CaptionBuilder.build(words: words)
        let removed = Set(words.filter { selectedWordIds.contains($0.id) || (removeFillers &&
            fillers.contains($0.text.lowercased().trimmingCharacters(in: .punctuationCharacters))) }.map(\.id))
        guard selectedWordIds.isSubset(of: Set(words.map(\.id))) else {
            throw ControlFailure(code: "invalid-params", message: "Unknown selected word identifier.")
        }
        let kept = words.filter { !removed.contains($0.id) }
        var candidates = words.filter { removed.contains($0.id) }.map {
            TranscriptCutSuggestion(sourceStartMs: max(0, $0.startMs - 70), sourceEndMs: min(durationMs, $0.endMs + 70),
                                    reason: selectedWordIds.contains($0.id) ? "word" : "filler", wordIds: [$0.id])
        }
        if removeSilence {
            let ordered = words.sorted { $0.startMs < $1.startMs }
            var silent = measuredSilence
            var cursor = 0.0
            for word in ordered {
                if word.startMs > cursor { silent.append(.init(startMs: cursor, endMs: word.startMs)) }
                cursor = max(cursor, word.endMs)
            }
            if cursor < durationMs { silent.append(.init(startMs: cursor, endMs: durationMs)) }
            candidates += silent.filter { $0.startMs.isFinite && $0.endMs.isFinite && $0.endMs - $0.startMs > 1100 }.map {
                .init(sourceStartMs: max(0, $0.startMs + 350), sourceEndMs: min(durationMs, $0.endMs - 350), reason: "silence")
            }
        }
        var cuts: [TranscriptCutSuggestion] = []
        for candidate in candidates {
            var fragments = [candidate]
            for word in kept {
                let protectedStart = max(0, word.startMs - 70), protectedEnd = min(durationMs, word.endMs + 70)
                fragments = fragments.flatMap { fragment -> [TranscriptCutSuggestion] in
                    if protectedEnd <= fragment.sourceStartMs || protectedStart >= fragment.sourceEndMs { return [fragment] }
                    var result: [TranscriptCutSuggestion] = []
                    if protectedStart > fragment.sourceStartMs {
                        var left = fragment; left.sourceEndMs = protectedStart; result.append(left)
                    }
                    if protectedEnd < fragment.sourceEndMs {
                        var right = fragment; right.sourceStartMs = protectedEnd; result.append(right)
                    }
                    return result
                }
            }
            cuts += fragments.filter { $0.sourceEndMs > $0.sourceStartMs }
        }
        let sorted = cuts.sorted { $0.sourceStartMs < $1.sourceStartMs }
        var merged: [TranscriptCutSuggestion] = []
        for cut in sorted {
            if var last = merged.last, cut.sourceStartMs <= last.sourceEndMs {
                last.sourceEndMs = max(last.sourceEndMs, cut.sourceEndMs)
                last.wordIds = Array(Set(last.wordIds + cut.wordIds)).sorted()
                if last.reason != cut.reason { last.reason = "transcript" }
                merged[merged.count - 1] = last
            } else { merged.append(cut) }
        }
        return merged
    }
}

/// Forward-only script matching; called with each on-device recognition update.
public struct TeleprompterMatcher: Sendable {
    public private(set) var position = 0
    public let tokens: [String]
    public init(script: String) { tokens = Self.tokenize(script) }
    @discardableResult public mutating func consume(_ speech: String) -> Int {
        for spoken in Self.tokenize(speech) {
            if let match = tokens[position..<min(tokens.count, position + 8)].firstIndex(of: spoken) {
                position = match + 1
            }
        }
        return position
    }
    private static func tokenize(_ string: String) -> [String] {
        string.lowercased().split { !$0.isLetter && !$0.isNumber }.map(String.init)
    }
}
