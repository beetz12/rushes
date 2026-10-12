@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import RushCore

@Suite("PCM edited audio",.serialized)
struct PCMEditingAudioTests {
    private func source(to path:URL,onsetFrame:Int = 19_200) throws -> Int64 {
        let format=try PCMEditingAudioRenderer.format()
        var settings=format.settings; settings[AVLinearPCMIsNonInterleaved]=false
        let file=try AVAudioFile(forWriting:path,settings:settings,commonFormat:.pcmFormatFloat32,interleaved:false)
        let buffer=try #require(AVAudioPCMBuffer(pcmFormat:format,frameCapacity:4096)),channels=try #require(buffer.floatChannelData)
        for frame in stride(from:0,to:96_000,by:4096) {
            let count=min(4096,96_000-frame); buffer.frameLength=AVAudioFrameCount(count)
            for index in 0..<count {
                let value:Float=frame+index<onsetFrame ? 0 : 0.3*sin(2*Float.pi*440*Float(frame+index)/48_000)
                channels[0][index]=value; channels[1][index]=value
            }
            try file.write(from:buffer)
        }
        return file.length
    }
    private func frequency(_ path:URL,startFrame:Int64,frames:AVAudioFrameCount) throws -> Double {
        let file=try AVAudioFile(forReading:path),buffer=try #require(AVAudioPCMBuffer(pcmFormat:file.processingFormat,frameCapacity:frames))
        file.framePosition=startFrame; try file.read(into:buffer,frameCount:frames)
        let values=try #require(buffer.floatChannelData)[0]
        var crossings=0
        for index in 1..<Int(buffer.frameLength) where values[index-1]<0 && values[index]>=0 { crossings += 1 }
        return Double(crossings)/Double(buffer.frameLength)*48_000
    }
    private func constant(to path:URL,value:Float,frames:AVAudioFrameCount) throws {
        let format=try PCMEditingAudioRenderer.format()
        var settings=format.settings; settings[AVLinearPCMIsNonInterleaved]=false
        let file=try AVAudioFile(forWriting:path,settings:settings,commonFormat:.pcmFormatFloat32,interleaved:false)
        let buffer=try #require(AVAudioPCMBuffer(pcmFormat:format,frameCapacity:4096)),channels=try #require(buffer.floatChannelData)
        var written:AVAudioFrameCount=0
        while written<frames {
            let count=min(4096,frames-written); buffer.frameLength=count
            for channel in 0..<2 { channels[channel].update(repeating:value,count:Int(count)) }
            try file.write(from:buffer); written += count
        }
    }
    private func samples(_ path:URL,at frame:Int64,count:AVAudioFrameCount) throws -> [[Float]] {
        let file=try AVAudioFile(forReading:path),buffer=try #require(AVAudioPCMBuffer(pcmFormat:file.processingFormat,frameCapacity:count))
        file.framePosition=frame; try file.read(into:buffer,frameCount:count)
        #expect(buffer.frameLength == count)
        let channels=try #require(buffer.floatChannelData)
        return (0..<2).map { Array(UnsafeBufferPointer(start:channels[$0],count:Int(buffer.frameLength))) }
    }
    @Test func speedPreservesPitchAndLatencyUsesTheSourceTimeline() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("rushes-pcm-test-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false); defer { try? FileManager.default.removeItem(at:root) }
        let original=root.appendingPathComponent("original.caf"),frames=try source(to:original)
        let target=root.appendingPathComponent("edited.caf")
        let renderer=PCMEditingAudioRenderer(inputs:[.init(url:original,frameCount:frames,offsetMs:-120,gain:1)],clips:[EditClip(sourceStartMs:0,sourceEndMs:1000,speed:2)])
        #expect(try await renderer.render(to:target) == 24_000)
        #expect(try AVAudioFile(forReading:target).length == 24_000)
        #expect(try await SyntheticExportFixture.audioWindowRMS(target,start:0.08,end:0.12)<0.005)
        #expect(try await SyntheticExportFixture.audioWindowRMS(target,start:0.16,end:0.22)>0.10)
        #expect(abs(try frequency(target,startFrame:12_000,frames:9600)-440)<15)
    }
    @Test func maximumSpeedAndReorderedClipsKeepExactOutputFrames() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("rushes-pcm-test-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false); defer { try? FileManager.default.removeItem(at:root) }
        let original=root.appendingPathComponent("original.caf"),frames=try source(to:original,onsetFrame:0),target=root.appendingPathComponent("edited.caf")
        let renderer=PCMEditingAudioRenderer(inputs:[.init(url:original,frameCount:frames,offsetMs:0,gain:0.5)],clips:[EditClip(sourceStartMs:1000,sourceEndMs:2000,speed:8),EditClip(sourceStartMs:0,sourceEndMs:1000)])
        #expect(try await renderer.render(to:target) == 54_000)
        #expect(try await SyntheticExportFixture.audioWindowRMS(target,start:0.02,end:0.10)>0.03)
        #expect(abs(try frequency(target,startFrame:1000,frames:4000)-440)<25)
    }
    @Test func offsetsGainsAndMissingIntervalsMixAtExactPCMFrames() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("rushes-pcm-test-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false); defer { try? FileManager.default.removeItem(at:root) }
        let early=root.appendingPathComponent("early.caf"),late=root.appendingPathComponent("late.caf"),target=root.appendingPathComponent("edited.caf")
        try constant(to:early,value:0.4,frames:24_000)
        try constant(to:late,value:0.2,frames:24_000)
        let renderer=PCMEditingAudioRenderer(inputs:[
            .init(url:early,frameCount:24_000,offsetMs:-100,gain:0.5),
            .init(url:late,frameCount:24_000,offsetMs:200,gain:1.5),
            .init(url:early,frameCount:24_000,offsetMs:0,gain:0)
        ],clips:[EditClip(sourceStartMs:0,sourceEndMs:1000)])
        #expect(try await renderer.render(to:target) == 48_000)
        // Early source ends at 400ms; late source begins at 200ms and ends
        // at 700ms. Both channels must contain the gain sum in the overlap.
        for (frame,value) in [(0,Float(0.2)),(9600,0.5),(19_200,0.3),(33_600,0)] {
            let channels=try samples(target,at:Int64(frame),count:32)
            #expect(channels.allSatisfy { $0.allSatisfy { abs($0-value)<0.00001 } })
        }
        let muted=root.appendingPathComponent("muted.caf")
        #expect(try await PCMEditingAudioRenderer(inputs:[.init(url:early,frameCount:24_000,offsetMs:0,gain:0)],clips:[EditClip(sourceStartMs:0,sourceEndMs:1000)]).render(to:muted) == 48_000)
        #expect(try await SyntheticExportFixture.audioRMS(muted) == 0)
    }
    @Test func fractionalClipBoundariesRoundTheWholeTimelineOnce() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("rushes-pcm-test-\(UUID().uuidString)",isDirectory:true)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:false); defer { try? FileManager.default.removeItem(at:root) }
        let target=root.appendingPathComponent("edited.caf")
        let clips=(0..<7).map { _ in EditClip(sourceStartMs:100,sourceEndMs:110.01,speed:3) }
        let frames=Int64((clips.reduce(0) { $0+$1.durationMs }*48).rounded())
        #expect(frames == 1121)
        #expect(try await PCMEditingAudioRenderer(inputs:[],clips:clips).render(to:target) == frames)
        #expect(try AVAudioFile(forReading:target).length == frames)
    }
}
