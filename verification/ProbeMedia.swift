import AVFoundation
import Foundation

/// An independent decoder: read every sample and report actual timeline bounds.
/// It deliberately does not call RushCore's MediaProbing or PackageVerifier.
@main
struct ProbeMedia {
    static func main() async {
        var records: [[String: Any]] = []
        var success = true
        for path in CommandLine.arguments.dropFirst() {
            do {
                let asset = AVURLAsset(url: URL(fileURLWithPath: path))
                let duration = try await asset.load(.duration).seconds
                let tracks = try await asset.load(.tracks)
                var decoded: [[String: Any]] = []
                for track in tracks {
                    let type = track.mediaType
                    guard type == .video || type == .audio else { continue }
                    let reader = try AVAssetReader(asset: asset)
                    let settings: [String: Any] = type == .video
                        ? [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
                        : [AVFormatIDKey: kAudioFormatLinearPCM,
                           AVLinearPCMIsFloatKey: true, AVLinearPCMBitDepthKey: 32]
                    let output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
                    reader.add(output)
                    guard reader.startReading() else { throw reader.error ?? ProbeError.start }
                    var count = 0
                    var first: Double?
                    var last: Double?
                    var end = 0.0
                    var maximumGap = 0.0
                    var previousEnd: Double?
                    var firstPixelBGRA: [Int]?
                    var videoSize: [Int]?
                    while let sample = output.copyNextSampleBuffer() {
                        let pts = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                        let sampleDuration = CMSampleBufferGetDuration(sample).seconds
                        guard pts.isFinite, sampleDuration.isFinite else { throw ProbeError.timing }
                        if let last, pts < last { throw ProbeError.order }
                        if let previousEnd { maximumGap = max(maximumGap, pts - previousEnd) }
                        if type == .video, CMSampleBufferGetImageBuffer(sample) == nil {
                            throw ProbeError.decode
                        }
                        if type == .video, firstPixelBGRA == nil,
                           let pixels = CMSampleBufferGetImageBuffer(sample) {
                            CVPixelBufferLockBaseAddress(pixels, .readOnly)
                            if let base = CVPixelBufferGetBaseAddress(pixels) {
                                let width = CVPixelBufferGetWidth(pixels)
                                let height = CVPixelBufferGetHeight(pixels)
                                let center = base.advanced(by: (height / 2) * CVPixelBufferGetBytesPerRow(pixels) + (width / 2) * 4)
                                    .assumingMemoryBound(to: UInt8.self)
                                firstPixelBGRA = (0..<4).map { Int(center[$0]) }
                                videoSize = [width, height]
                            }
                            CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
                        }
                        if type == .audio, CMSampleBufferGetDataBuffer(sample) == nil {
                            throw ProbeError.decode
                        }
                        if first == nil { first = pts }
                        last = pts
                        previousEnd = pts + sampleDuration
                        end = max(end, pts + sampleDuration)
                        count += 1
                    }
                    guard reader.status == .completed, count > 0 else {
                        throw reader.error ?? ProbeError.empty
                    }
                    var detail: [String: Any] = ["type": type.rawValue, "samples": count,
                                                "firstPTS": first!, "lastPTS": last!,
                                                "sampleEnd": end, "maximumGap": maximumGap]
                    if let firstPixelBGRA { detail["firstCenterBGRA"] = firstPixelBGRA }
                    if let videoSize { detail["videoSize"] = videoSize }
                    if type == .video { detail["nominalFrameRate"] = try await track.load(.nominalFrameRate) }
                    decoded.append(detail)
                }
                guard duration.isFinite, !decoded.isEmpty else { throw ProbeError.empty }
                records.append(["path": path, "ok": true, "duration": duration,
                                "decodedTracks": decoded])
            } catch {
                success = false
                records.append(["path": path, "ok": false, "error": String(describing: error)])
            }
        }
        let data = try! JSONSerialization.data(withJSONObject: records, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        exit(success ? 0 : 1)
    }
    enum ProbeError: Error { case start, timing, order, decode, empty }
}
