import Foundation
import Testing
@testable import RushCore

@Suite("Non-destructive editing")
struct EditingTests {
    @Test func hiddenFloatingOverlayCannotHideCameraOnlyVideo() {
        var layout=EditLayout(); layout.bubble.visible=false; layout.preset = .cameraOnly
        let cameraOnly=LayoutPlanner.frames(layout:layout,canvasAspect:16/9,hasCamera:true)
        #expect(cameraOnly.screen == nil)
        #expect(cameraOnly.camera == CGRect(x:0,y:0,width:1,height:1))
        #expect(!cameraOnly.roundCamera)
        for preset in LayoutPreset.allCases {
            layout.preset=preset
            let soleCamera=LayoutPlanner.frames(layout:layout,canvasAspect:16/9,hasCamera:true,hasScreen:false)
            #expect(soleCamera.screen == nil && soleCamera.camera == CGRect(x:0,y:0,width:1,height:1))
        }
        layout.preset = .bubble
        let screenWithHiddenOverlay=LayoutPlanner.frames(layout:layout,canvasAspect:16/9,hasCamera:true)
        #expect(screenWithHiddenOverlay.screen != nil && screenWithHiddenOverlay.camera == nil)
    }
    @Test func cutsReorderSpeedAndValidation() throws {
        var edit=EditDocument(durationMs:10_000)
        try edit.removeRanges([EditCut(sourceStartMs:2000,sourceEndMs:4000,reason:"words",wordIds:["w1"])])
        #expect(edit.clips.count == 2 && edit.durationMs == 8000)
        edit.clips.reverse(); edit.clips[0].speed=2
        try edit.validate(sourceDurationMs:10_000)
        #expect(edit.durationMs == 5000)
        #expect(edit.sourceTime(at:1000)?.sourceMs == 6000)
        #expect(edit.sourceTime(at:3500)?.sourceMs == 500)
        try edit.split(clipId:edit.clips[0].id,at:8000)
        #expect(edit.clips.count == 3 && edit.durationMs == 5000)
        #expect(throws:ControlFailure.self) { try edit.removeRanges([EditCut(sourceStartMs:0,sourceEndMs:10_000,reason:"bad")]) }
        edit.clips[0].speed = .nan
        #expect(throws:ControlFailure.self) { try edit.validate(sourceDurationMs:10_000) }
    }
    @Test func tolerantDraftSchemaAndLayouts() throws {
        let minimal=Data("{\"schema\":\"rushes.edit/1\",\"clips\":[{\"id\":\"c1\",\"sourceStartMs\":0,\"sourceEndMs\":1000,\"speed\":1}],\"captions\":{\"burnIn\":true,\"style\":\"default\"},\"layout\":{\"preset\":\"bubble\",\"bubble\":{\"visible\":false}}}".utf8)
        let edit=try JSONDecoder().decode(EditDocument.self,from:minimal)
        #expect(edit.captions.fontSize == 36 && !edit.layout.bubble.visible)
        try edit.validate(sourceDurationMs:1000)
        for preset in LayoutPreset.allCases {
            var layout=EditLayout(); layout.preset=preset
            let frames=LayoutPlanner.frames(layout:layout,canvasAspect:16/9,hasCamera:true)
            let bounds=CGRect(x:0,y:0,width:1,height:1)
            if let screen=frames.screen { #expect(bounds.contains(screen)) }
            if let camera=frames.camera { #expect(bounds.contains(camera)) }
            let fallback=LayoutPlanner.frames(layout:layout,canvasAspect:16/9,hasCamera:false)
            #expect(fallback.screen == bounds && fallback.camera == nil)
        }
    }
    @Test func atomicDraftBackupUndoRedoSaveDiscard() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service=PostproductionService(root:fixture.root)
        let initial=try await service.getEdit(id:fixture.package.id)
        var first=initial; first.meta.title="First draft"
        _=try await service.setEdit(id:fixture.package.id,edit:first)
        let fresh=PostproductionService(root:fixture.root)
        #expect(try await fresh.getEdit(id:fixture.package.id).meta.title == "First draft")
        var second=first; second.meta.title="Second draft"
        _=try await service.setEdit(id:fixture.package.id,edit:second)
        let backup=try JSONDecoder().decode(EditDocument.self,from:Data(contentsOf:fixture.package.folderURL.appendingPathComponent("edit.draft.json.bak")))
        #expect(backup.meta.title == "First draft")
        #expect(try await service.undo(id:fixture.package.id).meta.title == "First draft")
        #expect(try await service.redo(id:fixture.package.id).meta.title == "Second draft")
        _=try await service.save(id:fixture.package.id)
        #expect(!FileManager.default.fileExists(atPath:fixture.package.folderURL.appendingPathComponent("edit.draft.json").path))
        var third=second; third.meta.title="Discard me"
        _=try await service.setEdit(id:fixture.package.id,edit:third)
        #expect(try await service.discard(id:fixture.package.id).meta.title == "Second draft")
        try AtomicFileWriter.write(Data("{truncated".utf8),to:fixture.package.folderURL.appendingPathComponent("edit.draft.json"))
        let broken=PostproductionService(root:fixture.root)
        await #expect(throws:(any Error).self) { try await broken.getEdit(id:fixture.package.id) }
    }
    @Test func automaticZoomKeepsManualCuesAndSafeSpring() throws {
        let clip=EditClip(id:"c1",sourceStartMs:0,sourceEndMs:15_000)
        let manual=ZoomCue(clipId:"c1",sourceStartMs:4000,sourceEndMs:6500,scale:1.4,focus:[0.5,0.5],origin:"manual")
        let samples=[PointerSample(t:3900,k:"move",x:0.2,y:0.3),PointerSample(t:4000,k:"down"),PointerSample(t:10_000,k:"move",x:0.8,y:0.7),PointerSample(t:10_100,k:"down"),PointerSample(t:14_800,k:"down")]
        let cues=AutoZoomPlanner.plan(clips:[clip],input:samples,existing:[manual])
        #expect(cues.contains(manual) && cues.count == 2)
        #expect(cues.allSatisfy { $0.sourceStartMs >= 2500 && $0.sourceEndMs <= 14_000 })
        var timeline=ViewportTimeline()
        for _ in 0..<240 { _=timeline.tick(clip:clip,sourceMs:10_500,cues:cues,pointer:[0.98,0.98],dt:1/60) }
        #expect(timeline.state.scale>1.2 && timeline.state.x <= 1-0.5/timeline.state.scale+0.001)
        let held=timeline.state.x
        for _ in 0..<240 { _=timeline.tick(clip:clip,sourceMs:10_600,cues:cues,pointer:[0.90,0.90],dt:1/60) }
        #expect(abs(timeline.state.x-held)<0.002)
        for _ in 0..<240 { _=timeline.tick(clip:clip,sourceMs:14_500,cues:cues,pointer:nil,dt:1/60) }
        #expect(abs(timeline.state.scale-1)<0.001)
    }
    @Test func commandFacadeFullAndSimpleDrafts() async throws {
        let fixture=try await SyntheticExportFixture(); defer { fixture.cleanup() }
        let service=PostproductionService(root:fixture.root)
        let result=try await service.handle(ControlRequest(id:"1",cmd:"edit.set",args:.object(["id":.string(fixture.package.id),"startMs":.int(200),"endMs":.int(1200),"layout":.string("side-by-side"),"title":.string("UI draft")])))
        #expect(result["meta"]?["title"]?.string == "UI draft")
        #expect(result["clips"]?.array?.first?["sourceStartMs"]?.int == 200)
        let full=try await service.handle(ControlRequest(id:"2",cmd:"edit.set",args:.object(["id":.string(fixture.package.id),"edit":result])))
        #expect(full["layout"]?["preset"]?.string == "side-by-side")
        let frames=try await service.handle(ControlRequest(id:"frames",cmd:"layout.frames",args:.object(["id":.string(fixture.package.id),"canvasAspect":.double(16/9),"layout":.object(["preset":.string("side-by-side")])])))
        #expect(frames["screen"]?["width"]?.double == 0.64)
        #expect(frames["camera"]?["x"]?.double == 0.68)
        await #expect(throws:ControlFailure.self) { try await service.handle(ControlRequest(id:"3",cmd:"edit.set",args:.object(["id":.string(fixture.package.id),"layout":.string("unknown")]))) }
    }
}
