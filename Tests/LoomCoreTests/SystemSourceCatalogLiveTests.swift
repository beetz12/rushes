import Foundation
import Testing
@testable import LoomCore

/// Live hardware checks. Skipped unless LOOM_LIVE_TESTS=1, because they read
/// the real display, camera and microphone lists. Listing sources does not
/// trigger macOS permission prompts; it only reads device metadata.
@Suite("SystemSourceCatalog live", .enabled(if: ProcessInfo.processInfo.environment["LOOM_LIVE_TESTS"] == "1"))
struct SystemSourceCatalogLiveTests {

    @Test("Lists at least one display, camera and microphone with stable ids")
    func enumeratesRealSources() async throws {
        let catalog = SystemSourceCatalog()

        let displays = try await catalog.displays()
        #expect(!displays.isEmpty)
        #expect(displays.contains { $0.isMain })

        let cameras = try await catalog.cameras()
        #expect(!cameras.isEmpty)

        let microphones = try await catalog.microphones()
        #expect(!microphones.isEmpty)

        // Ids must be stable across two reads.
        let displaysAgain = try await catalog.displays()
        #expect(Set(displays.map(\.id)) == Set(displaysAgain.map(\.id)))

        let camerasAgain = try await catalog.cameras()
        #expect(Set(cameras.map(\.id)) == Set(camerasAgain.map(\.id)))

        let microphonesAgain = try await catalog.microphones()
        #expect(Set(microphones.map(\.id)) == Set(microphonesAgain.map(\.id)))
    }

    @Test("Window listing returns on-screen windows only")
    func listsWindows() async throws {
        let catalog = SystemSourceCatalog()
        let windows = try await catalog.windows()
        // On a running desktop there is always at least one on-screen window.
        #expect(!windows.isEmpty)
        #expect(windows.allSatisfy { $0.id.hasPrefix("window-") })
    }
}
