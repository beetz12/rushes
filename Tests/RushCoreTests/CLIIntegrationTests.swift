import Foundation
import Testing

@testable import RushCore

// MARK: - Process harness

enum CLIHarnessError: Error, CustomStringConvertible {
    case binaryMissing(String)
    case engineDidNotStart(String)

    var description: String {
        switch self {
        case .binaryMissing(let name):
            return "built product not found: \(name)"
        case .engineDidNotStart(let detail):
            return "engine did not report ready or the CLI timed out: \(detail)"
        }
    }
}

/// One spawned engine plus the real CLI binary, exercised end to end
/// through the socket: the same shape `swift test` runs headless
/// (`--capture-stub`, temp roots), and the same binaries David runs.
@Suite("ControlCLIIntegration", .serialized)
struct ControlCLIIntegrationTests {

    /// The repo root, from this file's path, then the built products.
    private static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // RushCoreTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // repo root

    private static func product(_ name: String) throws -> URL {
        let candidates = [
            repoRoot.appendingPathComponent(".build/debug/\(name)"),
            repoRoot.appendingPathComponent(".build/arm64-apple-macosx/debug/\(name)"),
        ]
        for candidate in candidates where FileManager.default.fileExists(atPath: candidate.path) {
            return candidate
        }
        throw CLIHarnessError.binaryMissing(name)
    }

    /// The shared engine for the whole suite (one boot, many CLI calls).
    private static let harness = EngineHarness(
        engineURL: try! product("rushcore-engine"),
        cliURL: try! product("rushes"))

    private static var cli: URL { harness.cliURL }
    private static var socket: URL { harness.socketPath }

    /// Runs the CLI and returns exit status, stdout and stderr.
    private static func runCLI(
        _ arguments: [String], timeout: TimeInterval = 120
    ) throws -> (status: Int32, stdout: String, stderr: String) {
        try harness.runCLI(arguments, timeout: timeout)
    }

