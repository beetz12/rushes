@preconcurrency import AVFoundation
import Foundation

struct PCMEditingAudioInput:Sendable {
    var url:URL
    var frameCount:Int64
    var offsetMs:Double
    var gain:Double
}

/// Edit and sum decoded PCM explicitly. Compressed audio never enters an
/// AVFoundation multitrack/offline-mixer composition graph.
final class PCMEditingAudioRenderer:@unchecked Sendable {
    static let rate=48_000.0
    static let block:AVAudioFrameCount=4096
    let inputs:[PCMEditingAudioInput]
    let clips:[EditClip]
    init(inputs:[PCMEditingAudioInput],clips:[EditClip]) { self.inputs=inputs; self.clips=clips }
    func render(to target:URL) async throws -> Int64 {
        let format=try Self.format()
        var fileSettings=format.settings; fileSettings[AVLinearPCMIsNonInterleaved]=false
        let output=try AVAudioFile(forWriting:target,settings:fileSettings,commonFormat:.pcmFormatFloat32,interleaved:false)
        guard let mixed=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:Self.block) else { throw renderFailure("PCM mix buffer allocation failed") }
        var cursor:Int64=0,elapsedMs=0.0
        for clip in clips {
            try Task.checkCancellation()
            let endFrame=Int64(((elapsedMs+clip.durationMs)*Self.rate/1000).rounded())
            let length=endFrame-cursor
            var streams:[PCMClipAudioStream]=[]
            for input in inputs where input.gain != 0 {
                let availableStart=max(clip.sourceStartMs,input.offsetMs)
                let availableEnd=min(clip.sourceEndMs,input.offsetMs+Double(input.frameCount)/Self.rate*1000)
                guard availableEnd>availableStart else { continue }
                let start=Int64(((availableStart-input.offsetMs)*Self.rate/1000).rounded())
                let end=min(input.frameCount,Int64(((availableEnd-input.offsetMs)*Self.rate/1000).rounded()))
                let delay=Int64(((availableStart-clip.sourceStartMs)/clip.speed*Self.rate/1000).rounded())
                let duration=min(length-delay,Int64((Double(end-start)/clip.speed).rounded()))
                if duration>0 {
                    streams.append(try PCMClipAudioStream(input:input,start:start,end:end,speed:clip.speed,delay:delay,outputFrames:duration,format:format))
                }
            }
            var clipPosition:Int64=0
            while clipPosition<length {
                try Task.checkCancellation()
                let count=AVAudioFrameCount(min(Int64(Self.block),length-clipPosition))
                mixed.frameLength=count
                guard let channels=mixed.floatChannelData else { throw renderFailure("PCM mix format is unavailable") }
                for channel in 0..<2 { channels[channel].update(repeating:0,count:Int(count)) }
                for stream in streams { try await stream.add(to:mixed,at:clipPosition) }
                for channel in 0..<2 { for index in 0..<Int(count) { channels[channel][index]=max(-1,min(1,channels[channel][index])) } }
                try output.write(from:mixed)
                clipPosition += Int64(count); cursor += Int64(count)
            }
            for stream in streams { stream.stop() }
            elapsedMs += clip.durationMs
        }
        guard output.length == cursor else { throw renderFailure("PCM output frame count differs from the edited timeline") }
        return cursor
    }
    static func format() throws -> AVAudioFormat {
        guard let value=AVAudioFormat(standardFormatWithSampleRate:rate,channels:2) else { throw renderFailure("Cannot create the canonical PCM format") }; return value
    }
}

