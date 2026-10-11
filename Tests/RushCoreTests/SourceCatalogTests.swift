import Testing
@testable import RushCore

@Suite("SourceIds")
struct SourceIdsTests {

    @Test("Display ids embed the CGDirectDisplayID")
    func displayIds() {
        #expect(SourceIds.display(1) == "display-1")
        #expect(SourceIds.display(458_092_311) == "display-458092311")
    }

    @Test("Window ids embed the window server id")
    func windowIds() {
        #expect(SourceIds.window(9182) == "window-9182")
    }

    @Test("A device with a uniqueID uses it, sanitized")
    func uniqueIDPreferred() {
        #expect(SourceIds.device(uniqueID: "0x1420000005ac8505", modelName: "FaceTime HD Camera") == "dev-0x1420000005ac8505")
    }

    @Test("An empty uniqueID falls back to the model name")
    func emptyUniqueIDFallsBack() {
        #expect(SourceIds.device(uniqueID: "", modelName: "USB Audio Codec") == "name-usb-audio-codec")
        #expect(SourceIds.device(uniqueID: "   ", modelName: "USB Audio Codec") == "name-usb-audio-codec")
    }

    @Test("A missing uniqueID and name becomes dev-unknown")
    func noIdentifiersAtAll() {
        #expect(SourceIds.device(uniqueID: nil, modelName: nil) == "dev-unknown")
        #expect(SourceIds.device(uniqueID: nil, modelName: "  ") == "dev-unknown")
    }

    @Test("Model names are sanitized to a stable slug")
    func sanitizedSlug() {
        #expect(SourceIds.device(uniqueID: nil, modelName: "MacBook Pro Microphone") == "name-macbook-pro-microphone")
        #expect(SourceIds.device(uniqueID: nil, modelName: "C922 Pro__Stream!") == "name-c922-pro-stream")
    }

    @Test("Same-name devices are disambiguated by position after the first")
    func disambiguatedPositions() {
        #expect(SourceIds.device(uniqueID: nil, modelName: "Yeti", position: 0) == "name-yeti")
        #expect(SourceIds.device(uniqueID: nil, modelName: "Yeti", position: 1) == "name-yeti-1")
        #expect(SourceIds.device(uniqueID: nil, modelName: "Yeti", position: 2) == "name-yeti-2")
    }

    @Test("Ids are repeatable: same inputs, same id")
    func repeatable() {
        let a = SourceIds.device(uniqueID: nil, modelName: "Yeti", position: 1)
        let b = SourceIds.device(uniqueID: nil, modelName: "Yeti", position: 1)
        #expect(a == b)
    }
}

@Suite("SourceCatalog")
struct SourceCatalogTests {

    struct FixedCatalog: SourceCataloging {
        let fixedDisplays: [DisplaySource]
        let fixedWindows: [WindowSource]
        let fixedCameras: [CameraDevice]
        let fixedMicrophones: [MicrophoneDevice]

        func displays() async throws -> [DisplaySource] { fixedDisplays }
        func windows() async throws -> [WindowSource] { fixedWindows }
        func cameras() async throws -> [CameraDevice] { fixedCameras }
        func microphones() async throws -> [MicrophoneDevice] { fixedMicrophones }
    }

    @Test("A conforming catalog round-trips through the protocol")
    func protocolRoundTrip() async throws {
        let catalog = FixedCatalog(
            fixedDisplays: [DisplaySource(id: "display-1", name: "Built-in", widthPoints: 1512, heightPoints: 982, isMain: true)],
            fixedWindows: [WindowSource(id: "window-42", title: "Notes", owningApplication: "Notes", displayID: "display-1")],
            fixedCameras: [CameraDevice(id: "dev-0x1420000005ac8505", name: "FaceTime HD Camera")],
            fixedMicrophones: [MicrophoneDevice(id: "name-macbook-pro-microphone", name: "MacBook Pro Microphone")]
        )
        #expect(try await catalog.displays().count == 1)
        #expect(try await catalog.windows().first?.id == "window-42")
        #expect(try await catalog.cameras().first?.name == "FaceTime HD Camera")
        #expect(try await catalog.microphones().first?.id == "name-macbook-pro-microphone")
    }
}
