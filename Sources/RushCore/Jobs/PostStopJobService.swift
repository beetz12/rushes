import Foundation

public struct PostStopJobIssue:Codable,Sendable { public var recordingId:String; public var code:String; public var message:String }
public struct PostStopJobListing:Codable,Sendable { public var jobs:[PostStopJob]; public var errors:[PostStopJobIssue] }

/// One serial runtime owns each package ledger. Persisted state is authoritative;
/// a process restart never converts an unfinished attempt into success.
public actor PostStopJobService {
    public static let commands:Set<String>=["jobs.list","jobs.retry","jobs.cancel"]
    public let root:URL
    private let executor:any PostStopJobExecuting
    private var eventSink:(@Sendable(PostStopJobEvent)->Void)?
    private var artifactDidWrite:(@Sendable(String) async throws->Void)?
    private let clock:@Sendable()->Date
    private var ledgers:[String:PostStopJobLedger]=[:]
    private var issues:[String:PostStopJobIssue]=[:]
    private var runner:Task<Void,Never>?
    private var retryTimer:Task<Void,Never>?
    private var activeTask:Task<PostStopJobExecution,any Error>?
    private var activeJobId:String?
    private var captureActive=false
    private var stopping=false
    private var blockedRecordings:Set<String>=[]
    private var completionWaiters:[String:[CheckedContinuation<Void,Never>]]=[:]
    public init(root:URL = RecordingPackage.defaultRoot,executor:any PostStopJobExecuting = NativePostStopJobExecutor(),
                eventSink:(@Sendable(PostStopJobEvent)->Void)? = nil,
                artifactDidWrite:(@Sendable(String) async throws->Void)? = nil,
                clock:@escaping @Sendable()->Date = {Date()}) {
        self.root=root; self.executor=executor; self.eventSink=eventSink; self.artifactDidWrite=artifactDidWrite; self.clock=clock
    }
    public func setEventSink(_ sink:(@Sendable(PostStopJobEvent)->Void)?) { eventSink=sink }
    public func setArtifactDidWrite(_ callback:(@Sendable(String) async throws->Void)?) { artifactDidWrite=callback }
    @discardableResult public func resume() throws -> PostStopJobListing {
        stopping=false
        for entry in try RecordingPackage.scanManifests(root:root) {
            do {
                let package=try resolve(entry.manifest.id)
                let path=try ledgerURL(package)
                guard FileManager.default.fileExists(atPath:path.path) else { continue }
                var ledger=try read(package)
                for index in ledger.jobs.indices where ledger.jobs[index].status == .running {
                    interrupt(&ledger.jobs[index],code:"interrupted",message:"Engine restarted before this attempt completed")
                }
                for index in ledger.jobs.indices where ledger.jobs[index].status == .failed && canRetry(ledger.jobs[index]) {
                    ledger.jobs[index].status = .queued; ledger.jobs[index].nextRetryAt=nil
                }
                try save(ledger,package:package)
            } catch { recordIssue(entry.manifest.id,error:error) }
        }
        startRunner(); return listing()
    }
    @discardableResult public func enqueueAfterStop(id:String,locale:String = Locale.current.identifier,metadataMode:JobMetadataMode = .apple) throws -> [PostStopJob] {
        guard !blockedRecordings.contains(id) else { throw jobFailure("recording-busy","Recording is being closed or moved") }
        let package=try resolve(id),manifest=try package.readManifest()
        guard [.complete,.recovered].contains(manifest.status) || (manifest.status == .failed && manifest.tracks.contains(where: \.present)) else { throw jobFailure("recording-not-finalized","Stop and finalize the recording before queuing work") }
        var ledger=try load(package)
        if manifest.status == .failed {
            // Surviving tracks deserve a diagnostic decode, not transcription,
            // sharing or promotion to a successful recording.
            if !ledger.jobs.contains(where:{$0.kind == .verify}) {
                ledger.jobs.append(PostStopJob(recordingId:id,kind:.verify,now:clock()))
                try save(ledger,package:package); startRunner()
            }
            return ledger.jobs
        }
        if ledger.jobs.contains(where:{$0.kind == .transcribe}) {
            if !ledger.jobs.contains(where:{$0.kind == .verify}) {
                ledger.jobs.append(PostStopJob(recordingId:id,kind:.verify,now:clock()))
                try save(ledger,package:package); startRunner()
            }
            return ledger.jobs
        }
        let options=PostStopJobOptions(locale:locale,metadataMode:metadataMode),now=clock()
        let speech=PostStopJob(recordingId:id,kind:.transcribe,options:options,now:now)
        let metadata=PostStopJob(recordingId:id,kind:.metadata,dependsOn:[speech.id],options:options,now:now)
        let enrich=PostStopJob(recordingId:id,kind:.enrich,dependsOn:[metadata.id],options:options,now:now)
        // Decode is independent, and lower priority than transcript/share work.
        let verification=PostStopJob(recordingId:id,kind:.verify,options:options,now:now)
        ledger.jobs += [speech,metadata,enrich,verification]
        try save(ledger,package:package); startRunner(); return ledger.jobs
    }
    @discardableResult public func queueEnrichment(id:String) throws -> PostStopJob {
        guard !blockedRecordings.contains(id) else { throw jobFailure("recording-busy","Recording is being closed or moved") }
        let package=try resolve(id); var ledger=try load(package)
        if let index=ledger.jobs.lastIndex(where:{$0.kind == .enrich && $0.status == .queued}) {
            // An explicit manual artifact update supersedes failed dependencies.
            ledger.jobs[index].dependsOn=[]; try save(ledger,package:package)
            startRunner(); return ledger.jobs[index]
        }
        let job=PostStopJob(recordingId:id,kind:.enrich,now:clock()); ledger.jobs.append(job)
        try save(ledger,package:package); startRunner(); return job
    }
    public func list(id:String? = nil) throws -> PostStopJobListing {
        if let id { _=try load(resolve(id)); return listing(id:id) }
        for entry in try RecordingPackage.scanManifests(root:root) where ledgers[entry.manifest.id] == nil {
            do { let package=try resolve(entry.manifest.id),path=try ledgerURL(package); if FileManager.default.fileExists(atPath:path.path) { _=try load(package) } }
            catch { recordIssue(entry.manifest.id,error:error) }
        }
        return listing()
    }
    @discardableResult public func retry(jobId:String,allowAssetDownload:Bool = false,metadataMode:JobMetadataMode? = nil) throws -> PostStopJob {
        let (id,index)=try locate(jobId)
        guard !blockedRecordings.contains(id) else { throw jobFailure("recording-busy","Recording is being closed or moved") }
        let package=try resolve(id); var ledger=try load(package)
        guard [.failed,.cancelled].contains(ledger.jobs[index].status) else { throw jobFailure("job-not-retryable","Only failed or cancelled jobs can be retried") }
        ledger.jobs[index].status = .queued; ledger.jobs[index].error=nil; ledger.jobs[index].result=nil
        ledger.jobs[index].nextRetryAt=nil; ledger.jobs[index].updatedAt=clock()
        ledger.jobs[index].options.allowAssetDownload=allowAssetDownload
        if let metadataMode { ledger.jobs[index].options.metadataMode=metadataMode }
        try save(ledger,package:package); startRunner(); return ledger.jobs[index]
    }
    @discardableResult public func cancel(jobId:String) throws -> PostStopJob {
        let (id,index)=try locate(jobId); let package=try resolve(id); var ledger=try load(package)
        guard [.queued,.running,.failed].contains(ledger.jobs[index].status) else { throw jobFailure("job-not-cancellable","Job is already terminal") }
        terminate(&ledger.jobs[index],status:.cancelled,error:.init(code:"cancelled",message:"Cancelled by user"))
        try save(ledger,package:package)
        if activeJobId == jobId { activeTask?.cancel() }
        eventSink?(PostStopJobEvent(job:ledger.jobs[index])); startRunner(); return ledger.jobs[index]
    }
    /// Persist cancellation, prevent new work and wait for the executor AND
    /// artifact callback to stop before root moves this package to Trash.
    @discardableResult public func cancelRecording(id:String) async throws -> [PostStopJob] {
        blockedRecordings.insert(id)
        let package=try resolve(id); var ledger=try load(package)
        for index in ledger.jobs.indices where [.queued,.running,.failed].contains(ledger.jobs[index].status) {
            terminate(&ledger.jobs[index],status:.cancelled,error:.init(code:"recording-closed",message:"Cancelled before this recording is moved"))
        }
        if !ledger.jobs.isEmpty { try save(ledger,package:package) }
        if let activeJobId,ledger.jobs.contains(where:{$0.id == activeJobId}) {
            activeTask?.cancel()
            await withCheckedContinuation { continuation in completionWaiters[activeJobId,default:[]].append(continuation) }
        }
        return ledger.jobs
    }
    public func allowRecording(id:String) { blockedRecordings.remove(id) }
    public func setCaptureActive(_ active:Bool) throws {
        captureActive=active
        if active,let jobId=activeJobId {
            let (id,index)=try locate(jobId); let package=try resolve(id); var ledger=try load(package)
            if ledger.jobs[index].status == .running {
                interrupt(&ledger.jobs[index],code:"recording-priority",message:"Paused while a new recording uses the foreground resources")
                try save(ledger,package:package)
            }
            activeTask?.cancel()
        }
        if !active { startRunner() }
    }
    public func shutdown() throws {
        stopping=true; retryTimer?.cancel(); retryTimer=nil
        if let jobId=activeJobId {
            let (id,index)=try locate(jobId); let package=try resolve(id); var ledger=try load(package)
            if ledger.jobs[index].status == .running {
                interrupt(&ledger.jobs[index],code:"interrupted",message:"Engine stopped before this attempt completed")
                try save(ledger,package:package)
            }
        }
        activeTask?.cancel(); runner?.cancel()
    }
    /// Tests and explicit callers can await native work without blocking Stop.
    public func waitUntilIdle() async { await runner?.value }
    private func startRunner() {
        guard !stopping,!captureActive,runner == nil else { return }
        runner=Task(priority:.utility) { [weak self] in await self?.runQueue() }
    }
    private func runQueue() async {
        while !stopping && !captureActive {
            guard let candidate=eligible() else { break }
            do {
                let package=try resolve(candidate.recordingId); var ledger=try load(package)
                guard let index=ledger.jobs.firstIndex(where:{$0.id == candidate.id}),ledger.jobs[index].status == .queued else { continue }
                ledger.jobs[index].status = .running; ledger.jobs[index].attempts += 1; ledger.jobs[index].updatedAt=clock()
                let token=UUID().uuidString
                ledger.jobs[index].history.append(.init(number:ledger.jobs[index].attempts,token:token,startedAt:clock(),status:.running))
                try save(ledger,package:package)
                let job=ledger.jobs[index]; eventSink?(PostStopJobEvent(job:job))
                activeJobId=job.id
                let backend=executor
                let work=Task(priority:.utility) { try await backend.execute(job,package:package) }
                activeTask=work
                let outcome:Result<PostStopJobExecution,any Error>
                do {
                    let result=try await work.value
                    if job.kind != .enrich,ledgers[job.recordingId]?.jobs.first(where:{$0.id == job.id})?.status == .running { try await artifactDidWrite?(job.recordingId) }
                    outcome = .success(result)
                } catch { outcome = .failure(error) }
                try complete(job:job,token:token,outcome:outcome,package:package)
                finishActive()
            } catch { finishActive(); recordIssue(candidate.recordingId,error:error); break }
        }
        runner=nil; scheduleRetryTimer()
    }
    private func finishActive() {
        let id=activeJobId; activeTask=nil; activeJobId=nil
        if let id { for waiter in completionWaiters.removeValue(forKey:id) ?? [] { waiter.resume() } }
    }
    private func complete(job:PostStopJob,token:String,outcome:Result<PostStopJobExecution,any Error>,package:RecordingPackage) throws {
        var ledger=try load(package)
        guard let index=ledger.jobs.firstIndex(where:{$0.id == job.id}),ledger.jobs[index].status == .running,
              ledger.jobs[index].history.last?.token == token else { return }
        switch outcome {
        case .success(let output):
            let state:PostStopJobStatus=output.notApplicable ? .cancelled : .done
            terminate(&ledger.jobs[index],status:state,error:output.notApplicable ? .init(code:"not-shared",message:"No published share needed enrichment") : nil)
            ledger.jobs[index].result=output.result
        case .failure(let failure):
            let error=describe(failure)
            terminate(&ledger.jobs[index],status:.failed,error:error)
            if job.kind == .enrich,retryable(error.code),job.attempts<(error.code == "share-processing" ? 30 : 5) { ledger.jobs[index].nextRetryAt=clock().addingTimeInterval(min(300,15*pow(2,Double(job.attempts-1)))) }
            if job.kind == .verify,error.code == "finalization-pending",job.attempts<20 { ledger.jobs[index].nextRetryAt=clock().addingTimeInterval(15) }
        }
        try save(ledger,package:package); eventSink?(PostStopJobEvent(job:ledger.jobs[index]))
    }
    private func eligible() -> PostStopJob? {
        let now=clock()
        for verificationPass in [false,true] {
        for ledger in ledgers.values.sorted(by:{$0.recordingId<$1.recordingId}) {
            for job in ledger.jobs {
                guard (job.kind == .verify) == verificationPass else { continue }
                guard !blockedRecordings.contains(job.recordingId) else { continue }
                if job.status == .failed,canRetry(job),let due=job.nextRetryAt,due<=now {
                    var changed=ledger; let index=changed.jobs.firstIndex(where:{$0.id == job.id})!
                    changed.jobs[index].status = .queued; changed.jobs[index].nextRetryAt=nil
                    do { try save(changed,package:resolve(job.recordingId)) } catch { recordIssue(job.recordingId,error:error); return nil }
                    return changed.jobs[index]
                }
                guard job.status == .queued,job.dependsOn.allSatisfy({dep in ledger.jobs.first(where:{$0.id == dep})?.status == .done}) else { continue }
                return job
            }
        }
        }
        return nil
    }
    private func scheduleRetryTimer() {
        retryTimer?.cancel(); retryTimer=nil
        guard !stopping,ledgers.values.flatMap(\.jobs).contains(where:{$0.nextRetryAt != nil}) else { return }
        retryTimer=Task(priority:.utility) { [weak self] in
            do { try await Task.sleep(for:.seconds(15)) } catch { return }
            await self?.wakeRetries()
        }
    }
    private func wakeRetries() { retryTimer=nil; startRunner() }
    private func terminate(_ job:inout PostStopJob,status:PostStopJobStatus,error:PostStopJobError?) {
        job.status=status; job.updatedAt=clock(); job.error=error; job.nextRetryAt=nil
        if !job.history.isEmpty,job.history[job.history.count-1].status == .running {
            let i=job.history.count-1; job.history[i].status=status
            job.history[i].finishedAt=max(clock(),job.history[i].startedAt); job.history[i].error=error
        }
    }
    private func interrupt(_ job:inout PostStopJob,code:String,message:String) {
        terminate(&job,status:.failed,error:.init(code:code,message:message)); job.status = .queued; job.result=nil
    }
    private func listing(id:String? = nil) -> PostStopJobListing {
        .init(jobs:ledgers.values.filter{id == nil || $0.recordingId == id}.flatMap(\.jobs),errors:issues.values.filter{id == nil || $0.recordingId == id}.sorted{$0.recordingId<$1.recordingId})
    }
    private func locate(_ jobId:String) throws -> (String,Int) {
        _=try list()
        for (id,ledger) in ledgers { if let index=ledger.jobs.firstIndex(where:{$0.id == jobId}) { return (id,index) } }
        throw jobFailure("not-found","Job identifier was not found")
    }
    private func resolve(_ id:String) throws -> RecordingPackage {
        guard RecordingId.isValid(id),let package=RecordingPackage.resolve(root:root,id:id) else { throw jobFailure("not-found","Recording was not found") }
        let canonicalRoot=root.resolvingSymlinksInPath().path,folder=package.folderURL.resolvingSymlinksInPath().path
        guard folder.hasPrefix(canonicalRoot+"/") else { throw jobFailure("unsafe-job-package","Recording package escapes its storage root") }
        return package
    }
    private func ledgerURL(_ package:RecordingPackage) throws -> URL { try PostproductionPaths.managedFile("jobs.json",in:package.folderURL) }
    private func load(_ package:RecordingPackage) throws -> PostStopJobLedger {
        if let current=ledgers[package.id] { return current }
        let path=try ledgerURL(package)
        if !FileManager.default.fileExists(atPath:path.path) { return PostStopJobLedger(recordingId:package.id) }
        let ledger=try read(package); ledgers[ledger.recordingId]=ledger; return ledger
    }
    private func read(_ package:RecordingPackage) throws -> PostStopJobLedger {
        let handle=try FileHandle(forReadingFrom:ledgerURL(package)); defer { try? handle.close() }
        let data=try handle.read(upToCount:4_194_305) ?? Data()
        guard data.count<=4_194_304 else { throw jobFailure("invalid-jobs","Job ledger exceeds its size limit") }
        let decoder=JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let ledger=try decoder.decode(PostStopJobLedger.self,from:data)
        let manifest=try package.readManifest(); try ledger.validate(expectedId:manifest.id); return ledger
    }
    private func save(_ value:PostStopJobLedger,package:RecordingPackage) throws {
        var ledger=value; guard ledger.revision<Int.max else { throw jobFailure("invalid-jobs","Job revision overflow") }; ledger.revision += 1
        try ledger.validate(expectedId:try package.readManifest().id)
        let encoder=JSONEncoder(); encoder.dateEncodingStrategy = .iso8601; encoder.outputFormatting = [.sortedKeys,.withoutEscapingSlashes]
        let bytes=try encoder.encode(ledger)
        guard bytes.count<=4_194_304 else { throw jobFailure("job-ledger-full","Job history exceeds its bounded ledger size") }
        try AtomicFileWriter.write(bytes,to:ledgerURL(package)); ledgers[ledger.recordingId]=ledger; issues.removeValue(forKey:ledger.recordingId)
    }
    private func recordIssue(_ id:String,error:any Error) { let detail=describe(error); issues[id] = .init(recordingId:id,code:detail.code,message:detail.message) }
    private func retryable(_ code:String?) -> Bool { ["shell-required","engine-unreachable","connection-closed","timeout","share-network-failed","share-processing","socket-error"].contains(code ?? "") }
    private func canRetry(_ job:PostStopJob) -> Bool {
        if job.kind == .verify { return job.error?.code == "finalization-pending" && job.attempts<20 }
        return job.kind == .enrich && retryable(job.error?.code) && job.attempts<10_000
    }
    private func describe(_ error:any Error) -> PostStopJobError {
        let failure=error as? ControlFailure,code=failure?.payload.code ?? (error is CancellationError ? "cancelled" : "job-failed")
        let action:String?
        switch code {
        case "speech-assets-required": action="download-speech-model"
        case "metadata-model-required": action="enable-apple-intelligence-or-request-extractive"
        case "shell-required": action="open-rushes"
        case "permission-denied": action="grant-permission"
        case "verification-failed": action="review-verification-report"
        case "finalization-pending": action="wait-or-relaunch-rushes"
        default: action=nil
        }
        return .init(code:code,message:String(DiagnosticRedactor.redact(failure?.payload.message ?? String(describing:error)).prefix(2048)),requiresAction:action,artifact:code == "verification-failed" ? "verification.json" : nil)
    }
}
