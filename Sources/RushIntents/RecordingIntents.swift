import AppIntents
import Foundation
import RushCore

public struct StartRecordingIntent: AppIntent {
    public static var title: LocalizedStringResource { "Start Recording" }
    public static var description: IntentDescription { "Start a local Rushes recording. Camera and microphone stay off unless selected. Open Rushes and grant capture permissions first." }
    public static var supportedModes: IntentModes { .background }
    // IntentExecutionTargets exists only in the macOS 27 SDK; @available covers
    // the runtime floor and the compiler gate lets the package build on the
    // macOS 26 SDK (CI), where the optimization knob is simply absent.
    #if compiler(>=6.4)
    @available(macOS 27.0, *)
    public static var allowedExecutionTargets: IntentExecutionTargets {
        #if RUSHES_INTENTS_MAIN_HOST
        return .main
        #else
        return .appIntentsExtension
        #endif
    }
    #endif
    @Parameter(title: "Source", default: .display) public var source: RecordingSourceSelection
    @Parameter(title: "Display or window ID", default: "main") public var sourceID: String
    @Parameter(title: "Camera", default: RecordingDeviceSelection.none) public var camera: RecordingDeviceSelection
    @Parameter(title: "Camera ID", default: "") public var cameraID: String
    @Parameter(title: "Microphone", default: RecordingDeviceSelection.none) public var microphone: RecordingDeviceSelection
    @Parameter(title: "Microphone ID", default: "") public var microphoneID: String
    @Parameter(title: "System audio", default: false) public var systemAudio: Bool
    @Parameter(title: "Countdown seconds", default: 0) public var countdown: Int
    @Parameter(title: "Title", default: "Shortcuts recording") public var recordingTitle: String
    @Parameter(title: "Region left", default: 0) public var regionX: Double
    @Parameter(title: "Region top", default: 0) public var regionY: Double
    @Parameter(title: "Region width", default: 1280) public var regionWidth: Double
    @Parameter(title: "Region height", default: 720) public var regionHeight: Double
    public static var parameterSummary: some ParameterSummary {
        Summary("Record \(\.$source) with Rushes") {
            \.$sourceID; \.$camera; \.$cameraID; \.$microphone; \.$microphoneID
            \.$systemAudio; \.$countdown; \.$recordingTitle
            \.$regionX; \.$regionY; \.$regionWidth; \.$regionHeight
        }
    }
    public init() {}
    public func options() -> IntentStartOptions {
        var options = IntentStartOptions()
        options.source = source; options.sourceID = sourceID
        options.camera = camera; options.cameraID = cameraID
        options.microphone = microphone; options.microphoneID = microphoneID
        options.systemAudio = systemAudio; options.countdown = countdown; options.title = recordingTitle
        options.regionX = regionX; options.regionY = regionY; options.regionWidth = regionWidth; options.regionHeight = regionHeight
        return options
    }
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        try await perform(using: IntentEngineBridge())
    }
    public func perform(using bridge: any IntentCommandSending) async throws -> some IntentResult & ReturnsValue<String> {
        let result = try await bridge.send(options().request())
        guard let id = result["id"]?.string, RecordingId.isValid(id), result["state"]?.string == "recording" else {
            throw IntentBridgeError(code: "invalid-response", message: "Rushes did not confirm that recording started.")
        }
        return .result(value: id)
    }
}

public struct StopRecordingIntent: AppIntent {
    public static var title: LocalizedStringResource { "Stop Recording" }
    public static var description: IntentDescription { "Stop the active local Rushes recording and return its package folder path. An optional recording ID limits the action to that take." }
    public static var supportedModes: IntentModes { .background }
    // IntentExecutionTargets exists only in the macOS 27 SDK; @available covers
    // the runtime floor and the compiler gate lets the package build on the
    // macOS 26 SDK (CI), where the optimization knob is simply absent.
    #if compiler(>=6.4)
    @available(macOS 27.0, *)
    public static var allowedExecutionTargets: IntentExecutionTargets {
        #if RUSHES_INTENTS_MAIN_HOST
        return .main
        #else
        return .appIntentsExtension
        #endif
    }
    #endif
    @Parameter(title: "Recording ID") public var recordingID: String?
    public static var parameterSummary: some ParameterSummary { Summary("Stop recording in Rushes") { \.$recordingID } }
    public init() {}
    public func perform() async throws -> some IntentResult & ReturnsValue<String> {
        try await perform(using: IntentEngineBridge())
    }
    public func perform(using bridge: any IntentCommandSending) async throws -> some IntentResult & ReturnsValue<String> {
        var arguments: [String: JSONValue] = [:]
        if let id = recordingID, !id.isEmpty {
            guard RecordingId.isValid(id) else { throw IntentBridgeError(code: "invalid-params", message: "Use the recording ID returned by Start Recording, or leave it empty to stop the active take.") }
            arguments["id"] = .string(id)
        }
        let result = try await bridge.send(ControlRequest(id: UUID().uuidString, cmd: "record.stop", args: .object(arguments)))
        guard let path = result["packagePath"]?.string, path.hasPrefix("/"), !path.contains("\0"),
              let state = result["status"]?.string, ["complete", "ended-early", "recovered"].contains(state) else {
            throw IntentBridgeError(code: "invalid-response", message: "Rushes could not confirm a finalized recording package. Check the library for preserved footage.")
        }
        return .result(value: path)
    }
}

public struct RushesAppShortcuts: AppShortcutsProvider {
    public static var shortcutTileColor: ShortcutTileColor { .blue }
    public static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: StartRecordingIntent(), phrases: ["Start recording with \(.applicationName)", "Record my screen with \(.applicationName)"], shortTitle: "Start Recording", systemImageName: "record.circle")
        AppShortcut(intent: StopRecordingIntent(), phrases: ["Stop recording with \(.applicationName)"], shortTitle: "Stop Recording", systemImageName: "stop.circle")
    }
}

public struct RushesIntentsPackage: AppIntentsPackage {
    public init() {}
}
