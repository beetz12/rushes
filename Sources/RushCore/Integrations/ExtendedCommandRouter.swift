import Foundation

/// Local postproduction services are addressed by the same engine table as
/// recording. Sharing delegates only the credential-bearing work to the shell.
public actor ExtendedCommandRouter {
    public static let cloudCommands: Set<String> = ["share", "share.setup", "share.status", "share.enrich", "share.policy.get", "share.policy.set", "share.feedback", "unshare"]
    public static var commands: Set<String> {
        PostproductionService.commands.union(TranscriptCommands.commands)
            .union(MetadataCommands.commands).union(cloudCommands).union(PostStopJobService.commands).union(["diagnostics"])
    }
    public static var commandDocs: [ControlGuide.CommandDoc] {
        let descriptions: [String: String] = [
            "export": "Render edited media locally; share/full/youtube/audio/editor-tracks presets preserve masters.",
            "thumbnail": "Export a composed frame as PNG or JPEG.",
            "transcribe": "Recognize recorded speech locally and save JSON/SRT/VTT/TXT.",
            "transcript.run": "Run Apple's local speech analyzer; allowAssetDownload explicitly enables first-use model setup.",
            "captions.export": "Export stored subtitles as json/srt/vtt/txt to a separate local path.",
            "meta.generate": "Generate local title, summary and chapters; identify an extractive fallback when Apple Intelligence is unavailable.",
            "meta.set": "Set user metadata; update canonical recording title and searchable index.",
            "share": "Reserve a real processing URL; wait=true waits for video readiness. Requires configured Rushes desktop service.",
            "share.setup": "Probe configured sharing provider; never treats an unconfigured provider as success.",
            "share.status": "Read local sharing state without changing or deleting the share.",
            "share.policy.get": "Read this stable Worker's password-protection and expiry state; never returns a password.",
            "share.policy.set": "Change Worker password protection or expiry at the existing link; null removes a setting.",
            "share.feedback": "Read this Worker's playback count, comments and reactions.",
            "unshare": "Remove this recording's published share; local footage stays unchanged.",
            "diagnostics": "Export redacted textual diagnostics ZIP; excludes media/transcripts.",
            "recover": "Recover interrupted packages while idle, preserving all original footage.",
        ]
        let names = commands.union(["recover"]).sorted()
        return names.map { name in
            var params: [ControlGuide.ParamDoc] = []
            if !["share.setup", "diagnostics", "recover", "jobs.list", "jobs.retry", "jobs.cancel"].contains(name) {
                params.append(.init(name: "id", type: "string", required: true, description: "Recording ULID from list/show."))
            }
            if name == "export" {
                params += [.init(name: "preset", flag: "--preset", type: "share|full|youtube|audio|editor-tracks", description: "Export format/purpose."),
                           .init(name: "path", flag: "-o", type: "absolute local path", description: "Destination outside masters or within renders."),
                           .init(name: "sourceSize", flag: "--source-size", type: "boolean", description: "YouTube output keeps source/current canvas resolution instead of forcing 1920x1080.")]
            }
            if name == "captions.export" || name == "transcribe" {
                params.append(.init(name: "format", flag: "--format", type: "json|srt|vtt|txt", description: "Subtitle/transcript output type."))
            }
            if name == "jobs.list" { params.append(.init(name: "id", type: "string", description: "Optional recording ULID to filter durable jobs.")) }
            if ["jobs.retry", "jobs.cancel"].contains(name) { params.append(.init(name: "jobId", type: "string", required: true, description: "Job UUID from jobs list.")) }
            if name == "jobs.retry" { params += [.init(name: "allowAssetDownload", type: "boolean", description: "Explicitly allow first-use Apple model setup."), .init(name: "metadataMode", type: "string", description: "apple or explicitly chosen extractive.")] }
            if name == "share" { params.append(.init(name: "wait", flag: "--wait", type: "boolean", description: "Wait for real upload/publish completion.")) }
            if name == "share" || name == "share.policy.set" {
                params += [.init(name: "password", flag: "--password-file", type: "string|null", description: "Worker password from a UTF-8 file; --remove-password sends null."),
                           .init(name: "expiresAt", flag: "--expires-at", type: "string|null", description: "Future ISO date; --clear-expiry sends null.")]
            }
            return .init(name: name, cli: [name.replacingOccurrences(of: ".", with: " ")],
                summary: descriptions[name] ?? "\(name): validated local recording service.",
                usage: "rushes \(name.replacingOccurrences(of: ".", with: " ")) [ID] [options]",
                params: params, result: "JSON service result; structured code/message on failure.")
        }
    }
    private let root: URL
    private let index: PackageIndex
    private let production: PostproductionService
    private let sharing: ShellServiceBridge
    private let jobs: PostStopJobService
    private var jobsPrepared = false

    public init(root: URL, index: PackageIndex, shellSocket: URL) {
        self.root = root
        self.index = index
        let production = PostproductionService(root: root)
        let sharing = ShellServiceBridge(socketPath: shellSocket)
        self.production = production
        self.sharing = sharing
        jobs = PostStopJobService(root: root, executor: NativePostStopJobExecutor(enrich: { id in
            guard let package = RecordingPackage.resolve(root: root, id: id) else { throw ControlFailure(code: "not-found") }
            let folder = package.folderURL.standardizedFileURL.resolvingSymlinksInPath()
            let state = folder.appendingPathComponent("share/state.json").standardizedFileURL.resolvingSymlinksInPath()
            guard state.path.hasPrefix(folder.path + "/share/") else { throw ControlFailure(code: "unsafe-package-path") }
            if !FileManager.default.fileExists(atPath: state.path) {
                return .success(id: id, result: .object(["updated": .bool(false), "reason": .string("no-state")]))
            }
            return try await sharing.forward(.init(id: UUID().uuidString, cmd: "share.enrich", args: .object(["id": .string(id)])), timeout: 30)
        }, currentEdit: { id in try await production.getEdit(id: id) }))
    }

    public func prepare(eventSink: @escaping @Sendable (ControlEvent) -> Void) async throws {
        jobsPrepared = true
        await jobs.setEventSink { event in
            eventSink(ControlEvent(kind: .jobChanged, result: try? postStopJobJSON(event)))
        }
        await jobs.setArtifactDidWrite { [weak self] id in try await self?.refreshIndex(id: id) }
        _ = try await jobs.resume()
    }
    public func setCaptureActive(_ active: Bool) async throws { try await jobs.setCaptureActive(active || !jobsPrepared) }
    public func enqueueAfterStop(id: String) async throws { _ = try await jobs.enqueueAfterStop(id: id) }
    public func cancelRecordingJobs(id: String) async throws { _ = try await jobs.cancelRecording(id: id) }
    public func allowRecordingJobs(id: String) async { await jobs.allowRecording(id: id) }
    public func shutdownJobs() async throws { try await jobs.shutdown() }

    public func handle(_ request: ControlRequest) async throws -> JSONValue {
        try validateOutput(request)
        if PostStopJobService.commands.contains(request.cmd) { return try await jobs.handle(request) }
        if Self.cloudCommands.contains(request.cmd) {
            let response = try await sharing.forward(request)
            guard response.ok else {
                throw ControlFailure(code: response.error?.code ?? "share-failed",
                                     message: response.error?.message)
            }
            if let id = request.param("id")?.string { try await refreshIndex(id: id) }
            return response.result ?? .object([:])
        }
        if PostproductionService.commands.contains(request.cmd) {
            return try await production.handle(request)
        }
        if request.cmd == "diagnostics" {
            guard let path = request.param("path")?.string ?? request.param("outputPath")?.string else {
                throw ControlFailure(code: "invalid-params", message: "diagnostics needs a local .zip output path")
            }
            var entries = ["engine.txt": "Rushes native engine\nLocal-first services; no audio or transcripts in this bundle.\n"]
            if let id = request.param("id")?.string {
                let package = try resolve(id)
                entries["manifest.json"] = String(decoding: try Data(contentsOf: package.manifestURL), as: UTF8.self)
                let log = try package.validatedMediaURL("log.ndjson")
                if FileManager.default.fileExists(atPath: log.path) {
                    let handle = try FileHandle(forReadingFrom: log)
                    defer { try? handle.close() }
                    entries["log.ndjson"] = String(decoding: try handle.read(upToCount: 1_048_576) ?? Data(), as: UTF8.self)
                }
            }
            let url = try DiagnosticsBundle.write(outputURL: URL(fileURLWithPath: path), entries: entries)
            return .object(["path": .string(url.path)])
        }
        guard let id = request.param("id")?.string else {
            throw ControlFailure(code: "invalid-params", message: "recording id is required")
        }
        let package = try resolve(id)
        let value: JSONValue
        if TranscriptCommands.commands.contains(request.cmd) {
            value = try await TranscriptCommands.handle(request: request, packageURL: package.folderURL)
            if ["transcribe", "transcript.run", "transcript.correct"].contains(request.cmd) {
                try await refreshIndex(id: id)
                _ = try await jobs.queueEnrichment(id: id)
            }
        } else if MetadataCommands.commands.contains(request.cmd) {
            value = try await MetadataCommands.handle(request: request, packageURL: package.folderURL)
            if request.cmd == "meta.set" || request.cmd == "meta.generate" {
                var manifest = try package.readManifest()
                let metadata = try MetadataService.read(from: package.folderURL)
                try metadata.validate(durationMs: manifest.clock?.durationNs.map { Double($0) / 1e6 })
                manifest.title = metadata.title
                try package.writeManifest(manifest)
                try await refreshIndex(id: id)
                _ = try await jobs.queueEnrichment(id: id)
            }
        } else {
            throw ControlFailure(code: "unknown-command")
        }
        return value
    }

    public func refreshIndex(id: String) async throws {
        let package = try resolve(id)
        let manifest = try package.readManifest()
        let previous = try await index.row(id: id)
        let transcript = try package.validatedMediaURL("transcript.json")
        var shareURL = previous?.shareURL
        let folder = package.folderURL.standardizedFileURL.resolvingSymlinksInPath()
        let state = folder.appendingPathComponent("share/state.json").standardizedFileURL.resolvingSymlinksInPath()
        guard state.path.hasPrefix(folder.path + "/share/") else {
            throw ControlFailure(code: "unsafe-package-path", message: "Share state must remain inside this recording package")
        }
        if FileManager.default.fileExists(atPath: state.path) {
            let data = try Data(contentsOf: state)
            guard data.count <= 1_048_576,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  object["schema"] as? String == "rushes.shell-share/1" else {
                throw ControlFailure(code: "invalid-share-state")
            }
            let reservation = object["reservation"] as? [String: Any]
            shareURL = object["state"] as? String == "unshared" ? nil : reservation?["url"] as? String
        } else {
            let legacy = try package.validatedMediaURL("share.json")
            if FileManager.default.fileExists(atPath: legacy.path),
               let object = try JSONSerialization.jsonObject(with: Data(contentsOf: legacy)) as? [String: Any] {
                shareURL = object["unshared"] as? Bool == true ? nil : object["url"] as? String
            }
        }
        try await index.upsert(.init(id: id, folder: package.folderURL.path, title: manifest.title,
            createdAt: manifest.createdAt ?? "", durationMs: manifest.clock?.durationNs.map { $0 / 1_000_000 },
            status: manifest.status.rawValue, shareURL: shareURL,
            transcriptState: FileManager.default.fileExists(atPath: transcript.path) ? "done" : "none"))
    }

    private func resolve(_ id: String) throws -> RecordingPackage {
        guard RecordingId.isValid(id), let package = RecordingPackage.resolve(root: root, id: id) else {
            throw ControlFailure(code: "not-found", message: "recording was not found")
        }
        return package
    }

    /// Text/diagnostic exports must preserve every take's original files too.
    private func validateOutput(_ request: ControlRequest) throws {
        for key in ["output", "outputPath", "path"] {
            guard let value = request.param(key) else { continue }
            guard let path = value.string, path.hasPrefix("/") else {
                throw ControlFailure(code: "invalid-params", message: "\(key) must be an absolute local output path")
            }
            let target = URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath()
            for entry in try RecordingPackage.scanManifests(root: root) {
                let folder = entry.package.folderURL.standardizedFileURL.resolvingSymlinksInPath()
                if target.path == folder.path || target.path.hasPrefix(folder.path + "/") {
                    let renders = folder.appendingPathComponent("renders").path + "/"
                    guard target.path.hasPrefix(renders) else {
                        throw ControlFailure(code: "protected-master", message: "Export to a separate folder or this take's renders folder.")
                    }
                }
            }
        }
    }
}
