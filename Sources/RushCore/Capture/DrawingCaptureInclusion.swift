import Foundation

/// A dedicated shell drawing panel is the only own-app window permitted back
/// into display/area capture. Validation has no UI or capture side effects.
public actor DrawingCaptureInclusion {
    public static let requiredTitle = "Rushes Drawing"
    public struct State: Codable, Equatable, Sendable {
        public let enabled: Bool
        public let windowID: String?
    }
    private var included: String?
    public init() {}

    public func show(windowID: String, windows: [WindowSource], shellBundleID: String?, mode: String) throws -> State {
        _ = try Self.validate(windowID: windowID, windows: windows, shellBundleID: shellBundleID, mode: mode)
        included = windowID
        return state()
    }
    public func hide() -> State { included = nil; return state() }
    public func state() -> State { State(enabled: included != nil, windowID: included) }

    public static func validate(windowID: String, windows: [WindowSource], shellBundleID: String?, mode: String) throws -> UInt32 {
        guard ["display", "area"].contains(mode) else {
            throw ControlFailure(code: "drawing-mode-not-supported", message: "drawing requires display or area capture")
        }
        guard let shellBundleID, !shellBundleID.isEmpty else {
            throw ControlFailure(code: "drawing-identity-unavailable", message: "drawing requires the configured shell identity")
        }
        guard windowID.hasPrefix("window-"), let number = UInt32(windowID.dropFirst(7)), number > 0,
              windowID == SourceIds.window(Int(number)) else {
            throw ControlFailure(code: "invalid-params", message: "drawing window needs a canonical window-N identifier")
        }
        guard let window = windows.first(where: { $0.id == windowID }) else {
            throw ControlFailure(code: "drawing-window-not-found", message: "drawing window is not available")
        }
        guard window.owningApplication == shellBundleID else {
            throw ControlFailure(code: "drawing-window-ownership", message: "drawing window is not owned by this shell")
        }
        guard window.title == requiredTitle else {
            throw ControlFailure(code: "drawing-window-title", message: "only the dedicated Rushes Drawing window may be included")
        }
        return number
    }
}
