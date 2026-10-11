import Darwin
import Foundation

/// The engine remains the CLI's command table. Cloud credentials stay in the
/// desktop app's encrypted store; cloud requests cross a user-owned local socket.
public struct ShellServiceBridge: Sendable {
    public static var defaultSocketPath: URL {
        ControlServer.defaultSocketPath.deletingLastPathComponent()
            .appendingPathComponent("shell.sock")
    }

    public let socketPath: URL

    public init(socketPath: URL = Self.defaultSocketPath) {
        self.socketPath = socketPath
    }

    public func forward(_ request: ControlRequest, timeout: TimeInterval = 900) async throws -> ControlResponse {
        guard ["share", "share.setup", "share.status", "unshare"].contains(request.cmd) else {
            throw ControlFailure(code: ControlErrorCode.unknownCommand,
                                 message: "command is not a desktop cloud operation")
        }
        guard timeout.isFinite, timeout > 0, timeout <= 3600 else {
            throw ControlFailure(code: ControlErrorCode.invalidParams,
                                 message: "cloud timeout must be between 0 and 3600 seconds")
        }
        let path = socketPath
        return try await Task.detached(priority: .utility) {
            var info = stat()
            guard lstat(path.path, &info) == 0 else {
                throw ControlFailure(code: "shell-required",
                                     message: "Open Rushes and configure cloud sharing in Settings.")
            }
            guard (info.st_mode & S_IFMT) == S_IFSOCK,
                  info.st_uid == geteuid(), (info.st_mode & 0o077) == 0 else {
                throw ControlFailure(code: "shell-socket-unsafe",
                                     message: "The desktop service socket must be owned by your user and private.")
            }
            let connection: ControlConnection
            do {
                connection = try ControlClient.connect(to: path)
            } catch {
                throw ControlFailure(code: "shell-required",
                                     message: "The desktop sharing service is unavailable. Open Rushes and try again.")
            }
            defer { connection.close() }
            return try connection.roundTrip(request, timeout: timeout).response
        }.value
    }
}
