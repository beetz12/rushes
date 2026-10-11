import AppIntents
import Foundation
import RushCore

public enum RecordingSourceSelection: String, AppEnum, Sendable {
    case display, window, region, cameraOnly, audioOnly
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Recording source" }
    public static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [.display: "Display", .window: "Window", .region: "Region", .cameraOnly: "Camera only", .audioOnly: "Audio only"]
    }
}

public enum RecordingDeviceSelection: String, AppEnum, Sendable {
    case none, defaultDevice, specificDevice
    public static var typeDisplayRepresentation: TypeDisplayRepresentation { "Recording device" }
    public static var caseDisplayRepresentations: [Self: DisplayRepresentation] {
        [.none: "Off", .defaultDevice: "Default device", .specificDevice: "Device ID"]
    }
}

/// Pure parameter-to-engine translation. It never discovers or opens devices.
public struct IntentStartOptions: Sendable {
    public var source: RecordingSourceSelection = .display
    public var sourceID = "main"
    public var camera: RecordingDeviceSelection = .none
    public var cameraID = ""
    public var microphone: RecordingDeviceSelection = .none
    public var microphoneID = ""
    public var systemAudio = false
    public var countdown = 0
    public var title = "Shortcuts recording"
    public var regionX: Double = 0
    public var regionY: Double = 0
    public var regionWidth: Double = 1280
    public var regionHeight: Double = 720
    public init() {}

    public func request(id: String = UUID().uuidString) throws -> ControlRequest {
        let sourceID = self.sourceID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (0...10).contains(countdown), !title.isEmpty, title.count <= 300,
              !title.contains("\0") else { throw IntentBridgeError(code: "invalid-params", message: "Use a title of at most 300 characters and a countdown from 0 to 10 seconds.") }
        let camera = try deviceValue(camera, id: cameraID, name: "camera")
        let microphone = try deviceValue(microphone, id: microphoneID, name: "microphone")
        var args: [String: JSONValue] = ["camera": .string(camera), "mic": .string(microphone),
            "systemAudio": .bool(systemAudio), "countdownSeconds": .int(Int64(countdown)), "title": .string(title)]
        switch source {
        case .display, .region:
            guard sourceID == "main" || validSourceID(sourceID, prefix: "display-") else {
                throw IntentBridgeError(code: "invalid-params", message: "Display ID must be main or a display ID returned by Rushes targets.")
            }
            args["display"] = .string(sourceID)
            if source == .region {
                guard [regionX, regionY, regionWidth, regionHeight].allSatisfy(\.isFinite), regionWidth > 0, regionHeight > 0 else {
                    throw IntentBridgeError(code: "invalid-params", message: "The region needs finite coordinates and positive width and height.")
                }
                args["area"] = .object(["x": .double(regionX), "y": .double(regionY), "width": .double(regionWidth), "height": .double(regionHeight)])
            }
        case .window:
            guard validSourceID(sourceID, prefix: "window-") else {
                throw IntentBridgeError(code: "invalid-params", message: "Choose a window ID returned by Rushes targets.")
            }
            args["window"] = .string(sourceID)
        case .cameraOnly:
            guard camera != "none" else { throw IntentBridgeError(code: "invalid-params", message: "Camera-only recording requires an explicit camera selection.") }
        case .audioOnly:
            guard microphone != "none" || systemAudio else { throw IntentBridgeError(code: "invalid-params", message: "Audio-only recording requires a microphone or system audio.") }
        }
        return ControlRequest(id: id, cmd: "record.start", args: .object(args))
    }
    private func validSourceID(_ value: String, prefix: String) -> Bool {
        guard value.hasPrefix(prefix), let number = UInt32(value.dropFirst(prefix.count)), number > 0 else { return false }
        return true
    }
    private func deviceValue(_ selection: RecordingDeviceSelection, id: String, name: String) throws -> String {
        switch selection {
        case .none: return "none"
        case .defaultDevice: return "default"
        case .specificDevice:
            guard !id.isEmpty, id.count <= 300, !id.contains(where: { $0.isNewline || $0 == "\0" }), !["none", "default"].contains(id) else {
                throw IntentBridgeError(code: "invalid-params", message: "Enter the selected \(name) ID returned by Rushes targets.")
            }
            return id
        }
    }
}
