import Foundation

public struct ProjectedShareTimeline:Sendable {
    public let transcript:TranscriptDocument?
    public let chapters:[RecordingChapter]
}

/// Converts source-anchored words and chapter sections to the immutable share
/// video's output clock without modifying the source transcript or edit.
public enum ShareTimelineProjection {
    public static func project(edit:EditDocument,transcript:TranscriptDocument?,chapters:[RecordingChapter]) throws -> ProjectedShareTimeline {
        try edit.validate(sourceDurationMs:edit.clips.map(\.sourceEndMs).max() ?? 0)
        try RecordingMetadata(title:"Projection",summary:"",chapters:chapters).validate()
        if let transcript { try transcript.validate() }
        var outputWords:[TranscriptWord]=[],outputCues:[TranscriptCue]=[],outputChapters:[RecordingChapter]=[]
        var elapsed=0.0
        func appendChapter(_ title:String,at time:Double) {
            guard time<edit.durationMs,title != outputChapters.last?.title else { return }
            if let last=outputChapters.last,abs(last.startMs-time)<0.000_001 { outputChapters[outputChapters.count-1].title=title }
            else { outputChapters.append(RecordingChapter(startMs:time,title:title)) }
        }
        for clip in edit.clips {
            var clipWords:[TranscriptWord]=[]
            for original in transcript?.words ?? [] {
                let midpoint=(original.startMs+original.endMs)/2
                guard midpoint>=clip.sourceStartMs,midpoint<clip.sourceEndMs else { continue }
                let start=max(original.startMs,clip.sourceStartMs),end=min(original.endMs,clip.sourceEndMs)
                guard end>start else { continue }
                var word=original
                word.id="\(clip.id.utf8.count):\(clip.id)\(original.id.utf8.count):\(original.id)"
                word.startMs=elapsed+(start-clip.sourceStartMs)/clip.speed
                word.endMs=elapsed+(end-clip.sourceStartMs)/clip.speed
                word.timing=original.timing+"|edited-timeline"
                clipWords.append(word)
            }
            let boundary=elapsed+clip.durationMs
            for var cue in try CaptionBuilder.build(words:clipWords) {
                cue.startMs=max(elapsed,cue.startMs); cue.endMs=min(boundary,cue.endMs)
                if cue.endMs>cue.startMs { outputCues.append(cue) }
            }
            outputWords.append(contentsOf:clipWords)
            if let active=chapters.last(where:{$0.startMs<=clip.sourceStartMs}) { appendChapter(active.title,at:elapsed) }
            for chapter in chapters where chapter.startMs>=clip.sourceStartMs && chapter.startMs<clip.sourceEndMs {
                appendChapter(chapter.title,at:elapsed+(chapter.startMs-clip.sourceStartMs)/clip.speed)
            }
            elapsed=boundary
        }
        let projected:TranscriptDocument?
        if let transcript {
            projected=try TranscriptDocument(locale:transcript.locale,inputFile:"video.mp4",durationMs:edit.durationMs,words:outputWords,cues:outputCues,engine:transcript.engine+"; edited timeline")
        } else { projected=nil }
        try RecordingMetadata(title:"Projection",summary:"",chapters:outputChapters).validate(durationMs:edit.durationMs)
        return ProjectedShareTimeline(transcript:projected,chapters:outputChapters)
    }
}