    private static func stdoutJSON(_ text: String) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] ?? [:]
    }

    // MARK: - Tests

    @Test("guide --json exits 0, parses, and lists the command table")
    func guideJSON() throws {
        let result = try Self.runCLI(["guide", "--json"])
        #expect(result.status == 0, "stderr: \(result.stderr)")
        let object = try Self.stdoutJSON(result.stdout)
        let commands = (object["commands"] as? [[String: Any]]) ?? []
        let names = Set(commands.compactMap { $0["name"] as? String })
        for expected in [
            "ping", "version", "guide", "status", "targets",
            "record.start", "record.stop", "record.pause", "record.resume",
            "list", "show", "verify", "selftest.sync", "analyze.clap",
            "share.status", "share.policy.get", "share.policy.set", "share.feedback",
        ] {
            #expect(names.contains(expected), "guide is missing \(expected)")
        }
        let exits = Set((object["exitCodes"] as? [[String: Any]])?.compactMap { ($0["code"] as? NSNumber)?.intValue } ?? [])
        #expect(exits == [0, 1, 2, 3, 4, 5])
    }

    @Test("targets lists the main display with the same id across runs")
    func targetsHeadless() throws {
        let first = try Self.runCLI(["targets"])
        #expect(first.status == 0)
        let displays = (try Self.stdoutJSON(first.stdout)["displays"] as? [[String: Any]]) ?? []
        #expect(!displays.isEmpty, "no displays in the headless catalog")
        let main = displays.first { ($0["isMain"] as? Bool) == true } ?? displays[0]
        let mainID = try #require(main["id"] as? String)

        let second = try Self.runCLI(["targets"])
        let displays2 = (try Self.stdoutJSON(second.stdout)["displays"] as? [[String: Any]]) ?? []
        #expect(displays2.contains { $0["id"] as? String == mainID })
    }

    @Test("record start --duration 2 --wait streams events and produces a complete package")
    func recordStartWaitStop() throws {
        let result = try Self.runCLI([
            "record", "start", "--display", "main", "--mic", "default",
            "--duration", "2", "--wait",
        ], timeout: 180)
        #expect(result.status == 0, "stderr: \(result.stderr)")

        let lines = result.stdout.split(separator: "\n").map(String.init)
        #expect(lines.count >= 3, "expected events plus a done line, got: \(lines)")
        var events: [[String: Any]] = []
        for line in lines.dropLast(1) {
            events.append(try Self.stdoutJSON(line))
        }
        let done = try Self.stdoutJSON(lines.last ?? "")
        #expect(done["event"] as? String == "done")

        let started = events.first { $0["event"] as? String == "recording-started" }
        #expect(started != nil)
        let recordingID = try #require(started?["id"] as? String)
        #expect(recordingID.count == 26)

        // The package exists with a complete manifest and an input timeline.
        let recordingsRoot = Self.harness.recordingsRoot
        let package = try #require(
            RecordingPackage.resolve(root: recordingsRoot, id: recordingID))
        let manifest = try package.readManifest()
        #expect(manifest.status == .complete)
        #expect(FileManager.default.fileExists(atPath: package.inputURL.path))
        #expect(FileManager.default.fileExists(atPath: package.trackURL(for: .screen).path))
        #expect(FileManager.default.fileExists(atPath: package.trackURL(for: .microphone).path))
    }

    @Test("list shows the take; show returns the manifest; verify is green")
    func listShowVerify() throws {
        // Make one take through the CLI.
        let start = try Self.runCLI([
            "record", "start", "--display", "main", "--duration", "1",
        ], timeout: 180)
        #expect(start.status == 0, "stderr: \(start.stderr)")
        let started = try Self.stdoutJSON(start.stdout)
        let recordingID = try #require(started["id"] as? String)

        // Wait for the duration stop to land before listing.
        var listed: [[String: Any]] = []
        for _ in 0..<100 {
            let list = try Self.runCLI(["list"])
            #expect(list.status == 0)
            let rows = (try Self.stdoutJSON(list.stdout)["recordings"] as? [[String: Any]]) ?? []
            if let row = rows.first(where: { $0["id"] as? String == recordingID }),
               row["status"] as? String == "complete" {
                listed = rows
                break
            }
            Thread.sleep(forTimeInterval: 0.2)
        }
        #expect(listed.contains { $0["id"] as? String == recordingID })

        let show = try Self.runCLI(["show", recordingID])
        #expect(show.status == 0)
        let shown = try Self.stdoutJSON(show.stdout)
        #expect((shown["manifest"] as? [String: Any])?["id"] as? String == recordingID)

        let verify = try Self.runCLI(["verify", recordingID])
        #expect(verify.status == 0, "stderr: \(verify.stderr)")
        let report = try Self.stdoutJSON(verify.stdout)
        #expect(report["ok"] as? Bool == true)
    }

    @Test("record stop with nothing active exits 1 with not-recording on stderr")
    func stopWithoutRecording() throws {
        let result = try Self.runCLI(["record", "stop"])
        #expect(result.status == 1)
        let error = try JSONSerialization.jsonObject(
            with: Data(result.stderr.utf8)) as? [String: Any]
        let payload = error?["error"] as? [String: Any]
        #expect(payload?["code"] as? String == "not-recording")
    }

    @Test("show with an unknown id exits 5 with not-found")
    func showUnknown() throws {
        let result = try Self.runCLI(["show", "01JANOTREAL0000000000000000"])
        #expect(result.status == 5)
        let error = try JSONSerialization.jsonObject(
            with: Data(result.stderr.utf8)) as? [String: Any]
        #expect((error?["error"] as? [String: Any])?["code"] as? String == "not-found")
    }

    @Test("No engine on the socket exits 4 with engine-unreachable")
    func engineAbsent() throws {
        let deadSocket = URL(fileURLWithPath: "/tmp/rctl-absent-\(UUID().uuidString.prefix(8))/control.sock")
        let result = try Self.runCLI(["--socket", deadSocket.path, "--no-launch", "guide"])
        #expect(result.status == 4)
        let error = try JSONSerialization.jsonObject(
            with: Data(result.stderr.utf8)) as? [String: Any]
        let payload = error?["error"] as? [String: Any]
        #expect(payload?["code"] as? String == "engine-unreachable")
        #expect((payload?["socket"] as? String) == deadSocket.path)
    }

    @Test("CLI launches an absent engine on demand using isolated diagnostic roots")
    func launchOnDemand() throws {
        let tag = UUID().uuidString.prefix(8)
        let scratch = URL(fileURLWithPath: "/tmp/rctl-autolaunch-\(tag)", isDirectory: true)
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratch) }
        let process = Process()
        process.executableURL = try Self.product("rushes")
        process.arguments = ["--socket", scratch.appendingPathComponent("control.sock").path, "status"]
        var environment = ProcessInfo.processInfo.environment
        environment["RUSHES_RECORDINGS_ROOT"] = scratch.appendingPathComponent("root").path
        environment["RUSHES_INDEX_PATH"] = scratch.appendingPathComponent("index.sqlite").path
        environment["RUSHES_CAPTURE_STUB"] = "1"
        process.environment = environment
        let out = Pipe(); let err = Pipe()
        process.standardOutput = out; process.standardError = err
        try process.run()
        let captured = CLIOutputCapture()
        let reads = DispatchGroup()
        reads.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            captured.stdout = out.fileHandleForReading.readDataToEndOfFile()
            reads.leave()
        }
        reads.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            captured.stderr = err.fileHandleForReading.readDataToEndOfFile()
            reads.leave()
        }
        process.waitUntilExit()
        reads.wait()
        print("AUTOLAUNCH_PIPE_BYTES stdout=\(captured.stdout.count) stderr=\(captured.stderr.count)")
        #expect(process.terminationStatus == 0)
        let object = try JSONSerialization.jsonObject(with: captured.stdout) as? [String: Any]
        #expect(object?["state"] as? String == "idle")
        let pid = try #require((object?["pid"] as? NSNumber)?.int32Value)
        kill(pid, SIGTERM)
    }

    @Test("Usage errors exit 2: no command and unknown command")
    func usageErrors() throws {
        let none = try Self.runCLI([])
        #expect(none.status == 2)
        let errorNone = try JSONSerialization.jsonObject(
            with: Data(none.stderr.utf8)) as? [String: Any]
        #expect((errorNone?["error"] as? [String: Any])?["code"] as? String == "usage")

        let unknown = try Self.runCLI(["frobnicate"])
        #expect(unknown.status == 2)
    }

    @Test("version answers offline")
    func versionOffline() throws {
        let result = try Self.runCLI(["--socket", "/tmp/definitely-not-here.sock", "version"])
        #expect(result.status == 0)
        let object = try Self.stdoutJSON(result.stdout)
        #expect(object["name"] as? String == "rushes")
    }
}

