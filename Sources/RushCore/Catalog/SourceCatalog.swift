import AppKit
import AVFoundation
import CoreGraphics
import ScreenCaptureKit

/// Stable identifiers and pure mapping rules for capture sources.
///
/// The plan requires ids that are "the same across two runs". Screen ids come
/// from `CGDirectDisplayID`, window ids from the window server, camera and
/// microphone ids from the device's persistent `uniqueID` with a fallback to
/// the model name when a driver does not provide one.
public enum SourceIds {

    /// Stable id for a display: `"display-"` plus the `CGDirectDisplayID`
    /// in decimal.
    public static func display(_ cgID: CGDirectDisplayID) -> String {
        "display-\(cgID)"
    }

    /// Stable id for a window: `"window-"` plus the window server id.
    public static func window(_ windowID: Int) -> String {
        "window-\(windowID)"
    }

    /// Stable id for a camera or microphone. Prefers the device's persistent
    /// `uniqueID`; when a driver reports none, falls back to the model name,
    /// and when several devices share that name, disambiguates with the
    /// position in the shared-name group so ids stay unique and repeatable
    /// within a hardware configuration.
    public static func device(uniqueID: String?, modelName: String?, position: Int = 0) -> String {
        let sanitized: (String) -> String = { raw in
            let lowered = raw.lowercased()
            let allowed = lowered.map { ch -> Character in
                (ch.isLetter && ch.isASCII) || (ch.isNumber && ch.isASCII) || ch == "-" ? ch : "-"
            }
            var s = String(allowed)
            while s.contains("--") { s = s.replacingOccurrences(of: "--", with: "-") }
            while s.hasPrefix("-") { s.removeFirst() }
            while s.hasSuffix("-") { s.removeLast() }
            return s.isEmpty ? "unknown" : s
        }
        var base: String
        if let uid = uniqueID, !uid.trimmingCharacters(in: .whitespaces).isEmpty {
            base = "dev-" + sanitized(uid)
        } else if let model = modelName, !model.trimmingCharacters(in: .whitespaces).isEmpty {
            base = "name-" + sanitized(model)
            if position > 0 { base += "-\(position)" }
        } else {
            base = "dev-unknown"
        }
        return base
    }
}

public struct DisplaySource: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let widthPoints: Int
    public let heightPoints: Int
    public let isMain: Bool

    public init(id: String, name: String, widthPoints: Int, heightPoints: Int, isMain: Bool) {
        self.id = id
        self.name = name
        self.widthPoints = widthPoints
        self.heightPoints = heightPoints
        self.isMain = isMain
    }
}

public struct WindowSource: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let owningApplication: String
    public let displayID: String

    public init(id: String, title: String, owningApplication: String, displayID: String) {
        self.id = id
        self.title = title
        self.owningApplication = owningApplication
        self.displayID = displayID
    }
}

public struct CameraDevice: Codable, Equatable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

public struct MicrophoneDevice: Codable, Equatable, Sendable {
    public let id: String
    public let name: String

    public init(id: String, name: String) {
        self.id = id
        self.name = name
    }
}

/// Lists capture sources. Implemented by `SystemSourceCatalog` against live
/// system APIs; tests provide their own conforming types.
public protocol SourceCataloging: Sendable {
    func displays() async throws -> [DisplaySource]
    func windows() async throws -> [WindowSource]
    func cameras() async throws -> [CameraDevice]
    func microphones() async throws -> [MicrophoneDevice]
}

/// The live catalog, backed by ScreenCaptureKit and AVFoundation.
public struct SystemSourceCatalog: SourceCataloging {

    public init() {}

    public func displays() async throws -> [DisplaySource] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        let mainID = CGMainDisplayID()
        return content.displays.map { display -> DisplaySource in
            let bounds = display.frame
            let width = Int(bounds.width)
            let height = Int(bounds.height)
            return DisplaySource(
                id: SourceIds.display(display.displayID),
                name: Self.screenName(for: display.displayID),
                widthPoints: width,
                heightPoints: height,
                isMain: display.displayID == mainID
            )
        }
    }

    public func windows() async throws -> [WindowSource] {
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let displayFrames = content.displays.map { display -> (String, CGRect) in
            (SourceIds.display(display.displayID), display.frame)
        }
        return content.windows.map { window -> WindowSource in
            let owner = window.owningApplication
            let displayID = displayFrames.first { _, frame in
                frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY))
            }?.0 ?? SourceIds.display(CGMainDisplayID())
            return WindowSource(
                id: SourceIds.window(Int(window.windowID)),
                title: window.title ?? "",
                owningApplication: owner?.bundleIdentifier ?? "",
                displayID: displayID
            )
        }
    }

    public func cameras() async throws -> [CameraDevice] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera, .external],
            mediaType: .video,
            position: .unspecified
        )
        var seenNames: [String: Int] = [:]
        return session.devices.map { device in
            let key = device.localizedName
            let position = seenNames[key, default: 0]
            seenNames[key, default: 0] += 1
            return CameraDevice(
                id: SourceIds.device(uniqueID: device.uniqueID, modelName: key, position: position),
                name: key
            )
        }
    }

    public func microphones() async throws -> [MicrophoneDevice] {
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external],
            mediaType: .audio,
            position: .unspecified
        )
        var seenNames: [String: Int] = [:]
        return session.devices.map { device in
            let key = device.localizedName
            let position = seenNames[key, default: 0]
            seenNames[key, default: 0] += 1
            return MicrophoneDevice(
                id: SourceIds.device(uniqueID: device.uniqueID, modelName: key, position: position),
                name: key
            )
        }
    }

    /// Localized screen names come from AppKit, matched by CGDirectDisplayID.
    private static func screenName(for displayID: CGDirectDisplayID) -> String {
        for screen in NSScreen.screens {
            if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
               number.uint32Value == displayID {
                let name = screen.localizedName.trimmingCharacters(in: .whitespaces)
                if !name.isEmpty { return name }
            }
        }
        return "Display \(displayID)"
    }

}

/// Explicit diagnostic catalog: --capture-stub must never invoke a live screen
/// sharing API or contend for devices while unrelated real capture runs.
public struct DiagnosticSourceCatalog: SourceCataloging {
    public init() {}
    public func displays() async throws -> [DisplaySource] { [.init(id: "display-diagnostic", name: "Synthetic display", widthPoints: 640, heightPoints: 480, isMain: true)] }
    public func windows() async throws -> [WindowSource] { [] }
    public func cameras() async throws -> [CameraDevice] { [.init(id: "camera-diagnostic", name: "Synthetic camera")] }
    public func microphones() async throws -> [MicrophoneDevice] { [.init(id: "mic-diagnostic", name: "Synthetic microphone")] }
}
