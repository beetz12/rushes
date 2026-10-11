import AppIntents
import ExtensionFoundation
import RushIntents

#if RUSHES_INTENTS_MAIN_HOST
import AppKit

// Native main-process host for Electron's embedded automation helper.
// It never starts the engine or opens a capture device.
@main
@MainActor
struct RushesAutomationHost {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        RushesAppShortcuts.updateAppShortcutParameters()
        app.run()
    }
}
#else
@main
struct RushesIntentExtension: AppIntentsExtension {}
#endif

struct RushesExtensionIntentsPackage: AppIntentsPackage {
    static var includedPackages: [any AppIntentsPackage.Type] { [RushesIntentsPackage.self] }
}
