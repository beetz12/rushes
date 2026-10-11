import AVFoundation
import Speech
import Foundation

/// On-device recognition of a completed package. No network transcription or fallback text.
public enum TranscriptService {
    public static func transcribe(packageURL: URL, localeIdentifier: String = Locale.current.identifier,
                                  allowAssetDownload: Bool = false) async throws -> TranscriptDocument {
        let microphone = packageURL.appendingPathComponent("mic.mov")
        let system = packageURL.appendingPathComponent("system.mov")
        let input = FileManager.default.fileExists(atPath: microphone.path) ? microphone : system
        guard FileManager.default.fileExists(atPath: input.path) else {
            throw ControlFailure(code: "no-audio", message: "This recording has no microphone or system audio track. Enable microphone or system audio for the next take.")
        }
        let canonicalInput = try TranscriptPackageIO.validatedSource(input.lastPathComponent, in: packageURL)
        var document = try await transcribe(audioURL: canonicalInput, localeIdentifier: localeIdentifier,
                                            allowAssetDownload: allowAssetDownload)
        document.inputFile = input.lastPathComponent
        if let prior = try? TranscriptFiles.read(from: packageURL) {
            var appliedCorrectionIds: Set<String> = []
            for index in document.words.indices {
                if let corrected = prior.words.first(where: { $0.source == "user" && !appliedCorrectionIds.contains($0.id) &&
                    abs($0.startMs - document.words[index].startMs) <= 80 &&
                    $0.originalText == document.words[index].originalText }) {
                    appliedCorrectionIds.insert(corrected.id)
                    document.words[index].text = corrected.text
                    document.words[index].source = "user"; document.words[index].id = corrected.id
                }
            }
            // A different ASR segmentation may shift sequential IDs. Preserve correction IDs
            // and rename collided uncorrected IDs rather than losing a valid corrected transcript.
            var used = Set(document.words.filter { $0.source == "user" }.map(\.id))
            for index in document.words.indices where document.words[index].source != "user" {
                let original = document.words[index].id
                if used.contains(original) { document.words[index].id = "\(original)-rerun-\(index)" }
                used.insert(document.words[index].id)
            }
            document.cues = try CaptionBuilder.build(words: document.words)
        }
        try TranscriptFiles.write(document, to: packageURL)
        return document
    }

    public static func transcribe(audioURL: URL, localeIdentifier: String = "en-US",
                                  allowAssetDownload: Bool = false) async throws -> TranscriptDocument {
        guard SpeechTranscriber.isAvailable else {
            throw ControlFailure(code: "speech-unsupported", message: "On-device SpeechTranscriber is unavailable on this Mac. Use a supported Apple silicon Mac running macOS 26.4 or later.")
        }
        let locales = await SpeechTranscriber.supportedLocales
        let requested = Locale(identifier: localeIdentifier)
        let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested)
            ?? locales.first { $0.language.languageCode == requested.language.languageCode }
            ?? locales.first { $0.language.languageCode?.identifier == "en" }
        guard let locale else {
            throw ControlFailure(code: "speech-locale-unsupported", message: "No supported speech language is available.", details: ["locale": .string(localeIdentifier)])
        }
        let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [],
                                           attributeOptions: [.audioTimeRange])
        let assetStatus = await AssetInventory.status(forModules: [transcriber])
        if assetStatus != .installed {
            guard assetStatus != .unsupported else { throw ControlFailure(code: "speech-assets-unsupported", message: "Apple does not provide a speech model for this device and locale.") }
            guard allowAssetDownload else {
                throw ControlFailure(code: "speech-assets-required", message: "Download Apple's on-device speech model for \(locale.identifier) to enable transcription. Audio stays on this Mac.",
                                     details: ["locale": .string(locale.identifier), "canDownload": .bool(true), "audioLeavesDevice": .bool(false)])
            }
            do {
                _ = try await AssetInventory.reserve(locale: locale)
                if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await request.downloadAndInstall()
                }
            } catch {
                throw ControlFailure(code: "speech-assets-install-failed", message: "Apple's speech model could not be installed. Check network access and free disk space, then retry.", details: ["underlying": .string(error.localizedDescription)])
            }
        }
        let temporaryAudio = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-speech-\(UUID().uuidString).m4a")
        defer { try? FileManager.default.removeItem(at: temporaryAudio) }
        let audio: AVAudioFile
        do { audio = try AVAudioFile(forReading: audioURL) }
        catch {
            // AVAudioFile cannot open every MOV container. Export audio locally without touching the master.
            let asset = AVURLAsset(url: audioURL)
            guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
                throw ControlFailure(code: "audio-unreadable", message: "The audio track cannot be decoded.")
            }
            do {
                try await export.export(to: temporaryAudio, as: .m4a)
                audio = try AVAudioFile(forReading: temporaryAudio)
            } catch { throw ControlFailure(code: "audio-unreadable", message: error.localizedDescription) }
        }
        let durationMs = Double(audio.length) / audio.processingFormat.sampleRate * 1000
        let silence = try AudioSilenceDetector.detect(file: audio)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let resultTask = Task { () throws -> [TranscriptWord] in
            var words: [TranscriptWord] = []
            for try await result in transcriber.results {
                for run in result.text.runs {
                    let text = String(result.text[run.range].characters)
                    let tokens = text.split(whereSeparator: \.isWhitespace).map(String.init)
                    guard !tokens.isEmpty else { continue }
                    guard let range = run.audioTimeRange else {
                        throw ControlFailure(code: "speech-timing-missing", message: "Apple returned text without audio times; timed transcription could not be built.")
                    }
                    let start = CMTimeGetSeconds(range.start) * 1000
                    let end = CMTimeGetSeconds(CMTimeRangeGetEnd(range)) * 1000
                    guard start.isFinite, end.isFinite, end > start else { continue }
                    let weights = tokens.map { Double(max(1, $0.count)) }
                    let total = weights.reduce(0, +)
                    var cursor = max(0, start)
                    for (index, token) in tokens.enumerated() {
                        let tokenEnd = index == tokens.count - 1 ? end : cursor + (end - start) * weights[index] / total
                        words.append(TranscriptWord(id: "w\(words.count)", text: token, startMs: cursor, endMs: tokenEnd,
                                                    timing: tokens.count == 1 ? "audio-attribute" : "proportional-audio-attribute"))
                        cursor = tokenEnd
                    }
                }
            }
            return words.sorted { $0.startMs < $1.startMs }
        }
        do {
            _ = try await analyzer.analyzeSequence(from: audio)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            let words = try await resultTask.value
            return try TranscriptDocument(locale: locale.identifier, inputFile: audioURL.lastPathComponent,
                                           durationMs: max(durationMs, words.last?.endMs ?? 0), words: words,
                                           cues: try CaptionBuilder.build(words: words, silence: silence))
        } catch {
            await analyzer.cancelAndFinishNow(); resultTask.cancel()
            if let failure = error as? ControlFailure { throw failure }
            let nsError = error as NSError
            let permission = nsError.localizedDescription.localizedCaseInsensitiveContains("permission") ||
                nsError.localizedDescription.localizedCaseInsensitiveContains("authorization")
            throw ControlFailure(code: permission ? "permission-denied" : "speech-analysis-failed",
                message: permission ? "Allow Speech Recognition for Rushes in System Settings > Privacy & Security, then retry." : "On-device transcription failed: \(nsError.localizedDescription)",
                details: ["permission": .string("speech"), "settings": .string("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")])
        }
    }
}

