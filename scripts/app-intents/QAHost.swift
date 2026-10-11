import AppKit

// This scoped QA host contains no RushCore imports, engine launch or capture code.
@main
struct RushesIntentQAHost {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        app.run()
    }
}
