import AppKit
import Foundation
import RushCore

/// The engine executable: boots RushCore's controller, serves the control
/// socket and runs until SIGINT or SIGTERM (docs/PLAN.md, Engine target:
/// "Boots RushCore, serves control.sock, runs the job queue ... delays quit
/// while writers finish").
///
/// Phase 1 shape: the engine is a plain executable and macOS permissions
/// attach to it directly; Phase 2's shell launches it from inside
/// Rushes.app and takes over that duty.

let engineVersion = "0.1.0-dev"

// MARK: - Flags

struct EngineFlags {
    var socketPath = ControlServer.defaultSocketPath
    var recordingsRoot = RecordingPackage.defaultRoot
    var indexPath = PackageIndex.defaultDatabaseURL
    /// Diagnostic mode: synthetic capture instead of ScreenCaptureKit,
    /// camera and event tap, so headless test runs need no permissions.
    var captureStub = false
    var shellBundleID: String?
    /// Reserved for Phase 1 item 9's `selftest sync` passthrough: accepted,
    /// never refused, no behaviour yet.
    var selftestPassthrough: [String] = []
    var version = false
}

func printEngineError(_ code: String, _ message: String, status: Int32 = 2) -> Never {
    let payload: [String: String] = ["code": code, "message": message]
    let data = try! JSONSerialization.data(withJSONObject: ["error": payload])
    FileHandle.standardError.write(data)
    FileHandle.standardError.write(Data([0x0A]))
    exit(status)
}

func parseEngineFlags(_ arguments: [String]) -> EngineFlags {
    var flags = EngineFlags()
    let args = Array(arguments.dropFirst())
    var index = 0
    while index < args.count {
        let arg = args[index]
        func nextValue(_ name: String) -> String {
            guard index + 1 < args.count, !args[index + 1].hasPrefix("--") else {
                printEngineError("usage", "flag \(name) needs a value")
            }
            index += 1
            return args[index]
        }
        switch arg {
        case "--socket-path":
            flags.socketPath = URL(fileURLWithPath: nextValue(arg))
        case "--recordings-root":
            flags.recordingsRoot = URL(
                fileURLWithPath: nextValue(arg), isDirectory: true)
        case "--index-path":
            flags.indexPath = URL(fileURLWithPath: nextValue(arg))
        case "--shell-bundle-id":
            flags.shellBundleID = nextValue(arg)
        case "serve": break
        case "--capture-stub":
            flags.captureStub = true
        case "--selftest":
            index += 1
            // Reserved passthrough: the remaining tokens travel untouched.
            flags.selftestPassthrough = Array(args[index...])
            index = args.count
        case "--version":
            flags.version = true
        default:
            printEngineError("usage", "unknown flag \(arg)")
        }
        index += 1
    }
    return flags
}

let flags = parseEngineFlags(CommandLine.arguments)

if flags.version {
    print("{\"name\":\"rushcore-engine\",\"version\":\"\(engineVersion)\"}")
    exit(0)
}

// MARK: - Boot

let controller: EngineController
do {
    controller = try EngineController(config: EngineControllerConfig(
        recordingsRoot: flags.recordingsRoot,
        indexDatabaseURL: flags.indexPath,
        catalog: flags.captureStub ? DiagnosticSourceCatalog() : SystemSourceCatalog(),
        permissionAdvisor: flags.captureStub ? .allAllowed : SystemPermissions.advisor,
        permissionRequester: { kind in await SystemPermissions.request(kind) },
        shellBundleID: flags.shellBundleID,
        captureRigs: flags.captureStub
            ? StubCaptureRigFactory()
            : ProductionCaptureRigFactory(),
        version: engineVersion,
        socketPath: flags.socketPath.path))
} catch {
    printEngineError("index-open-failed", String(describing: error), status: 1)
}

let server = ControlServer(socketPath: flags.socketPath, handler: controller)
// The socket/ready handshake follows recovery and cache rebuild. Clients
// cannot observe an empty pre-rebuild library or start a take during recovery.
Task {
    await controller.prepare()
    do { try server.start() }
    catch { printEngineError("socket-failed", String(describing: error), status: 1) }
    var readyObject: [String: String] = [
        "event": ControlEventKind.ready.rawValue,
        "socket": flags.socketPath.path,
        "version": engineVersion,
    ]
    if flags.captureStub { readyObject["capture"] = "stub" }
    do {
        var data = try JSONSerialization.data(withJSONObject: readyObject, options: [.sortedKeys, .withoutEscapingSlashes])
        data.append(0x0A)
        FileHandle.standardOutput.write(data)
    } catch { printEngineError("ready-encoding-failed", String(describing: error), status: 1) }
}

// MARK: - Signals

// SIGINT/SIGTERM stop any active recording first (bounded finalize: each
// writer races a five-second deadline), then exit cleanly
// (docs/PLAN.md, Quit while recording).
//
// The handlers must be explicitly `@Sendable`: a closure written at this
// top level otherwise inherits MainActor isolation, and a dispatch handler
// the runtime cannot run off the main actor silently never fires - the
// default disposition then kills the process with the socket file behind
// it. The sources are kept in a process-lifetime global for the same
// reason (a deallocated source never fires).
nonisolated(unsafe) var retainedSignalSources: [DispatchSourceSignal] = []

func installTerminationHandling(controller: EngineController, server: ControlServer) {
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    for signum in [SIGINT, SIGTERM] {
        let source = DispatchSource.makeSignalSource(
            signal: signum, queue: DispatchQueue.global(qos: .userInitiated))
        source.setEventHandler { @Sendable in
            Task {
                await controller.shutdown()
                server.stop()
                exit(0)
            }
        }
        source.resume()
        retainedSignalSources.append(source)
    }
}

installTerminationHandling(controller: controller, server: server)

NSApplication.shared.setActivationPolicy(.prohibited)
NSApplication.shared.run()
