import ApplicationServices
import AVFoundation
import CoreGraphics
import Foundation

/// Native permission inspection is separate from explicit requests. Reads never
/// start a stream or prompt. Screen Recording exposes only a Boolean API, so our
/// own persisted request marker distinguishes unasked from denied.
public enum SystemPermissions {
    private static let screenAskedKey = "rushes.permissions.screenAsked"

    public static func check(_ kind: PermissionKind) -> PermissionStatus {
        let state: PermissionStatus.State
        switch kind {
        case .screen:
            state = CGPreflightScreenCaptureAccess() ? .allowed
                : (UserDefaults.standard.bool(forKey: screenAskedKey) ? .denied : .notAsked)
        case .camera, .microphone:
            switch AVCaptureDevice.authorizationStatus(for: kind == .camera ? .video : .audio) {
            case .authorized: state = .allowed
            case .notDetermined: state = .notAsked
            default: state = .denied
            }
        case .accessibility:
            state = AXIsProcessTrusted() ? .allowed : .notAsked
        case .inputMonitoring:
            state = CGPreflightListenEventAccess() ? .allowed : .notAsked
        }
        return PermissionStatus(state: state, settingsURL: settingsURL(kind))
    }

    public static func request(_ kind: PermissionKind) async -> PermissionStatus {
        switch kind {
        case .screen:
            UserDefaults.standard.set(true, forKey: screenAskedKey)
            _ = CGRequestScreenCaptureAccess()
        case .camera, .microphone:
            _ = await AVCaptureDevice.requestAccess(for: kind == .camera ? .video : .audio)
        case .accessibility:
            _ = AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary)
        case .inputMonitoring:
            _ = CGRequestListenEventAccess()
        }
        return check(kind)
    }

    public static var advisor: PermissionAdvisor {
        PermissionAdvisor(check: { kind in check(kind) })
    }

    public static func settingsURL(_ kind: PermissionKind) -> String {
        let pane: String
        switch kind {
        case .screen: pane = "Privacy_ScreenCapture"
        case .camera: pane = "Privacy_Camera"
        case .microphone: pane = "Privacy_Microphone"
        case .accessibility: pane = "Privacy_Accessibility"
        case .inputMonitoring: pane = "Privacy_ListenEvent"
        }
        return "x-apple.systempreferences:com.apple.preference.security?\(pane)"
    }

    public static func wireState(_ state: PermissionStatus.State) -> String {
        switch state {
        case .allowed: return "granted"
        case .notAsked: return "not-determined"
        case .denied: return "denied"
        }
    }
}
