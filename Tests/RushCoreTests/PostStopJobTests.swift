import Foundation
import Testing
@testable import RushCore

private actor JobFixtureExecutor:PostStopJobExecuting {
    var calls:[PostStopJobKind]=[]
    var downloads:[Bool]=[]
    var failures:Int
    var held:Bool
    var continuation:CheckedContinuation<Void,Never>?
    var started=false
    var concurrent=0
    var maximum=0
    let realVerification:Bool
    init(failSpeech:Int = 0,holdSpeech:Bool = false,realVerification:Bool = false) { failures=failSpeech; held=holdSpeech; self.realVerification=realVerification }
    func release() { held=false; continuation?.resume(); continuation=nil }
    func execute(_ job:PostStopJob,package:RecordingPackage) async throws -> PostStopJobExecution {
        calls.append(job.kind); concurrent += 1; maximum=max(maximum,concurrent)
        defer { concurrent -= 1 }
        switch job.kind {
        case .verify:
            if realVerification { return try await NativePostStopJobExecutor().execute(job,package:package) }
            // Other lifecycle tests use a fake backend; the real native decode
            // and failure-stamp behavior have their own test below.
            return .init(result:.object(["backend":.string("synthetic lifecycle fixture")]))
        case .transcribe:
            downloads.append(job.options.allowAssetDownload); started=true
            if failures>0 { failures -= 1; throw ControlFailure(code:"speech-assets-required",message:"Explicit download required") }
            if held { await withCheckedContinuation { continuation=$0 } }
            // Deliberately completes even after cancellation, proving Trash waits
            // for the executor's last write instead of relying on a cancel flag.
            let doc=try TranscriptDocument(locale:"en-US",inputFile:"mic.mov",durationMs:2000,words:[.init(id:"w1",text:"Synthetic",startMs:100,endMs:300)],engine:"synthetic test backend")
            try TranscriptFiles.write(doc,to:package.folderURL)
            return .init(result:.object(["artifact":.string("transcript.json"),"words":.int(1)]))
        case .metadata:
            let doc=try TranscriptFiles.read(from:package.folderURL),metadata=try MetadataService.extractive(transcript:doc)
            try MetadataService.write(metadata,to:package.folderURL)
            return .init(result:.object(["artifact":.string("metadata.json"),"engine":.string(metadata.engine)]))
        case .enrich: return .init(result:.object(["updated":.bool(true),"url":.string("https://example.invalid/s/synthetic")]))
        }
    }
}
private actor EnrichmentResponder:ControlHandling {
    var requests:[ControlRequest]=[]
    var fail=true
    func succeed() { fail=false }
    func handle(_ request:ControlRequest,context:ControlCommandContext) async {
        requests.append(request)
        if fail { context.reply(.failure(id:request.id,code:"share-provider-unconfigured",message:"Configure the fixture provider")) }
        else { context.reply(.success(id:request.id,result:.object(["updated":.bool(true),"url":.string("https://example.invalid/s/verified")])) ) }
    }
}
private actor JobTestGate {
    var started=false
    var continuation:CheckedContinuation<Void,Never>?
    func hold() async { started=true; await withCheckedContinuation { continuation=$0 } }
    func release() { continuation?.resume(); continuation=nil }
}

private actor JobEditState {
    var edit=EditDocument(durationMs:2000)
    func read() -> EditDocument { edit }
    func change() { edit.meta.summary="New user summary"; edit.revision += 1 }
}

