// Generated source-only qualification helper; never an application component.
// observe: no side effects. activate: at most one guarded public API request.
// Parent owns the live child and brackets every call with PPID/birth checks.
import AppKit
import Foundation
import Darwin

@main
struct OwnedMacApplication {
    @MainActor static func main() {
        let began = Date()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var report: [String: Any] = [
            "schema": "rushes.owned-mac-application-control/1",
            "availability": "unavailable", "identityMatched": false,
            "startedAt": formatter.string(from: began),
            "isActive": NSNull(), "isHidden": NSNull(),
            "activationPolicyRaw": NSNull(), "launchDate": NSNull(),
            "activationAttempted": false, "requestAccepted": NSNull()
        ]
        func emit(_ code: Int32, _ reason: String? = nil) -> Never {
            if let reason { report["reason"] = reason }
            report["endedAt"] = formatter.string(from: Date())
            guard var data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else { exit(3) }
            data.append(0x0a); FileHandle.standardOutput.write(data); exit(code)
        }
        guard CommandLine.arguments.count == 6,
              ["observe", "activate"].contains(CommandLine.arguments[1]),
              let pid = Int32(CommandLine.arguments[2]), pid > 1,
              CommandLine.arguments[3].hasPrefix("/") else { emit(2, "invalid-owned-arguments") }
        let mode = CommandLine.arguments[1]
        let expected = URL(fileURLWithPath: CommandLine.arguments[3]).standardizedFileURL.resolvingSymlinksInPath()
        let expectedLaunchDate = CommandLine.arguments[4]
        guard let deadline = Double(CommandLine.arguments[5]), deadline.isFinite else { emit(2, "invalid-control-deadline") }
        report["deadlineUnixMs"] = deadline
        func deadlineAllowed() -> Bool {
            let remaining = deadline - Date().timeIntervalSince1970 * 1000
            return remaining > 0 && remaining <= 20000
        }
        func refuseDeadline() -> Never {
            report["availability"] = "unpowered"
            report["deadlineExpired"] = deadline <= Date().timeIntervalSince1970 * 1000
            emit(4, "control-deadline-expired-or-invalid")
        }
        guard deadlineAllowed() else { refuseDeadline() }
        report["mode"] = mode; report["ownedPID"] = pid; report["ownedExecutable"] = expected.path
        guard expected.path.hasSuffix("/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
              FileManager.default.isExecutableFile(atPath: expected.path) else { emit(2, "expected-cft-unavailable") }
        guard let app = NSRunningApplication(processIdentifier: pid), app.processIdentifier == pid,
              !app.isTerminated, let executable = app.executableURL else { emit(2, "owned-app-unavailable") }
        guard executable.standardizedFileURL.resolvingSymlinksInPath() == expected else {
            report["availability"] = "refused"; emit(2, "owned-executable-mismatch")
        }
        let date = app.launchDate.map { formatter.string(from: $0) }
        // LaunchServices launchDate is optional for a direct-spawn app. Parent's actual
        // live ChildProcess plus same measured PPID/POSIX birth supplies that identity.
        if expectedLaunchDate != "-", let date, expectedLaunchDate != date { emit(2, "launch-date-changed") }
        let active = app.isActive, hidden = app.isHidden, policy = app.activationPolicy
        report["identityMatched"] = true; report["availability"] = "available"
        report["isActive"] = active; report["isHidden"] = hidden
        report["activationPolicyRaw"] = policy.rawValue
        if let date { report["launchDate"] = date }
        if mode == "observe" { emit(0) }

        guard !active, policy == .regular else {
            report["availability"] = "unpowered"; emit(4, "activation-precondition-not-inactive-regular")
        }
        guard app.processIdentifier == pid, !app.isTerminated,
              app.executableURL?.standardizedFileURL.resolvingSymlinksInPath() == expected else {
            emit(2, "owned-app-changed-before-request")
        }
        guard deadlineAllowed() else { refuseDeadline() }
        report["activationAttempted"] = true
        // The local SDK supports this method. Do not use the ignored/deprecated
        // activateIgnoringOtherApps option, another app, hide/unhide, or AppleEvents.
        report["requestAccepted"] = app.activate(options: [])
        // No claim about post-activation state from this cached object. Parent uses a
        // fresh observe process exactly once; failure to read active=true is unpowered.
        emit(0)
    }
}
