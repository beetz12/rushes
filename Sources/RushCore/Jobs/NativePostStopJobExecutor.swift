import Foundation

public struct NativePostStopJobExecutor:PostStopJobExecuting {
    public typealias Enrich = @Sendable (String) async throws -> ControlResponse
    public typealias Generate = @Sendable (TranscriptDocument,JobMetadataMode) async throws -> RecordingMetadata
    public typealias CurrentEdit = @Sendable (String) async throws -> EditDocument
    public typealias Transcribe = @Sendable (URL,String,Bool) async throws -> TranscriptDocument
    private let enrich:Enrich
    private let transcribe:Transcribe
    private let generate:Generate
    private let currentEdit:CurrentEdit?
    public init(enrich:@escaping Enrich = { _ in throw ControlFailure(code:"shell-required",message:"Open Rushes to enrich an existing share") },
                transcribe:@escaping Transcribe = { url,locale,download in
                    try await TranscriptService.transcribe(packageURL:url,localeIdentifier:locale,allowAssetDownload:download)
                },generate:@escaping Generate = { transcript,mode in
                    if mode == .extractive { return try MetadataService.extractive(transcript:transcript) }
                    return try await MetadataService.generate(transcript:transcript,preferLanguageModel:true)
                },currentEdit:CurrentEdit? = nil) {
        self.enrich=enrich; self.transcribe=transcribe; self.generate=generate; self.currentEdit=currentEdit
    }
    public func execute(_ job:PostStopJob,package:RecordingPackage) async throws -> PostStopJobExecution {
        try Task.checkCancellation()
        let manifest=try package.readManifest()
        guard !PendingWriterFiles.shared.contains(in:package.folderURL) else { throw jobFailure("finalization-pending","Native writing has not finished. Checking will retry; relaunch Rushes if it stays pending. Originals are kept.") }
        let diagnostic = job.kind == .verify && manifest.status == .failed && manifest.tracks.contains(where: \.present)
        guard diagnostic || ([.complete,.recovered].contains(manifest.status) && (job.kind == .verify || manifest.verified?.ok != false)) else { throw jobFailure("recording-unverified","Finalize and verify this recording before post-Stop work") }
        switch job.kind {
        case .verify:
            let report=await PackageVerifier().verify(package)
            // A cancelled decode never writes a successful or failed stamp.
            try Task.checkCancellation()
            let artifact=PostStopVerificationReport(report:report)
            let path=try PostproductionPaths.managedFile("verification.json",in:package.folderURL)
            let encoder=JSONEncoder(); encoder.outputFormatting = [.sortedKeys,.withoutEscapingSlashes]
            try AtomicFileWriter.write(encoder.encode(artifact),to:path)
            try Task.checkCancellation()
            var latest=try package.readManifest()
            latest.verified = .init(at:artifact.at,ok:report.ok)
            try package.writeManifest(latest)
            guard report.ok else {
                let issues=report.issues+report.trackChecks.flatMap(\.issues)
                throw jobFailure("verification-failed","Full media decode failed: "+issues.joined(separator:"; "))
            }
            return .init(result:.object(["artifact":.string("verification.json"),"ok":.bool(true),"tracks":.int(Int64(report.trackChecks.filter{!$0.skipped}.count))]))
        case .transcribe:
            let expected=try await transcribe(package.folderURL,job.options.locale,job.options.allowAssetDownload)
            try Task.checkCancellation()
            let actual=try TranscriptFiles.read(from:package.folderURL)
            guard actual == expected else { throw jobFailure("transcript-verification-failed","Stored transcript differs from the completed recognition result") }
            return .init(result:.object(["artifact":.string("transcript.json"),"words":.int(Int64(actual.words.count)),"noSpeech":.bool(actual.words.isEmpty),"engine":.string(actual.engine)]))
        case .metadata:
            let transcriptURL=try PostproductionPaths.file("transcript.json",in:package.folderURL)
            let transcriptBytes=try Data(contentsOf:transcriptURL)
            let transcript=try TranscriptFiles.read(from:package.folderURL)
            let metadataURL=try PostproductionPaths.managedFile("metadata.json",in:package.folderURL)
            let originalMetadata=FileManager.default.fileExists(atPath:metadataURL.path) ? try Data(contentsOf:metadataURL) : nil
            if originalMetadata != nil {
                let current=try MetadataService.read(from:package.folderURL)
                if current.engine == "user" {
                    try current.validate(durationMs:manifest.clock?.durationNs.map { Double($0)/1_000_000 })
                    return .init(result:.object(["artifact":.string("metadata.json"),"engine":.string(current.engine),"preservedUserMetadata":.bool(true)]))
                }
            }
            let editFiles=try editState(package)
            let liveEdit=try await currentEdit?(job.recordingId)
            let userEdit=liveEdit ?? editFiles.edit
            var generated:RecordingMetadata
            if transcript.words.isEmpty {
                generated = .init(title:manifest.title ?? "Recording",summary:"No speech was detected.",chapters:[],engine:"no-speech")
            } else if job.options.metadataMode == .extractive {
                generated=try await generate(transcript,.extractive)
            } else {
                generated=try await generate(transcript,.apple)
                guard generated.engine.hasPrefix("Apple FoundationModels") else { throw jobFailure("metadata-model-required",generated.warning ?? "Enable Apple Intelligence or explicitly retry with extractive metadata") }
            }
            try Task.checkCancellation()
            var preserved:[String]=[]
            if let userEdit {
                if !untitled(userEdit.meta.title) { generated.title=userEdit.meta.title; preserved.append("title") }
                if let summary=userEdit.meta.summary { generated.summary=summary; preserved.append("summary") }
                if !userEdit.meta.chapters.isEmpty { generated.chapters=userEdit.meta.chapters.map { .init(startMs:$0.startMs,title:$0.title) }; preserved.append("chapters") }
            }
            let latestLiveEdit=try await currentEdit?(job.recordingId)
            let currentMetadata=FileManager.default.fileExists(atPath:metadataURL.path) ? try Data(contentsOf:metadataURL) : nil
            let currentManifest=try package.readManifest()
            guard currentMetadata == originalMetadata,currentManifest.title == manifest.title,
                  try Data(contentsOf:transcriptURL) == transcriptBytes,try editState(package).bytes == editFiles.bytes,latestLiveEdit?.meta == liveEdit?.meta else { throw jobFailure("metadata-changed","Newer transcript, metadata or title was preserved; generation did not overwrite it") }
            try generated.validate(durationMs:currentManifest.clock?.durationNs.map { Double($0)/1_000_000 })
            try MetadataService.write(generated,to:package.folderURL)
            let updateTitle=untitled(currentManifest.title) && !preserved.contains("title")
            if updateTitle { var titled=currentManifest; titled.title=generated.title; try package.writeManifest(titled) }
            let actual=try MetadataService.read(from:package.folderURL)
            guard actual == generated else { throw jobFailure("metadata-verification-failed","Stored metadata differs from the generated result") }
            return .init(result:.object(["artifact":.string("metadata.json"),"engine":.string(actual.engine),"warning":.string(actual.warning),"noSpeech":.bool(transcript.words.isEmpty),"preservedFields":.array(preserved.map(JSONValue.string)),"canonicalTitleUpdated":.bool(updateTitle)]))
        case .enrich:
            let response=try await enrich(job.recordingId)
            guard response.ok else { throw ControlFailure(code:response.error?.code ?? "share-enrichment-failed",message:response.error?.message ?? "Desktop enrichment failed") }
            guard let updated=response.result?["updated"]?.bool else { throw jobFailure("enrichment-invalid-response","Desktop enrichment did not report whether metadata was applied") }
            if !updated {
                if response.result?["reason"]?.string == "processing" { throw jobFailure("share-processing","Published video is still processing; enrichment will retry") }
                guard let reason=response.result?["reason"]?.string,["not-shared","unshared","no-state"].contains(reason) else { throw jobFailure("enrichment-invalid-response","Desktop did not apply enrichment and gave an unknown reason") }
                return .init(result:.object(["updated":.bool(false),"reason":.string("not-shared")]),notApplicable:true)
            }
            guard let url=response.result?["url"]?.string,let parsed=URLComponents(string:url),["https","http"].contains(parsed.scheme ?? ""),parsed.host != nil,parsed.user == nil,parsed.password == nil else { throw jobFailure("enrichment-invalid-response","Desktop enrichment succeeded without a valid published URL") }
            return .init(result:.object(["updated":.bool(true),"url":.string(url)]))
        }
    }
    private func untitled(_ title:String?) -> Bool {
        guard let title else { return true }
        return ["","recording","untitled","untitled recording"].contains(title.trimmingCharacters(in:.whitespacesAndNewlines).lowercased())
    }
    private func editState(_ package:RecordingPackage) throws -> (bytes:[Data?],edit:EditDocument?) {
        var bytes:[Data?]=[]
        for name in ["edit.draft.json","edit.json"] {
            let url=try PostproductionPaths.managedFile(name,in:package.folderURL)
            bytes.append(FileManager.default.fileExists(atPath:url.path) ? try Data(contentsOf:url) : nil)
        }
        let edit=try (bytes[0] ?? bytes[1]).map { try JSONDecoder().decode(EditDocument.self,from:$0) }
        return (bytes,edit)
    }

}