// MARK: - Engine harness

/// Engines this process spawned, terminated at exit: a Swift static is
/// never deallocated, so without this every test run leaks one engine
/// process, and stale engines slow ScreenCaptureKit's window-server
/// queries for later runs.
nonisolated(unsafe) var engineHarnessProcesses: [Process] = []

func engineHarnessAtExit() {
    for process in engineHarnessProcesses where process.isRunning {
        process.terminate()
    }
}

/// Boots the real engine binary once, waits for its NDJSON ready line, and
/// runs the real CLI against its socket.
final class EngineHarness: @unchecked Sendable {

    private static let cleanupOnce: Void = {
        atexit(engineHarnessAtExit)
    }()

    private static func installCleanupOnce() {
        _ = cleanupOnce
    }

    // Cleanup owns only processes created by this harness. Never pattern-kill
    // engines from another concurrently running worktree's test suite.

    let cliURL: URL
    let socketPath: URL
    let recordingsRoot: URL
    private let indexPath: URL
    private let process: Process
    private let outputLock = NSLock()
    private var outputText = ""

    init(engineURL: URL, cliURL: URL) {
        self.cliURL = cliURL
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("cli-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        // Keep the socket path under the sockaddr_un limit.
        let tag = UUID().uuidString.prefix(8)
        self.socketPath = URL(fileURLWithPath: "/tmp/rctl-cli-\(tag)/control.sock")
        self.recordingsRoot = scratch.appendingPathComponent("root", isDirectory: true)
        self.indexPath = scratch.appendingPathComponent("index.sqlite")
        self.process = Process()

        process.executableURL = engineURL
        process.arguments = [
            "--socket-path", socketPath.path,
            "--recordings-root", recordingsRoot.path,
            "--index-path", indexPath.path,
            "--capture-stub",
        ]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = String(data: handle.availableData, encoding: .utf8) ?? ""
            guard !chunk.isEmpty, let self else { return }
            self.outputLock.lock()
            self.outputText += chunk
            self.outputLock.unlock()
        }
        Self.installCleanupOnce()
        do {
            try process.run()
            engineHarnessProcesses.append(process)
        } catch {
            fatalError("could not spawn the engine: \(error)")
        }
        // Wait for the ready line (up to 120 s; a cold start on a loaded CI
        // VM can take much longer than a warm local run).
        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            if readyOutput().contains("\"event\":\"ready\"") { return }
            if !process.isRunning { break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        fatalError("engine never reported ready: \(readyOutput())")
    }

    private func readyOutput() -> String {
        outputLock.lock()
        defer { outputLock.unlock() }
        return outputText
    }

    deinit {
        if process.isRunning {
            process.terminate()
        }
    }

    func runCLI(
        _ arguments: [String], timeout: TimeInterval
    ) throws -> (status: Int32, stdout: String, stderr: String) {
        let result = try runCLIOnce(arguments, timeout: timeout)
        // Under the full suite's parallel load a connect can be refused
        // transiently (exit 4) while the engine is mid-catalog-query; one
        // bounded retry keeps the integration test about the CLI, not about
        // machine load.
        if result.status == 4 {
            Thread.sleep(forTimeInterval: 2)
            return try runCLIOnce(arguments, timeout: timeout)
        }
        return result
    }

    private func runCLIOnce(
        _ arguments: [String], timeout: TimeInterval
    ) throws -> (status: Int32, stdout: String, stderr: String) {
        let process = Process()
        process.executableURL = cliURL
        process.arguments = ["--no-launch", "--socket", socketPath.path] + arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        let collection = DispatchGroup()
        let captured = CLIOutputCapture()
        collection.enter()
        DispatchQueue.global(qos: .utility).async {
            captured.stdout = out.fileHandleForReading.readDataToEndOfFile()
            collection.leave()
        }
        collection.enter()
        DispatchQueue.global(qos: .utility).async {
            captured.stderr = err.fileHandleForReading.readDataToEndOfFile()
            collection.leave()
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            Thread.sleep(forTimeInterval: 1)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
            throw CLIHarnessError.engineDidNotStart("CLI timed out after \(timeout)s: \(arguments)")
        }
        guard collection.wait(timeout: .now() + 5) == .success else {
            throw CLIHarnessError.engineDidNotStart("CLI output did not reach EOF")
        }
        let stdout = String(data: captured.stdout, encoding: .utf8) ?? ""
        let stderr = String(data: captured.stderr, encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }
}

private final class CLIOutputCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var output = Data()
    private var errorOutput = Data()
    var stdout: Data {
        get { lock.withLock { output } }
        set { lock.withLock { output = newValue } }
    }
    var stderr: Data {
        get { lock.withLock { errorOutput } }
        set { lock.withLock { errorOutput = newValue } }
    }
}
