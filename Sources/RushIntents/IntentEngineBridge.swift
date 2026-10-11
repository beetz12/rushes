import Darwin
import Foundation
import RushCore

public struct IntentBridgeError: Error, LocalizedError, Equatable, Sendable {
    public let code: String
    public let message: String
    public init(code: String, message: String) { self.code = code; self.message = message }
    public var errorDescription: String? { message }
}

public protocol IntentCommandSending: Sendable {
    func send(_ request: ControlRequest) async throws -> JSONValue
}

public struct IntentEngineBridge: IntentCommandSending, Sendable {
    public let socketPath: URL
    public let timeout: TimeInterval
    public init(socketPath: URL = IntentEngineBridge.runtimeSocket(), timeout: TimeInterval = 20) {
        self.socketPath = socketPath; self.timeout = timeout
    }
    public static func runtimeSocket(bundle: Bundle = .main) -> URL {
        #if RUSHES_INTENT_QA
        // QA binaries fail closed: a missing/wrong bundle can never select the live engine.
        if let identifier = bundle.bundleIdentifier, (identifier.hasSuffix(".intentqa.extension") || identifier.hasSuffix(".intentqa")),
           let path = bundle.object(forInfoDictionaryKey: "RushesIntentQASocketPath") as? String,
           path.hasPrefix("/"), !path.contains("\0") { return URL(fileURLWithPath: path) }
        return URL(fileURLWithPath: "/tmp/rushes-intent-qa-no-live-engine.sock")
        #else
        return ControlServer.defaultSocketPath
        #endif
    }
    public func send(_ request: ControlRequest) async throws -> JSONValue {
        guard ["record.start", "record.stop", "status", "targets"].contains(request.cmd) else {
            throw IntentBridgeError(code: "invalid-command", message: "This Shortcuts bridge accepts recording controls and discovery only.")
        }
        let socket = socketPath, timeout = self.timeout
        return try await Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            try Self.checkPrivateSocket(socket)
            do {
                let connection = try ControlClient.connect(to: socket)
                defer { connection.close() }
                let (response, _) = try connection.roundTrip(request, timeout: timeout)
                guard response.ok else {
                    throw IntentBridgeError(code: response.error?.code ?? "engine-error", message: response.error?.message ?? "Rushes could not complete this action.")
                }
                guard let result = response.result else { throw IntentBridgeError(code: "invalid-response", message: "Rushes returned no recording result.") }
                return result
            } catch let error as IntentBridgeError { throw error }
            catch { throw IntentBridgeError(code: "engine-unreachable", message: "Open Rushes, finish permission setup, and try this shortcut again.") }
        }.value
    }
    public static func checkPrivateSocket(_ path: URL) throws {
        var socketInfo = stat(), directoryInfo = stat()
        guard lstat(path.path, &socketInfo) == 0 else {
            throw IntentBridgeError(code: "engine-unreachable", message: "Open Rushes before running recording shortcuts.")
        }
        guard lstat(path.deletingLastPathComponent().path, &directoryInfo) == 0,
              socketInfo.st_mode & S_IFMT == S_IFSOCK,
              directoryInfo.st_mode & S_IFMT == S_IFDIR,
              socketInfo.st_uid == getuid(), directoryInfo.st_uid == getuid(),
              socketInfo.st_mode & 0o777 == 0o600, directoryInfo.st_mode & 0o777 == 0o700 else {
            throw IntentBridgeError(code: "socket-permissions", message: "Rushes needs its private same-user recording socket; restart the app to repair it.")
        }
    }
}
