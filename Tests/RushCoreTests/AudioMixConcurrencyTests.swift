@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import RushCore

@Suite("Offline mixed audio concurrency",.serialized)
struct AudioMixConcurrencyTests {
    @Test func reorderedMixedExportsDecodeUnderConcurrentIndependentReaders() async throws {
        var fixtures:[SyntheticExportFixture]=[]
        defer { for fixture in fixtures { fixture.cleanup() } }
        for _ in 0..<6 { fixtures.append(try await SyntheticExportFixture()) }
        try await withThrowingTaskGroup(of:Void.self) { group in
            for fixture in fixtures {
                group.addTask {
                    let production=PostproductionService(root:fixture.root)
                    var edit=EditDocument(durationMs:2000)
                    edit.layout.preset = .screenOnly
                    edit.clips=[EditClip(id:"late",sourceStartMs:1200,sourceEndMs:1800),EditClip(id:"early",sourceStartMs:400,sourceEndMs:800,speed:2)]
                    _=try await production.setEdit(id:fixture.package.id,edit:edit)
                    let result=try await ShareAssetsService(root:fixture.root,postproduction:production).assets(id:fixture.package.id)
                    #expect(result.durationMs == 800)
                    #expect(try await SyntheticExportFixture.audioRMS(URL(fileURLWithPath:result.videoPath))>0.10)
                    #expect(abs(try await AVURLAsset(url:URL(fileURLWithPath:result.videoPath)).load(.duration).seconds-0.8)<0.035)
                    let renders=fixture.package.folderURL.appendingPathComponent("renders",isDirectory:true)
                    #expect(try FileManager.default.contentsOfDirectory(atPath:renders.path).allSatisfy { !$0.hasPrefix(".pcm-mix-") })
                }
                group.addTask {
                    // Independent full codec readers exercise the same media
                    // service pressure as background package verification.
                    for _ in 0..<4 {
                        let report=await PackageVerifier().verify(fixture.package)
                        #expect(report.ok && report.trackChecks.filter{!$0.skipped}.count == 4)
                    }
                }
                group.addTask {
                    // Separate disposable sources add simultaneous H.264/AAC
                    // writer startup/finalization pressure without mutating any
                    // master being consumed by the exports above.
                    for _ in 0..<4 {
                        let writerFixture=try await SyntheticExportFixture()
                        let report=await PackageVerifier().verify(writerFixture.package)
                        writerFixture.cleanup()
                        #expect(report.ok)
                    }
                }
            }
            try await group.waitForAll()
        }
    }
}
