import CoreGraphics
import CoreImage
import CoreText
import Foundation

struct CaptionOverlay {
    struct Cue { var startMs:Double; var endMs:Double; var image:CIImage }
    var cues:[Cue]=[]
    func image(at sourceMs:Double) -> CIImage? { cues.first { $0.startMs <= sourceMs && $0.endMs > sourceMs }?.image }
    static func load(package:RecordingPackage,settings:EditCaptions,width:Int,height:Int) throws -> CaptionOverlay {
        guard settings.burnIn else { return CaptionOverlay() }
        let url=try PostproductionPaths.file("transcript.json",in:package.folderURL,requireExists:false)
        guard FileManager.default.fileExists(atPath:url.path) else { throw renderFailure("Caption burn-in requires a completed transcript") }
        let document=try JSONDecoder().decode(JSONValue.self,from:Data(contentsOf:url))
        let words=document["words"]?.array ?? []
        let index=Dictionary(words.compactMap { word -> (String,String)? in guard let id=word["id"]?.string,let text=word["text"]?.string else { return nil }; return (id,text) },uniquingKeysWith: { _,new in new })
        let entries=document["cues"]?.array ?? []
        var cues:[Cue]=[]
        for cue in entries {
            guard let start=cue["startMs"]?.double,let end=cue["endMs"]?.double,end>start else { continue }
            let text=cue["text"]?.string ?? (cue["wordIds"]?.array ?? []).compactMap { $0.string.flatMap { index[$0] } }.joined(separator:" ")
            if let overlay=OverlayArtwork.caption(text:text,width:width,height:height,fontSize:settings.fontSize,position:settings.position) { cues.append(Cue(startMs:start,endMs:end,image:CIImage(cgImage:overlay))) }
        }
        return CaptionOverlay(cues:cues)
    }
}
enum OverlayArtwork {
    static func caption(text:String,width:Int,height:Int,fontSize:Double,position:Double) -> CGImage? {
        guard !text.isEmpty,let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let font=CTFontCreateWithName("Helvetica-Bold" as CFString,CGFloat(fontSize)*CGFloat(width)/1920,nil)
        let attributes:[NSAttributedString.Key:Any]=[NSAttributedString.Key(kCTFontAttributeName as String):font,NSAttributedString.Key(kCTForegroundColorAttributeName as String):CGColor(gray:1,alpha:1)]
        let attributed=NSAttributedString(string:text,attributes:attributes)
        let framesetter=CTFramesetterCreateWithAttributedString(attributed)
        let maximum=CGFloat(width)*0.88
        let size=CTFramesetterSuggestFrameSizeWithConstraints(framesetter,CFRange(location:0,length:0),nil,CGSize(width:maximum,height:CGFloat(height)*0.4),nil)
        let textRect=CGRect(x:(CGFloat(width)-size.width)/2,y:CGFloat(height)*(1-position),width:size.width+1,height:size.height+2)
        let background=textRect.insetBy(dx:-CGFloat(width)*0.012,dy:-CGFloat(height)*0.012)
        context.setFillColor(CGColor(gray:0,alpha:0.72)); context.addPath(CGPath(roundedRect:background,cornerWidth:8,cornerHeight:8,transform:nil)); context.fillPath()
        let path=CGPath(rect:textRect,transform:nil)
        CTFrameDraw(CTFramesetterCreateFrame(framesetter,CFRange(location:0,length:0),path,nil),context)
        return context.makeImage()
    }
    static func cursor(size:CGFloat) -> CGImage? {
        let edge=max(16,Int(size*1.5))
        guard let context=CGContext(data:nil,width:edge,height:edge,bitsPerComponent:8,bytesPerRow:edge*4,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.move(to:CGPoint(x:2,y:CGFloat(edge)-2)); context.addLine(to:CGPoint(x:2,y:2)); context.addLine(to:CGPoint(x:size*0.35,y:size*0.35)); context.addLine(to:CGPoint(x:size*0.55,y:1)); context.addLine(to:CGPoint(x:size*0.72,y:4)); context.addLine(to:CGPoint(x:size*0.53,y:size*0.40)); context.addLine(to:CGPoint(x:size,y:size*0.40)); context.closePath()
        context.setFillColor(CGColor(gray:0,alpha:1)); context.setStrokeColor(CGColor(gray:1,alpha:1)); context.setLineWidth(2); context.drawPath(using:.fillStroke)
        return context.makeImage()
    }
}