public enum TranscriptCommands {
    public static let commands: Set<String> = ["transcript.get", "transcribe", "transcript.run", "transcript.edit-plan", "transcript.correct", "captions.export"]
    public static func handle(request: ControlRequest, packageURL: URL) async throws -> JSONValue {
        let args = request.args?.object ?? [:]
        switch request.cmd {
        case "transcribe", "transcript.run":
            let document = try await TranscriptService.transcribe(packageURL: packageURL,
                localeIdentifier: args["locale"]?.string ?? Locale.current.identifier,
                allowAssetDownload: args["allowAssetDownload"]?.bool ?? false)
            return try JSONValue(encoding: document)
        case "transcript.get": return try JSONValue(encoding: TranscriptFiles.read(from: packageURL))
        case "transcript.edit-plan":
            let doc = try TranscriptFiles.read(from: packageURL)
            var measuredSilence: [TranscriptInterval] = []
            if args["levelSilence"]?.bool == true {
                let source = try TranscriptPackageIO.validatedSource(doc.inputFile, in: packageURL)
                measuredSilence = try await AudioSilenceDetector.detect(audioURL: source)
            }
            let cuts = try TranscriptEditPlanner.suggestions(words: doc.words, durationMs: doc.durationMs,
                selectedWordIds: Set(args["wordIds"]?.array?.compactMap(\.string) ?? []),
                removeFillers: args["removeFillers"]?.bool ?? false, removeSilence: args["removeSilence"]?.bool ?? false,
                measuredSilence: measuredSilence)
            return try JSONValue(encoding: cuts)
        case "transcript.correct":
            guard let wordId = args["wordId"]?.string, let text = args["text"]?.string,
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.count <= 1024 else {
                throw ControlFailure(code: "invalid-params", message: "wordId and nonempty text (up to 1024 characters) are required.")
            }
            var doc = try TranscriptFiles.read(from: packageURL)
            guard let index = doc.words.firstIndex(where: { $0.id == wordId }) else { throw ControlFailure(code: "not-found", message: "Word identifier not found.") }
            doc.words[index].text = text.split(whereSeparator: \.isWhitespace).joined(separator: " "); doc.words[index].source = "user"
            doc.cues = try CaptionBuilder.build(words: doc.words); try TranscriptFiles.write(doc, to: packageURL)
            return try JSONValue(encoding: doc)
        case "captions.export":
            guard let format = TranscriptFormat(rawValue: args["format"]?.string ?? "vtt") else { throw ControlFailure(code: "invalid-params", message: "Format must be json, srt, vtt or txt.") }
            let doc = try TranscriptFiles.read(from: packageURL), data = try TranscriptFiles.export(doc, format: format)
            if let path = args["output"]?.string ?? args["outputPath"]?.string {
                let destination = try TranscriptPackageIO.validatedExport(path, extension: format.rawValue, packageURL: packageURL)
                try AtomicFileWriter.write(data, to: destination)
                return .object(["path": .string(path), "format": .string(format.rawValue)])
            }
            return .object(["text": .string(String(decoding: data, as: UTF8.self)), "format": .string(format.rawValue)])
        default: throw ControlFailure(code: "unknown-command")
        }
    }
}
