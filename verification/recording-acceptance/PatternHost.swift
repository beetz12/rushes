import AppKit
import AVFoundation
import Foundation
import Dispatch

// Reuse RushCore's existing host-scheduled test tone transport. This helper
// generates content only; no latency store or corrected selftest report is used.
@MainActor
final class CaptureQualificationWindow: NSObject, NSApplicationDelegate {
    var window: NSWindow?
    var flash: NSWindow?
    var arming: Timer?
    var heartbeat: Timer?
    var timers: [DispatchSourceTimer] = []
    let tone = SelftestTonePlayer()
    var activity: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard CommandLine.arguments.count == 6 else { exit(2) }
        struct Cues: Decodable { let times: [Double]; let width: Double }
        let cues = try! JSONDecoder().decode(Cues.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[4])))
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let count = AVAudioFrameCount(40 * 48000)
        let audio = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count)!
        audio.frameLength = count
        for frame in 0..<Int(count) {
            let t = Double(frame)/48000
            audio.floatChannelData![0][frame] = cues.times.contains { t >= $0 && t <= $0+cues.width }
                ? Float(0.01*sin(2*Double.pi*1763*t)+0.01*sin(2*Double.pi*2939*t)) : 0
        }
        do { try tone.prepare() } catch { print(error); exit(3) }
        activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "Bounded local capture qualification")
        let blue = NSColor(srgbRed: 20/255, green: 90/255, blue: 132/255, alpha: 1)
        let green = NSColor(srgbRed: 32/255, green: 192/255, blue: 80/255, alpha: 1)
        let panel = NSWindow(contentRect: NSRect(x: 80, y: 80, width: 640, height: 360), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = CommandLine.arguments[2]; panel.backgroundColor = blue; panel.isOpaque = true
        panel.level = .floating; panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.orderFrontRegardless(); NSApplication.shared.activate(ignoringOtherApps: true); window = panel
        panel.animationBehavior = .none
        let light = NSWindow(contentRect: NSScreen.screens.first!.frame, styleMask: .borderless, backing: .buffered, defer: false)
        light.backgroundColor = green; light.isOpaque = true; light.level = .floating
        light.animationBehavior = .none; light.ignoresMouseEvents = true; light.hidesOnDeactivate = false
        light.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; flash = light
        var begin: UInt64 = 0
        let armFile = CommandLine.arguments[5]
        arming = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] timer in
            MainActor.assumeIsolated {
                guard let self, begin == 0, let data = try? Data(contentsOf: URL(fileURLWithPath: armFile)),
                      let value = try? JSONSerialization.jsonObject(with: data) as? [String: Bool], value["arm"] == true else { return }
                begin = DispatchTime.now().uptimeNanoseconds + 500_000_000
                self.tone.play(audio, atHostNs: Int64(begin))
                for t in cues.times {
                    for (time, show) in [(t, true), (t+cues.width, false)] {
                        let signal = DispatchSource.makeTimerSource(queue: .main)
                        signal.schedule(deadline: DispatchTime(uptimeNanoseconds: begin+UInt64(time*1e9)))
                        signal.setEventHandler { MainActor.assumeIsolated { if show { light.orderFrontRegardless() } else { light.orderOut(nil) } } }
                        signal.resume(); self.timers.append(signal)
                    }
                }
                timer.invalidate()
            }
        }
        let rect = panel.frame, top = NSScreen.screens.first!.frame.maxY
        let bounds: [String: Double] = ["X":rect.minX,"Y":top-rect.maxY,"Width":rect.width,"Height":rect.height]
        let file = CommandLine.arguments[3]
        heartbeat = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            MainActor.assumeIsolated {
                let elapsed = begin == 0 ? 0 : Double(DispatchTime.now().uptimeNanoseconds)-Double(begin)
                let value: [String: Any] = ["windowNumber":panel.windowNumber,"pid":ProcessInfo.processInfo.processIdentifier,"title":panel.title,"bounds":bounds,"bundleID":Bundle.main.bundleIdentifier ?? "","signalPrepared":true,"scheduledHostNs":begin,"elapsedSeconds":max(0,elapsed/1e9)]
                let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
                let handle = try! FileHandle(forWritingTo: URL(fileURLWithPath: file))
                try! handle.seekToEnd(); try! handle.write(contentsOf: data+Data([10])); try! handle.close()
            }
        }
    }
}
@main struct CaptureQualificationPattern {
    @MainActor static func main() {
        let app = NSApplication.shared; app.setActivationPolicy(.accessory)
        let owner = CaptureQualificationWindow(); app.delegate = owner; app.run(); withExtendedLifetime(owner) {}
    }
}
