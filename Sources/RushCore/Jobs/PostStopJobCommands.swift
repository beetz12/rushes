import Foundation

extension PostStopJobService {
    public func handle(_ request:ControlRequest) async throws -> JSONValue {
        switch request.cmd {
        case "jobs.list":
            if let id=request.param("id"),id.string == nil { throw jobFailure("invalid-params","id must be a recording ULID") }
            return try jobJSON(list(id:request.param("id")?.string))
        case "jobs.retry":
            guard let id=request.param("jobId")?.string ?? request.param("id")?.string else { throw jobFailure("invalid-params","jobId is required") }
            if let flag=request.param("allowAssetDownload"),flag.bool == nil { throw jobFailure("invalid-params","allowAssetDownload must be an explicit Boolean") }
            let mode:JobMetadataMode?
            if let parameter=request.param("metadataMode") {
                guard let value=parameter.string else { throw jobFailure("invalid-params","metadataMode must be apple or extractive") }
                guard let parsed=JobMetadataMode(rawValue:value) else { throw jobFailure("invalid-params","metadataMode must be apple or extractive") }; mode=parsed
            } else { mode=nil }
            return try jobJSON(retry(jobId:id,allowAssetDownload:request.param("allowAssetDownload")?.bool ?? false,metadataMode:mode))
        case "jobs.cancel":
            guard let id=request.param("jobId")?.string ?? request.param("id")?.string else { throw jobFailure("invalid-params","jobId is required") }
            return try jobJSON(cancel(jobId:id))
        default: throw jobFailure("unknown-command","Unknown job command")
        }
    }
}
public func postStopJobJSON(_ value:some Encodable) throws -> JSONValue { try jobJSON(value) }
private func jobJSON(_ value:some Encodable) throws -> JSONValue {
    let encoder=JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys,.withoutEscapingSlashes]
    return try JSONDecoder().decode(JSONValue.self,from:encoder.encode(value))
}
