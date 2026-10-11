import AppKit
import CoreGraphics
import Foundation

@MainActor final class MovingView: NSView {
    var phase: Int = 0
    override var isOpaque: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill(); bounds.fill()
        let colors: [NSColor] = [.systemRed, .systemBlue, .systemGreen, .systemOrange]
        colors[(phase / 5) % colors.count].setFill()
        let x = CGFloat((phase * 7) % 125) + 8
        NSRect(x: x, y: 25, width: 40, height: 70).fill()
        let text = "Rushes QA \(phase)" as NSString
        text.draw(at: NSPoint(x: 8, y: 5), withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: NSColor.black])
    }
}

@main struct MovingControl {
    @MainActor static func main() {
        func idleSeconds() -> Double {
            let query = Process()
            query.executableURL = URL(fileURLWithPath: "/usr/sbin/ioreg")
            query.arguments = ["-c", "IOHIDSystem"]
            let output = Pipe(); query.standardOutput = output
            do { try query.run() } catch { return 0 }
            let bytes = output.fileHandleForReading.readDataToEndOfFile()
            query.waitUntilExit()
            guard query.terminationStatus == 0,
                  let text = String(data: bytes, encoding: .utf8),
                  let range = text.range(of: "\"HIDIdleTime\" = "),
                  let line = text[range.upperBound...].split(separator: "\n").first,
                  let ns = Double(line.trimmingCharacters(in: .whitespaces)) else { return 0 }
            return ns / 1e9
        }
        let deadline = Date().addingTimeInterval(30)
        while idleSeconds() < 3 {
            if Date() >= deadline { print("{\"error\":\"user-not-idle\"}"); exit(1) }
            Thread.sleep(forTimeInterval: 0.25)
        }
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let screen = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
        } ?? NSScreen.screens[0]
        let panel = NSPanel(contentRect: NSRect(x: screen.frame.minX + 12, y: screen.frame.minY + 12, width: 180, height: 120), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Rushes deterministic recording QA"
        panel.isFloatingPanel = false
        panel.level = .normal
        panel.ignoresMouseEvents = true
        panel.sharingType = .readOnly
        let view = MovingView(frame: NSRect(x: 0, y: 0, width: 180, height: 120))
        panel.contentView = view
        // Keep it behind the user's windows; window capture still follows it.
        let observedIdle = idleSeconds()
        guard observedIdle >= 3 else { print("{\"error\":\"user-active-before-show\"}"); exit(1) }
        panel.orderBack(nil)
        print("{\"window\":\"window-\(panel.windowNumber)\",\"idleSeconds\":\(observedIdle),\"camera\":false,\"audio\":false}")
        fflush(stdout)
        _ = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            MainActor.assumeIsolated { view.phase += 1; view.needsDisplay = true }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { panel.orderOut(nil); app.stop(nil); exit(0) }
        app.run()
    }
}