private final class PCMClipAudioStream:@unchecked Sendable {
    let gain:Float
    let delay:Int64
    let outputFrames:Int64
    let file:AVAudioFile
    let buffer:AVAudioPCMBuffer
    let renderBuffer:AVAudioPCMBuffer?
    let engine:AVAudioEngine?
    let player:AVAudioPlayerNode?
    var primingFrames:Int64=0
    init(input:PCMEditingAudioInput,start:Int64,end:Int64,speed:Double,delay:Int64,outputFrames:Int64,format:AVAudioFormat) throws {
        gain=Float(input.gain); self.delay=delay; self.outputFrames=outputFrames
        file=try AVAudioFile(forReading:input.url,commonFormat:.pcmFormatFloat32,interleaved:false)
        guard file.processingFormat.sampleRate == PCMEditingAudioRenderer.rate,file.processingFormat.channelCount == 2,
              start>=0,end>start,end<=file.length,UInt64(end-start)<=UInt64(UInt32.max),speed.isFinite,(1...8).contains(speed),
              let allocated=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:PCMEditingAudioRenderer.block) else { throw renderFailure("PCM clip range or format is invalid") }
        buffer=allocated
        if speed == 1 {
            engine=nil; player=nil; renderBuffer=nil; file.framePosition=start
        } else {
            guard let renderedBuffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:PCMEditingAudioRenderer.block) else { throw renderFailure("PCM pitch buffer allocation failed") }
            let offline=AVAudioEngine()
            // Set offline mode BEFORE touching mainMixer/input/output nodes;
            // the engine must never configure a hardware input or output.
            try offline.enableManualRenderingMode(.offline,format:format,maximumFrameCount:PCMEditingAudioRenderer.block)
            let node=AVAudioPlayerNode(),pitch=AVAudioUnitTimePitch()
            pitch.rate=Float(speed); pitch.pitch=0
            offline.attach(node); offline.attach(pitch)
            offline.connect(node,to:pitch,format:format)
            offline.connect(pitch,to:offline.mainMixerNode,format:format)
            node.scheduleSegment(file,startingFrame:start,frameCount:AVAudioFrameCount(end-start),at:nil,completionHandler:nil)
            try offline.start(); node.play()
            engine=offline; player=node; renderBuffer=renderedBuffer
            primingFrames=Int64((pitch.auAudioUnit.latency*PCMEditingAudioRenderer.rate).rounded())
        }
    }
    func add(to destination:AVAudioPCMBuffer,at position:Int64) async throws {
        let first=max(position,delay),last=min(position+Int64(destination.frameLength),delay+outputFrames)
        guard last>first else { return }
        while primingFrames>0 {
            let count=AVAudioFrameCount(min(primingFrames,Int64(PCMEditingAudioRenderer.block)))
            try await read(count); primingFrames -= Int64(count)
        }
        let count=AVAudioFrameCount(last-first)
        try await read(count)
        guard buffer.frameLength == count,let source=buffer.floatChannelData,let target=destination.floatChannelData else { throw renderFailure("PCM clip did not produce its expected frame count") }
        let offset=Int(first-position)
        for channel in 0..<2 { for index in 0..<Int(count) { target[channel][offset+index] += source[channel][index]*gain } }
    }
    private func read(_ count:AVAudioFrameCount) async throws {
        try Task.checkCancellation()
        guard let engine else { try file.read(into:buffer,frameCount:count); return }
        guard let renderBuffer,let channels=buffer.floatChannelData else { throw renderFailure("PCM pitch buffer is unavailable") }
        buffer.frameLength=0
        let deadline=ContinuousClock.now.advanced(by:.seconds(30))
        while buffer.frameLength<count {
            try Task.checkCancellation()
            let remaining=count-buffer.frameLength
            let state=try engine.renderOffline(remaining,to:renderBuffer)
            switch state {
            case .success,.insufficientDataFromInputNode,.cannotDoInCurrentContext: break
            case .error: throw renderFailure("Offline pitch processing failed")
            @unknown default: throw renderFailure("Unknown offline pitch processing state")
            }
            // AVAudioEngine can return a partial block with any nonfatal
            // status. Preserve those frames before requesting the remainder.
            guard renderBuffer.frameLength<=remaining,let renderedChannels=renderBuffer.floatChannelData else { throw renderFailure("PCM pitch processing produced an invalid block") }
            for channel in 0..<2 {
                channels[channel].advanced(by:Int(buffer.frameLength)).update(from:renderedChannels[channel],count:Int(renderBuffer.frameLength))
            }
            buffer.frameLength += renderBuffer.frameLength
            if buffer.frameLength<count {
                guard ContinuousClock.now<deadline else { throw ControlFailure(code:"pcm-timepitch-stalled",message:"Offline pitch processing did not produce the next audio block") }
                if renderBuffer.frameLength == 0 { try await Task.sleep(for:.milliseconds(1)) }
            }
        }
    }
    func stop() { player?.stop(); engine?.stop() }
    deinit { stop() }
}
