import Foundation

/// The genuine full decode report, stored separately from the compact manifest
/// stamp so failed tracks remain inspectable after an engine restart.
public struct PostStopVerificationReport:Codable,Equatable,Sendable {
    public struct Track:Codable,Equatable,Sendable {
        public var kind:TrackKind
        public var file:String
        public var ok:Bool
        public var skipped:Bool
        public var issues:[String]
    }
    public var schema:String = "rushes.verification/1"
    public var packageID:String
    public var at:String
    public var ok:Bool
    public var trackChecks:[Track]
    public var issues:[String]
    public init(report:PackageVerifier.Report,now:Date = Date()) {
        packageID=report.packageID; at=ISO8601DateFormatter().string(from:now); ok=report.ok
        trackChecks=report.trackChecks.map { .init(kind:$0.kind,file:$0.file,ok:$0.ok,skipped:$0.skipped,issues:$0.issues) }
        issues=report.issues
    }
}
