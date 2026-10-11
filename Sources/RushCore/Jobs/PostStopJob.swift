import Foundation

public enum PostStopJobKind:String,Codable,Sendable { case transcribe,metadata,enrich,verify }
public enum PostStopJobStatus:String,Codable,Sendable { case queued,running,done,failed,cancelled }
public enum JobMetadataMode:String,Codable,Sendable { case apple,extractive }
public struct PostStopJobOptions:Codable,Equatable,Sendable {
    public var locale:String
    public var allowAssetDownload:Bool
    public var metadataMode:JobMetadataMode
    public init(locale:String = Locale.current.identifier,allowAssetDownload:Bool = false,metadataMode:JobMetadataMode = .apple) {
        self.locale=locale; self.allowAssetDownload=allowAssetDownload; self.metadataMode=metadataMode
    }
}
public struct PostStopJobError:Codable,Equatable,Sendable {
    public var code:String
    public var message:String
    public var requiresAction:String?
    public var artifact:String?
    public init(code:String,message:String,requiresAction:String? = nil,artifact:String? = nil) { self.code=code; self.message=message; self.requiresAction=requiresAction; self.artifact=artifact }
}
public struct PostStopJobAttempt:Codable,Equatable,Sendable {
    public var number:Int
    public var token:String
    public var startedAt:Date
    public var finishedAt:Date?
    public var status:PostStopJobStatus
    public var error:PostStopJobError?
}
public struct PostStopJob:Codable,Equatable,Sendable {
    public var id:String
    public var recordingId:String
    public var kind:PostStopJobKind
    public var status:PostStopJobStatus
    public var dependsOn:[String]
    public var options:PostStopJobOptions
    public var attempts:Int
    public var history:[PostStopJobAttempt]
    public var createdAt:Date
    public var updatedAt:Date
    public var nextRetryAt:Date?
    public var error:PostStopJobError?
    public var result:JSONValue?
    public init(recordingId:String,kind:PostStopJobKind,dependsOn:[String] = [],options:PostStopJobOptions = .init(),now:Date = Date()) {
        id=UUID().uuidString; self.recordingId=recordingId; self.kind=kind; status = .queued
        self.dependsOn=dependsOn; self.options=options; attempts=0; history=[]; createdAt=now; updatedAt=now
    }
}
public struct PostStopJobLedger:Codable,Equatable,Sendable {
    public var schema:String = "rushes.jobs/1"
    public var recordingId:String
    public var revision:Int = 0
    public var jobs:[PostStopJob]
    public init(recordingId:String,jobs:[PostStopJob] = []) { self.recordingId=recordingId; self.jobs=jobs }
    public func validate(expectedId:String) throws {
        guard schema == "rushes.jobs/1",recordingId == expectedId,RecordingId.isValid(recordingId),revision>=0,
              jobs.count<=200,Set(jobs.map(\.id)).count == jobs.count else { throw jobFailure("invalid-jobs","Invalid job ledger schema, recording identity, revision or job count") }
        let ids=Set(jobs.map(\.id))
        for job in jobs {
            guard UUID(uuidString:job.id) != nil,job.recordingId == recordingId,job.attempts>=0,job.attempts<10_000,
                  job.history.count == job.attempts,job.dependsOn.allSatisfy({ids.contains($0) && $0 != job.id}),
                  !job.options.locale.isEmpty,job.options.locale.count<=128,job.createdAt.timeIntervalSince1970.isFinite,
                  job.updatedAt.timeIntervalSince1970.isFinite,job.nextRetryAt.map({$0.timeIntervalSince1970.isFinite}) ?? true else { throw jobFailure("invalid-jobs","Invalid job identity, dependencies, attempts or options") }
            if [.running,.done,.failed].contains(job.status) && job.attempts == 0 { throw jobFailure("invalid-jobs","An executed job needs a persisted attempt") }
            if job.status == .running && (job.history.last?.status != .running || job.history.last?.finishedAt != nil) { throw jobFailure("invalid-jobs","Running job has no active attempt") }
            if [.done,.failed].contains(job.status) && (job.history.last?.status != job.status || job.history.last?.finishedAt == nil) { throw jobFailure("invalid-jobs","Terminal job has no completed matching attempt") }
            for (index,attempt) in job.history.enumerated() {
                guard attempt.number == index+1,UUID(uuidString:attempt.token) != nil,attempt.startedAt.timeIntervalSince1970.isFinite,
                      attempt.finishedAt.map({$0.timeIntervalSince1970.isFinite && $0>=attempt.startedAt}) ?? true else { throw jobFailure("invalid-jobs","Invalid job attempt history") }
            }
        }
        // A dependency cycle must not become a silent permanently queued job.
        var visiting:Set<String>=[],done:Set<String>=[]
        func walk(_ id:String) throws {
            if done.contains(id) { return }
            guard visiting.insert(id).inserted else { throw jobFailure("invalid-jobs","Job dependency cycle") }
            for dependency in jobs.first(where:{$0.id == id})?.dependsOn ?? [] { try walk(dependency) }
            visiting.remove(id); done.insert(id)
        }
        for id in ids { try walk(id) }
    }
}
public struct PostStopJobExecution:Sendable {
    public var result:JSONValue
    public var notApplicable:Bool
    public init(result:JSONValue,notApplicable:Bool = false) { self.result=result; self.notApplicable=notApplicable }
}
public protocol PostStopJobExecuting:Sendable {
    func execute(_ job:PostStopJob,package:RecordingPackage) async throws -> PostStopJobExecution
}
public struct PostStopJobEvent:Codable,Sendable {
    public var event:String = "post-stop-job"
    public var job:PostStopJob
    public init(job:PostStopJob) { self.job=job }
}
func jobFailure(_ code:String,_ message:String) -> ControlFailure { ControlFailure(code:code,message:message) }