@Suite("Durable post-Stop jobs",.serialized)
struct PostStopJobTests {
    private func wait(_ condition:@escaping @Sendable() async->Bool) async throws {
        for _ in 0..<200 { if await condition() { return }; try await Task.sleep(for:.milliseconds(5)) }
        throw ControlFailure(code:"test-timeout",message:"Fixture did not reach its observable checkpoint")
    }
    @Test func serialWorkflowPersistsAttemptsAndDoesNotMutateMasters() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let hashes=try fixture.hashes(),backend=JobFixtureExecutor(),service=PostStopJobService(root:fixture.root,executor:backend)
        _=try await service.enqueueAfterStop(id:fixture.package.id)
        await service.waitUntilIdle()
        let listing=try await service.list(id:fixture.package.id)
        #expect(listing.jobs.map(\.status) == [.done,.done,.done,.done])
        #expect(listing.jobs.map(\.attempts) == [1,1,1,1])
        #expect(await backend.calls == [.transcribe,.metadata,.enrich,.verify])
        #expect(await backend.maximum == 1)
        #expect(await backend.downloads == [false])
        let restarted=PostStopJobService(root:fixture.root,executor:backend)
        let restored=try await restarted.resume(); await restarted.waitUntilIdle()
        #expect(restored.jobs.count == 4 && restored.jobs.allSatisfy{$0.status == .done})
        #expect(await backend.calls.count == 4)
        #expect(try fixture.hashes() == hashes)
    }
    @Test func missingAssetsRemainFailedAndOnlyExplicitRetryPermitsDownload() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let backend=JobFixtureExecutor(failSpeech:1),service=PostStopJobService(root:fixture.root,executor:backend)
        let queued=try await service.enqueueAfterStop(id:fixture.package.id)
        await service.waitUntilIdle()
        let failed=try await service.list().jobs
        #expect(failed[0].status == .failed && failed[0].error?.requiresAction == "download-speech-model")
        #expect(failed[1].status == .queued && failed[1].attempts == 0)
        #expect(!FileManager.default.fileExists(atPath:fixture.package.transcriptURL.path))
        _=try await service.retry(jobId:queued[0].id,allowAssetDownload:true)
        await service.waitUntilIdle()
        let done=try await service.list().jobs
        #expect(done.allSatisfy{$0.status == .done})
        #expect(done[0].attempts == 2 && done[0].history.first?.error?.code == "speech-assets-required")
        #expect(await backend.downloads == [false,true])
    }
    @Test func interruptedRunResumesAndCancelledWorkStaysCancelled() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let backend=JobFixtureExecutor(holdSpeech:true),first=PostStopJobService(root:fixture.root,executor:backend)
        let jobs=try await first.enqueueAfterStop(id:fixture.package.id)
        try await wait { await backend.started }
        try await first.shutdown()
        await backend.release(); await first.waitUntilIdle()
        let next=PostStopJobService(root:fixture.root,executor:backend)
        _=try await next.resume(); await next.waitUntilIdle()
        let completed=try await next.list().jobs
        #expect(completed[0].status == .done && completed[0].attempts == 2)
        #expect(completed[0].history.first?.error?.code == "interrupted")
        _=try await next.queueEnrichment(id:fixture.package.id)
        await next.waitUntilIdle()
        let paused=PostStopJobService(root:fixture.root,executor:backend)
        try await paused.setCaptureActive(true)
        let extra=try await paused.queueEnrichment(id:fixture.package.id)
        _=try await paused.cancel(jobId:extra.id)
        try await paused.shutdown()
        let again=PostStopJobService(root:fixture.root,executor:backend)
        _=try await again.resume(); await again.waitUntilIdle()
        #expect(try await again.list().jobs.first(where:{$0.id == extra.id})?.status == .cancelled)
        #expect(try await again.list().jobs.first(where:{$0.id == extra.id})?.attempts == 0)
        #expect(jobs.count == 4)
    }
    @Test func realPrivateBridgeFailurePersistsAndRetryChecksActualResponse() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let directory=URL(fileURLWithPath:"/tmp/job-bridge-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:false)
        defer { try? FileManager.default.removeItem(at:directory) }
        let handler=EnrichmentResponder(),socket=directory.appendingPathComponent("shell.sock"),server=ControlServer(socketPath:socket,handler:handler)
        try server.start(); defer { server.stop() }
        let bridge=ShellServiceBridge(socketPath:socket)
        let executor=NativePostStopJobExecutor(enrich:{ id in try await bridge.forward(ControlRequest(id:UUID().uuidString,cmd:"share.enrich",args:.object(["id":.string(id)])),timeout:2) })
        let service=PostStopJobService(root:fixture.root,executor:executor)
        let job=try await service.queueEnrichment(id:fixture.package.id); await service.waitUntilIdle()
        #expect(try await service.list().jobs[0].status == .failed)
        #expect(try await service.list().jobs[0].error?.code == "share-provider-unconfigured")
        await handler.succeed(); _=try await service.retry(jobId:job.id); await service.waitUntilIdle()
        let outcome=try await service.list().jobs[0]
        #expect(outcome.status == .done && outcome.attempts == 2 && outcome.result?["updated"]?.bool == true)
        #expect(await handler.requests.count == 2)
        #expect(await handler.requests.allSatisfy{$0.cmd == "share.enrich" && $0.param("id")?.string == fixture.package.id})
    }
    @Test func processingIsRetryableAndUnknownFalseResultNeverSucceeds() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let processing=NativePostStopJobExecutor(enrich:{_ in .success(id:"request",result:.object(["updated":.bool(false),"reason":.string("processing")]))})
        let service=PostStopJobService(root:fixture.root,executor:processing)
        _=try await service.queueEnrichment(id:fixture.package.id); await service.waitUntilIdle()
        let failed=try await service.list().jobs[0]
        #expect(failed.status == .failed && failed.error?.code == "share-processing" && failed.nextRetryAt != nil)
        try await service.shutdown()
        let invalid=NativePostStopJobExecutor(enrich:{_ in .success(id:"request",result:.object(["updated":.bool(false)]))})
        await #expect(throws:ControlFailure.self) { try await invalid.execute(PostStopJob(recordingId:fixture.package.id,kind:.enrich),package:fixture.package) }
        let unshared=NativePostStopJobExecutor(enrich:{_ in .success(id:"request",result:.object(["updated":.bool(false),"reason":.string("no-state")]))})
        #expect(try await unshared.execute(PostStopJob(recordingId:fixture.package.id,kind:.enrich),package:fixture.package).notApplicable)
    }
    @Test func trashWaitsForAllWritesAndQuarantinesNewScheduling() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let backend=JobFixtureExecutor(holdSpeech:true),service=PostStopJobService(root:fixture.root,executor:backend)
        _=try await service.enqueueAfterStop(id:fixture.package.id)
        try await wait { await backend.started }
        let cancellation=Task { try await service.cancelRecording(id:fixture.package.id) }
        try await Task.sleep(for:.milliseconds(20))
        await #expect(throws:ControlFailure.self) { try await service.queueEnrichment(id:fixture.package.id) }
        await backend.release()
        let cancelled=try await cancellation.value
        #expect(cancelled.allSatisfy{$0.status == .cancelled})
        let moved=fixture.root.appendingPathComponent("moved",isDirectory:true)
        try FileManager.default.moveItem(at:fixture.package.folderURL,to:moved)
        await service.waitUntilIdle()
        #expect(!FileManager.default.fileExists(atPath:fixture.package.folderURL.path))
        #expect(FileManager.default.fileExists(atPath:moved.appendingPathComponent("transcript.json").path))
        let decoder=JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let saved=try decoder.decode(PostStopJobLedger.self,from:Data(contentsOf:moved.appendingPathComponent("jobs.json")))
        #expect(saved.jobs.allSatisfy{$0.status == .cancelled})
    }
    @Test func newerHumanMetadataAndDraftSuppressGenerationWrites() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let doc=try TranscriptDocument(locale:"en-US",inputFile:"mic.mov",durationMs:2000,words:[.init(id:"w",text:"Source",startMs:100,endMs:500)],engine:"synthetic")
        try TranscriptFiles.write(doc,to:fixture.package.folderURL)
        let gate=JobTestGate()
        let executor=NativePostStopJobExecutor(generate:{_,_ in await gate.hold(); return .init(title:"Generated fixture",summary:"Generated",chapters:[],engine:"Apple FoundationModels (fixture)")})
        let work=Task { try await executor.execute(PostStopJob(recordingId:fixture.package.id,kind:.metadata),package:fixture.package) }
        try await wait { await gate.started }
        let human=RecordingMetadata(title:"Human title",summary:"Human summary",chapters:[],engine:"user")
        try MetadataService.write(human,to:fixture.package.folderURL)
        await gate.release()
        await #expect(throws:ControlFailure.self) { try await work.value }
        #expect(try MetadataService.read(from:fixture.package.folderURL) == human)
        let preserved=try await executor.execute(PostStopJob(recordingId:fixture.package.id,kind:.metadata),package:fixture.package)
        #expect(preserved.result["preservedUserMetadata"]?.bool == true)
    }
    @Test func corruptAndEscapingLedgersAreVisibleAndNotReplaced() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let bad=Data("{truncated".utf8),path=fixture.package.jobsURL
        try AtomicFileWriter.write(bad,to:path)
        let service=PostStopJobService(root:fixture.root,executor:JobFixtureExecutor())
        let restored=try await service.resume()
        #expect(restored.errors.count == 1 && restored.jobs.isEmpty)
        await #expect(throws:(any Error).self) { try await service.enqueueAfterStop(id:fixture.package.id) }
        #expect(try Data(contentsOf:path) == bad)
        try FileManager.default.removeItem(at:path)
        let outside=fixture.root.appendingPathComponent("outside.json")
        try AtomicFileWriter.write(bad,to:outside)
        try FileManager.default.createSymbolicLink(at:path,withDestinationURL:outside)
        await #expect(throws:ControlFailure.self) { try await service.enqueueAfterStop(id:fixture.package.id) }
        #expect(try Data(contentsOf:outside) == bad)
    }
    @Test func liveUnsavedMetadataChangeIsNotOverwritten() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let doc=try TranscriptDocument(locale:"en-US",inputFile:"mic.mov",durationMs:2000,words:[.init(id:"w",text:"Source",startMs:100,endMs:500)],engine:"synthetic")
        try TranscriptFiles.write(doc,to:fixture.package.folderURL)
        let gate=JobTestGate(),edits=JobEditState()
        let executor=NativePostStopJobExecutor(generate:{_,_ in await gate.hold(); return .init(title:"Generated",summary:"Generated",chapters:[],engine:"Apple FoundationModels (fixture)")},currentEdit:{_ in await edits.read()})
        let work=Task { try await executor.execute(PostStopJob(recordingId:fixture.package.id,kind:.metadata),package:fixture.package) }
        try await wait { await gate.started }
        await edits.change(); await gate.release()
        await #expect(throws:ControlFailure.self) { try await work.value }
        #expect(!FileManager.default.fileExists(atPath:fixture.package.folderURL.appendingPathComponent("metadata.json").path))
        #expect(await edits.read().meta.summary == "New user summary")
    }
    @Test func verificationReallyDecodesAndPersistsFailureWithoutChangingRecordingStatus() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        var manifest=try fixture.package.readManifest(); manifest.status = .recovered; manifest.verified=nil
        try fixture.package.writeManifest(manifest)
        let masters=try fixture.hashes(),executor=NativePostStopJobExecutor()
        let verification=PostStopJob(recordingId:fixture.package.id,kind:.verify)
        let completed=try await executor.execute(verification,package:fixture.package)
        #expect(completed.result["ok"]?.bool == true && completed.result["tracks"]?.int == 4)
        let path=fixture.package.folderURL.appendingPathComponent("verification.json")
        let report=try JSONDecoder().decode(PostStopVerificationReport.self,from:Data(contentsOf:path))
        #expect(report.ok && report.trackChecks.count == 4 && report.trackChecks.allSatisfy{$0.ok})
        #expect(try fixture.package.readManifest().verified?.ok == true)
        #expect(try fixture.package.readManifest().status == .recovered)
        #expect(try fixture.hashes() == masters)
        let screen=fixture.package.trackURL(for:.screen),original=try Data(contentsOf:screen)
        try AtomicFileWriter.write(Data("invalid media payload".utf8),to:screen)
        let broken=try fixture.hashes()
        let service=PostStopJobService(root:fixture.root,executor:JobFixtureExecutor(realVerification:true))
        _=try await service.enqueueAfterStop(id:fixture.package.id); await service.waitUntilIdle()
        let failed=try #require(try await service.list().jobs.first(where:{$0.kind == .verify}))
        #expect(failed.status == .failed && failed.error?.code == "verification-failed" && failed.error?.artifact == "verification.json")
        let rejected=try JSONDecoder().decode(PostStopVerificationReport.self,from:Data(contentsOf:path))
        #expect(!rejected.ok && rejected.trackChecks.contains{$0.kind == .screen && !$0.ok && !$0.issues.isEmpty})
        #expect(try fixture.package.readManifest().verified?.ok == false)
        #expect(try fixture.package.readManifest().status == .recovered)
        #expect(try fixture.hashes() == broken)
        try AtomicFileWriter.write(original,to:screen)
        _=try await service.retry(jobId:failed.id); await service.waitUntilIdle()
        #expect(try await service.list().jobs.first(where:{$0.id == failed.id})?.status == .done)
        #expect(try fixture.package.readManifest().verified?.ok == true)
        #expect(try fixture.hashes() == masters)
    }
    @Test func cancelledVerificationDoesNotFabricateAStamp() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let gate=JobTestGate(),executor=NativePostStopJobExecutor()
        let task=Task {
            await gate.hold()
            return try await executor.execute(PostStopJob(recordingId:fixture.package.id,kind:.verify),package:fixture.package)
        }
        try await wait { await gate.started }
        task.cancel(); await gate.release()
        await #expect(throws:CancellationError.self) { try await task.value }
        #expect(try fixture.package.readManifest().verified == nil)
        #expect(!FileManager.default.fileExists(atPath:fixture.package.folderURL.appendingPathComponent("verification.json").path))
    }
    @Test func cancellingActiveWorkStaysTerminalThroughCaptureAndShutdown() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let backend=JobFixtureExecutor(holdSpeech:true),service=PostStopJobService(root:fixture.root,executor:backend)
        let jobs=try await service.enqueueAfterStop(id:fixture.package.id)
        try await wait { await backend.started }
        _=try await service.cancel(jobId:jobs[0].id)
        try await service.setCaptureActive(true)
        try await service.shutdown()
        await backend.release(); await service.waitUntilIdle()
        let restored=PostStopJobService(root:fixture.root,executor:backend)
        _=try await restored.resume(); await restored.waitUntilIdle()
        let job=try #require(try await restored.list().jobs.first(where:{$0.id == jobs[0].id}))
        #expect(job.status == .cancelled && job.attempts == 1 && job.history.last?.status == .cancelled)
        #expect(await backend.downloads.count == 1)
    }

}
