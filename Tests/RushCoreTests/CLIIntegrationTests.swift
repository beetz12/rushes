import Foundation
import Darwin
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

    @Test("A disconnected generated engine never repeats a capture request")
    func disconnectedFixtureDoesNotRepeatStart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("rushes-disconnect-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("owned-engine.py")
        let program = #"""
#!/usr/bin/env python3
import json, os, socket, sys
args = sys.argv[1:]
endpoint = args[args.index('--socket-path') + 1]
root = args[args.index('--recordings-root') + 1]
os.makedirs(os.path.dirname(endpoint), exist_ok=True)
os.makedirs(root, exist_ok=True)
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(endpoint)
server.listen(8)
print('{"event":"ready"}', flush=True)
while True:
    client, _ = server.accept()
    try:
        raw = client.makefile('rb').readline()
        if not raw:
            continue
        request = json.loads(raw)
        if request['cmd'] == 'record.start':
            with open(os.path.join(root, 'capture-attempts.log'), 'a') as journal:
                journal.write('capture-request\n')
            print('generated live-engine disconnect', file=sys.stderr, flush=True)
        else:
            reply = {'id': request['id'], 'ok': True, 'result': {}}
            client.sendall(json.dumps(reply).encode() + b'\n')
    finally:
        client.close()
"""#
        try Data(program.utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let fixture = EngineHarness(engineURL: executable, cliURL: try Self.product("rushes"))
        defer { fixture.shutdownFixture() }
        let response = try fixture.runCLI(["record", "start", "--display", "main"], timeout: 5)
        #expect(response.status == 4)
        let attempts = try String(contentsOf: fixture.recordingsRoot.appendingPathComponent("capture-attempts.log"), encoding: .utf8)
        #expect(attempts.split(separator: "\n").count == 1, "A failed capture response must not reissue capture.")
    }

    @Test("Consecutive duration stops keep the same engine alive without retries")
    func consecutiveStopsKeepEngineAlive() throws {
        let initial = try Self.runCLI(["status"])
        try #require(initial.status == 0, "stderr: \(initial.stderr)")
        let pid = try #require(try Self.stdoutJSON(initial.stdout)["pid"] as? Int)
        for _ in 0..<3 {
            let capture = try Self.runCLI([
                "record", "start", "--display", "main", "--mic", "default",
                "--duration", "0.4", "--wait",
            ])
            try #require(capture.status == 0, "stderr: \(capture.stderr)")
            let events = try capture.stdout.split(separator: "\n").map { try Self.stdoutJSON(String($0)) }
            let id = try #require(events.first { $0["event"] as? String == "recording-started" }?["id"] as? String)
            let verify = try Self.runCLI(["verify", id])
            try #require(verify.status == 0, "stderr: \(verify.stderr)")
            #expect(try Self.stdoutJSON(verify.stdout)["ok"] as? Bool == true)
            let status = try Self.runCLI(["status"])
            try #require(status.status == 0, "stderr: \(status.stderr)")
            #expect(try Self.stdoutJSON(status.stdout)["pid"] as? Int == pid)
        }
    }

    @Test("Owned child diagnostics distinguish a normal exit from a live process and bound both streams")
    func ownedChildFailureEvidence() throws {
        let exited = Process(), captured = CLIEngineOutputLedger(bootID: 81)
        exited.executableURL = URL(fileURLWithPath: "/bin/sh")
        exited.arguments = ["-c", "printf '%20000s' x; printf 'generated-child-exit\\n' >&2; exit 23"]
        let handles = captured.install(on: exited)
        defer { handles.stdout.readabilityHandler = nil; handles.stderr.readabilityHandler = nil }
        try exited.run(); exited.waitUntilExit()
        let stopped = captured.snapshot(process: exited)
        #expect(stopped.pid == exited.processIdentifier)
        #expect(!stopped.running && stopped.exitStatus == 23)
        #expect(stopped.terminationReason == Process.TerminationReason.exit.rawValue)
        #expect(stopped.stdoutBytes == 20000 && stopped.stdoutTail.utf8.count == 8192)
        #expect(stopped.stdoutTail.hasSuffix("x"))
        #expect(stopped.stderrHead == "generated-child-exit\n" && stopped.stderrTail == stopped.stderrHead)
        #expect(stopped.outputComplete)

        let live = Process(), watching = CLIEngineOutputLedger(bootID: 82)
        live.executableURL = URL(fileURLWithPath: "/bin/sleep"); live.arguments = ["5"]
        let liveHandles = watching.install(on: live)
        try live.run()
        defer {
            if live.isRunning { watching.terminateIfRunning(live); live.waitUntilExit() }
            liveHandles.stdout.readabilityHandler = nil; liveHandles.stderr.readabilityHandler = nil
        }
        let connected = watching.snapshot(process: live)
        #expect(connected.running && connected.exitStatus == nil && connected.terminationReason == nil)
        #expect(!connected.outputComplete)
        watching.markRetirement(); live.terminate(); live.waitUntilExit()
        let signaled = watching.snapshot(process: live)
        #expect(!signaled.running && signaled.terminationReason == Process.TerminationReason.uncaughtSignal.rawValue)
        #expect(signaled.exitStatus == SIGTERM && signaled.requestedRetirement && signaled.outputComplete)
    }

    @Test("Retirement joins a delayed owned reader before detaching its EOF observation")
    func retirementDrainsDelayedReader() throws {
        let child = Process(), capture = CLIEngineOutputLedger(bootID: 83)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", "printf 'generated-held-final-output'; exit 23"]
        let handles = capture.install(on: child, beforeStdoutAppend: { entered.signal(); release.wait() })
        defer { release.signal(); handles.stdout.readabilityHandler = nil; handles.stderr.readabilityHandler = nil }
        try child.run()
        try #require(entered.wait(timeout: .now() + 2) == .success)
        child.waitUntilExit()
        let evidence = capture.retireReaders(process: child, stdout: handles.stdout, stderr: handles.stderr,
                                             beforeOutputWait: { release.signal() })
        #expect(evidence.outputComplete)
        #expect(evidence.stdoutTail == "generated-held-final-output")
        #expect(evidence.exitStatus == 23 && !evidence.requestedRetirement)
    }

    @Test("An incomplete retirement keeps observing owned bytes until the actual EOF")
    func incompleteRetirementRetainsLateEOF() throws {
        let child = Process(), capture = CLIEngineOutputLedger(bootID: 86)
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", "printf 'generated-late-eof'; exit 23"]
        let handles = capture.install(on: child, beforeStdoutAppend: { entered.signal(); release.wait() })
        defer { release.signal(); handles.stdout.readabilityHandler = nil; handles.stderr.readabilityHandler = nil }
        try child.run()
        try #require(entered.wait(timeout: .now() + 2) == .success)
        child.waitUntilExit()
        let incomplete = capture.retireReaders(process: child, stdout: handles.stdout, stderr: handles.stderr)
        #expect(!incomplete.outputComplete)
        release.signal()
        var final = capture.snapshot(process: child, waitForOutput: false)
        for _ in 0..<200 {
            if final.outputComplete { break }
            Thread.sleep(forTimeInterval: 0.005)
            final = capture.snapshot(process: child, waitForOutput: false)
        }
        #expect(final.outputComplete)
        #expect(final.stdoutTail == "generated-late-eof")
        #expect(final.exitStatus == 23 && !final.requestedRetirement)
    }

    @Test("Pipe diagnostics distinguish a live owned writer from actual EOF without reading bytes")
    func pipeDiagnosticsObserveOwnedEOF() throws {
        let child = Process(), pipe = Pipe()
        child.executableURL = URL(fileURLWithPath: "/bin/sleep"); child.arguments = ["5"]
        child.standardOutput = pipe; child.standardError = FileHandle.nullDevice
        let descriptor = pipe.fileHandleForReading.fileDescriptor
        let before = CLIOutputCapture.kernelState(descriptor)
        try child.run()
        defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
        let live = CLIOutputCapture.kernelState(descriptor)
        let liveEvents = try #require(Int16(live["pollEvents"] ?? ""))
        #expect(liveEvents & Int16(POLLHUP) == 0)
        child.terminate(); child.waitUntilExit()
        let ended = CLIOutputCapture.kernelState(descriptor)
        let endedEvents = try #require(Int16(ended["pollEvents"] ?? ""))
        #expect(endedEvents & Int16(POLLHUP) != 0)
        #expect(ended["device"] == before["device"] && ended["inode"] == before["inode"])
        #expect(ended["fstatResult"] == "0")
    }

    @Test("Every owned terminal exit is published even without a failed CLI request")
    func terminalExitWithoutRequestFailure() throws {
        let child = Process(), received = CLIOutputCapture()
        let published = DispatchSemaphore(value: 0)
        let capture = CLIEngineOutputLedger(bootID: 85, onTerminal: { evidence in
            received.stdout = (try? JSONEncoder().encode(evidence)) ?? Data()
            published.signal()
        })
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", "exit 23"]
        let handles = capture.install(on: child)
        defer { handles.stdout.readabilityHandler = nil; handles.stderr.readabilityHandler = nil }
        try child.run(); capture.markLaunchCompleted(); child.waitUntilExit()
        try #require(published.wait(timeout: .now() + 2) == .success,
                     "An exit between CLI requests must survive before a replacement boot.")
        let evidence = try JSONDecoder().decode(CLIEngineEvidence.self, from: received.stdout)
        #expect(evidence.bootID == 85 && evidence.pid == child.processIdentifier)
        #expect(evidence.exitStatus == 23 && evidence.terminationReason == Process.TerminationReason.exit.rawValue)
        #expect(!evidence.requestedRetirement && !evidence.running)
    }

    @Test("A naturally exited owned child is not attributed to a later retirement signal")
    func naturalExitKeepsOriginalCause() throws {
        let child = Process(), capture = CLIEngineOutputLedger(bootID: 84)
        child.executableURL = URL(fileURLWithPath: "/bin/sh"); child.arguments = ["-c", "exit 23"]
        let handles = capture.install(on: child)
        defer { handles.stdout.readabilityHandler = nil; handles.stderr.readabilityHandler = nil }
        try child.run(); child.waitUntilExit()
        capture.terminateIfRunning(child)
        let evidence = capture.snapshot(process: child)
        #expect(!evidence.requestedRetirement)
        #expect(evidence.exitStatus == 23 && evidence.terminationReason == Process.TerminationReason.exit.rawValue)
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
struct CLIEngineOwnedProcess {
    let process: Process
    let output: CLIEngineOutputLedger
}
nonisolated(unsafe) var engineHarnessProcesses: [CLIEngineOwnedProcess] = []

func engineHarnessAtExit() {
    for owned in engineHarnessProcesses { owned.output.terminateIfRunning(owned.process) }
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
    private let engineURL: URL
    private let indexPath: URL
    private var process: Process?
    /// True only after `Process.run()` succeeded. `waitUntilExit` on a
    /// process that never launched throws.
    private var engineDidLaunch = false
    private var output = CLIEngineOutputLedger(bootID: 0)
    private var bootID = 0
    private var stdoutHandle: FileHandle?
    private var stderrHandle: FileHandle?

    init(engineURL: URL, cliURL: URL) {
        self.engineURL = engineURL
        self.cliURL = cliURL
        let scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("cli-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try? FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
        // Keep the socket path under the sockaddr_un limit.
        let tag = UUID().uuidString.prefix(8)
        self.socketPath = URL(fileURLWithPath: "/tmp/rctl-cli-\(tag)/control.sock")
        self.recordingsRoot = scratch.appendingPathComponent("root", isDirectory: true)
        self.indexPath = scratch.appendingPathComponent("index.sqlite")
        Self.installCleanupOnce()
        startVerifiedEngine()
    }

    /// The stub engine can exit after a take on the hosted runner. Later CLI
    /// calls use the same recordings root and index, so boot another one
    /// instead of failing the suite.
    private func ensureRunning() {
        if process?.isRunning == true { return }
        logEngineReplacement("process had exited")
        startVerifiedEngine()
    }

    /// The previous take's engine can still accept on this path after
    /// `isRunning` flips, and `server.stop()` unlinks whatever file is at
    /// the path when shutdown finishes. Booting before that socket goes
    /// quiet makes the retry connect to the dying server (`connection-closed`)
    /// or watch the replacement exit because the path is still taken.
    private func startVerifiedEngine() {
        retireCurrentEngine()
        var lastOutput = ""
        for attempt in 1...3 {
            if attempt > 1 {
                let detail = lastOutput.replacingOccurrences(of: "\n", with: " ")
                logEngineReplacement(
                    "replacement was not accepting connections \(detail.suffix(240))")
                retireCurrentEngine()
            }
            switch launchEngine() {
            case .ready:
                return
            case .died(let output):
                lastOutput = output
            case .timedOut(let output):
                fatalError("engine never reported ready: \(output)")
            }
        }
        fatalError("engine never reported ready: \(lastOutput)")
    }

    /// SIGTERM, then `waitUntilExit`, so the pid cannot be reused and
    /// shutdown's socket unlink cannot land after the replacement binds.
    /// If the process is still alive at the deadline, it stays installed
    /// so the next attempt can signal it again.
    private func retireCurrentEngine() {
        let running = process
        let didLaunch = engineDidLaunch
        process = nil
        engineDidLaunch = false
        if let running, didLaunch {
            output.terminateIfRunning(running)
            if !reap(running) {
                process = running
                engineDidLaunch = true
                logEngineReplacement("engine did not exit before replacement")
                return
            }
        }
        if let running, let stdoutHandle, let stderrHandle {
            _ = output.retireReaders(process: running, stdout: stdoutHandle, stderr: stderrHandle)
        } else {
            stdoutHandle?.readabilityHandler = nil; stderrHandle?.readabilityHandler = nil
        }
        stdoutHandle = nil
        stderrHandle = nil
        let quiet = CLIEngineHandover.waitUntilQuiet(
            timeout: 2,
            isLive: { CLIEngineHandover.socketIsLive(self.socketPath) })
        if quiet {
            try? FileManager.default.removeItem(at: socketPath)
        } else {
            logEngineReplacement("socket still accepting after engine exit")
        }
    }

    /// One in-flight `waitUntilExit` per pid. A second retire must not call
    /// `waitUntilExit` again while the first waiter is still blocked.
    private var reapers: [Int32: DispatchGroup] = [:]

    /// True once the process has been waited on. A false return means it
    /// may still be alive; the caller keeps the `Process` so the next
    /// attempt can signal it again.
    private func reap(_ running: Process) -> Bool {
        let pid = running.processIdentifier
        let finished: DispatchGroup
        if let existing = reapers[pid] {
            finished = existing
        } else {
            let box = ReapBox(running)
            let group = DispatchGroup()
            group.enter()
            reapers[pid] = group
            DispatchQueue.global(qos: .userInitiated).async {
                box.process.waitUntilExit()
                group.leave()
            }
            finished = group
        }
        if finished.wait(timeout: .now() + 3) == .success {
            reapers[pid] = nil
            return true
        }
        if pid > 0, running.isRunning { output.markRetirement(); kill(pid, SIGKILL) }
        let done = finished.wait(timeout: .now() + 2) == .success
        if done { reapers[pid] = nil }
        return done
    }

    private func logEngineReplacement(_ reason: String) {
        let line = "CLI harness replaced the stub engine at \(socketPath.path) (\(reason))\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    private enum EngineLaunch {
        case ready
        case died(String)
        case timedOut(String)
    }

    /// Starts one engine and returns only after it has printed ready and
    /// answered `ping` while still running. A ready line alone is not
    /// enough: the previous listener can still be the process that accepts.
    private func launchEngine() -> EngineLaunch {
        stdoutHandle?.readabilityHandler = nil
        stderrHandle?.readabilityHandler = nil
        bootID += 1
        let capture = CLIEngineOutputLedger(bootID: bootID)
        output = capture

        if CLIEngineHandover.socketIsLive(socketPath) {
            return .died("previous engine still accepting at \(socketPath.path)")
        }

        let process = Process()
        process.executableURL = engineURL
        process.arguments = [
            "--socket-path", socketPath.path,
            "--recordings-root", recordingsRoot.path,
            "--index-path", indexPath.path,
            "--capture-stub",
        ]
        let handles = capture.install(on: process)
        stdoutHandle = handles.stdout
        stderrHandle = handles.stderr
        do {
            try process.run()
            capture.markLaunchCompleted()
        } catch {
            fatalError("could not spawn the engine: \(error)")
        }
        engineHarnessProcesses.append(CLIEngineOwnedProcess(process: process, output: capture))
        self.process = process
        self.engineDidLaunch = true
        // Wait for the ready line (up to 120 s; a cold start on a loaded CI
        // VM can take much longer than a warm local run). Ping is bounded
        // separately so a ready line from a socket that then hangs up does
        // not count.
        let deadline = Date().addingTimeInterval(120)
        var readyAt: Date?
        while Date() < deadline {
            if !process.isRunning { return .died(readyOutput()) }
            if readyOutput().contains("\"event\":\"ready\"") {
                if readyAt == nil { readyAt = Date() }
                if pingOnce() { return .ready }
                if let readyAt, Date().timeIntervalSince(readyAt) > 2 {
                    return .died(readyOutput())
                }
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning { return .timedOut(readyOutput()) }
        return .died(readyOutput())
    }

    /// One control round trip. False when the socket hangs up, refuses the
    /// connect, or the process dies before the response — the same
    /// `connection-closed` the CLI would report.
    private func pingOnce() -> Bool {
        guard process?.isRunning == true else { return false }
        let connection: ControlConnection
        do {
            connection = try ControlClient.connect(to: socketPath)
        } catch {
            return false
        }
        defer { connection.close() }
        guard process?.isRunning == true else { return false }
        do {
            let (response, _) = try connection.roundTrip(
                ControlRequest(id: "harness-ping", cmd: "ping"),
                timeout: 2)
            return response.ok && process?.isRunning == true
        } catch {
            return false
        }
    }

    private func readyOutput() -> String {
        output.text()
    }

    deinit {
        if let process { output.terminateIfRunning(process) }
    }

    func shutdownFixture() { retireCurrentEngine() }

    func runCLI(
        _ arguments: [String], timeout: TimeInterval
    ) throws -> (status: Int32, stdout: String, stderr: String) {
        ensureRunning()
        let result: (status: Int32, stdout: String, stderr: String)
        do { result = try runCLIOnce(arguments, timeout: timeout) }
        catch {
            if CLIEngineHandover.targetsEngine(arguments, engineSocket: socketPath.path) {
                output.reportFirstFailure(process: process, arguments: arguments, cliStatus: nil,
                    cliError: String(describing: error), cliOutput: "")
            }
            throw error
        }
        if result.status == 4,
           CLIEngineHandover.targetsEngine(arguments, engineSocket: socketPath.path) {
            output.reportFirstFailure(process: process, arguments: arguments, cliStatus: result.status,
                cliError: result.stderr, cliOutput: result.stdout)
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
        let writerFDs = [out.fileHandleForWriting.fileDescriptor, err.fileHandleForWriting.fileDescriptor]
        let writersBeforeLaunch = writerFDs.map(CLIOutputCapture.kernelState)
        try process.run()
        let collection = DispatchGroup()
        let captured = CLIOutputCapture()
        collection.enter()
        DispatchQueue.global(qos: .utility).async {
            captured.markReaderEntered("stdout")
            captured.stdout = out.fileHandleForReading.readDataToEndOfFile()
            collection.leave()
        }
        collection.enter()
        DispatchQueue.global(qos: .utility).async {
            captured.markReaderEntered("stderr")
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
            let evidence: [String: Any] = [
                "pid": process.processIdentifier, "running": process.isRunning,
                "exitStatus": process.terminationStatus, "terminationReason": process.terminationReason.rawValue,
                "readers": captured.readerStages(), "writersBeforeLaunch": writersBeforeLaunch,
                "writersAtFailure": writerFDs.map(CLIOutputCapture.kernelState),
                "stdoutReadFD": CLIOutputCapture.kernelState(out.fileHandleForReading.fileDescriptor),
                "stderrReadFD": CLIOutputCapture.kernelState(err.fileHandleForReading.fileDescriptor)
            ]
            if let data = try? JSONSerialization.data(withJSONObject: evidence, options: [.sortedKeys]) {
                FileHandle.standardError.write(Data("CLI_PIPE_WAIT_FAILURE ".utf8) + data + Data([10]))
            }
            throw CLIHarnessError.engineDidNotStart("CLI output did not reach EOF")
        }
        let stdout = String(data: captured.stdout, encoding: .utf8) ?? ""
        let stderr = String(data: captured.stderr, encoding: .utf8) ?? ""
        return (process.terminationStatus, stdout, stderr)
    }
}

// Captures one owned boot. Old callbacks retain their own ledger after replacement.
struct CLIEngineEvidence: Codable, Sendable {
    var bootID: Int
    var pid: Int32?
    var running: Bool
    var exitStatus: Int32?
    var terminationReason: Int?
    var requestedRetirement: Bool
    var stdoutBytes: Int
    var stderrBytes: Int
    var stdoutTail: String
    var stderrTail: String
    var stderrHead: String
    var outputComplete: Bool
    var executablePath: String?
    var launchAfterUnixMs: Double?
    var launchBeforeUnixMs: Double?
    var observedExitUnixMs: Double?
}

final class CLIEngineOutputLedger: @unchecked Sendable {
    private let changed = NSCondition()
    private let bootID: Int
    private let onTerminal: (@Sendable (CLIEngineEvidence) -> Void)?
    private var stdout = Data(), stderr = Data(), stderrHead = Data()
    private var stdoutBytes = 0, stderrBytes = 0
    private var stdoutEnded = false, stderrEnded = false
    private var executablePath: String?
    private var launchAfterUnixMs: Double?, launchBeforeUnixMs: Double?, observedExitUnixMs: Double?
    private var failureReported = false, requestedRetirement = false
    private var exitStatus: Int32?, terminationReason: Int?, exitedPID: Int32?
    init(bootID: Int, onTerminal: (@Sendable (CLIEngineEvidence) -> Void)? = nil) {
        self.bootID = bootID; self.onTerminal = onTerminal
    }

    func install(on process: Process, beforeStdoutAppend: @escaping @Sendable () -> Void = {}) -> (stdout: FileHandle, stderr: FileHandle) {
        changed.lock()
        executablePath = process.executableURL?.resolvingSymlinksInPath().path
        launchAfterUnixMs = Date().timeIntervalSince1970 * 1000
        changed.unlock()
        let out = Pipe(), err = Pipe()
        process.standardOutput = out; process.standardError = err
        out.fileHandleForReading.readabilityHandler = { [self] handle in
            let data = handle.availableData
            if !data.isEmpty { beforeStdoutAppend() }
            append(data, standardOutput: true)
            if data.isEmpty { handle.readabilityHandler = nil }
        }
        err.fileHandleForReading.readabilityHandler = { [self] handle in
            let data = handle.availableData
            append(data, standardOutput: false)
            if data.isEmpty { handle.readabilityHandler = nil }
        }
        process.terminationHandler = { [self] child in
            changed.lock()
            observedExitUnixMs = Date().timeIntervalSince1970 * 1000
            exitStatus = child.terminationStatus; terminationReason = child.terminationReason.rawValue
            exitedPID = child.processIdentifier
            changed.broadcast(); changed.unlock()
            // A process may die between successful CLI calls. Preserve every
            // owned terminal fact before replacement, without blocking this
            // callback on pipe readers. Completeness remains explicit.
            let evidence = snapshot(process: child, waitForOutput: false)
            if let onTerminal { onTerminal(evidence) } else { Self.emit("CLI_ENGINE_EXIT", evidence) }
        }
        return (out.fileHandleForReading, err.fileHandleForReading)
    }
    func markLaunchCompleted() {
        changed.lock(); launchBeforeUnixMs = Date().timeIntervalSince1970 * 1000; changed.unlock()
    }
    private func append(_ data: Data, standardOutput: Bool) {
        changed.lock(); defer { changed.unlock() }
        if standardOutput {
            if data.isEmpty { stdoutEnded = true }
            stdoutBytes += data.count; stdout = Data((stdout + data).suffix(8192))
        } else {
            if data.isEmpty { stderrEnded = true }
            stderrHead.append(data.prefix(max(0, 8192 - stderrHead.count)))
            stderrBytes += data.count; stderr = Data((stderr + data).suffix(8192))
        }
        changed.broadcast()
    }
    func terminateIfRunning(_ process: Process) {
        if process.isRunning { markRetirement(); process.terminate() }
    }
    func retireReaders(process: Process, stdout: FileHandle, stderr: FileHandle,
                       beforeOutputWait: @Sendable () -> Void = {}) -> CLIEngineEvidence {
        let evidence = snapshot(process: process, beforeOutputWait: beforeOutputWait)
        if !evidence.outputComplete { Self.emit("CLI_ENGINE_OUTPUT_INCOMPLETE", evidence) }
        // A deadline is not EOF. Late callbacks retain this boot's ledger and
        // detach their own observations only after consuming the actual EOF.
        if evidence.outputComplete {
            stdout.readabilityHandler = nil; stderr.readabilityHandler = nil
        }
        return evidence
    }
    func markRetirement() { changed.lock(); requestedRetirement = true; changed.unlock() }
    func text() -> String {
        changed.lock(); defer { changed.unlock() }
        return String(decoding: stdout + stderr, as: UTF8.self)
    }
    func snapshot(process: Process?, waitForOutput: Bool = true,
                  beforeOutputWait: @Sendable () -> Void = {}) -> CLIEngineEvidence {
        let running = process?.isRunning ?? false
        changed.lock(); defer { changed.unlock() }
        if !running && waitForOutput {
            let deadline = Date().addingTimeInterval(0.5)
            // This fixture rendezvous only signals a held callback; no scheduler
            // delay is assumed and the original drain deadline stays unchanged.
            if !(stdoutEnded && stderrEnded) { beforeOutputWait() }
            while !(stdoutEnded && stderrEnded), changed.wait(until: deadline) {}
        }
        let observedExit = exitStatus ?? (running ? nil : process?.terminationStatus)
        return CLIEngineEvidence(bootID: bootID, pid: exitedPID ?? process?.processIdentifier,
            running: observedExit == nil && running, exitStatus: observedExit,
            terminationReason: terminationReason ?? (running ? nil : process?.terminationReason.rawValue),
            requestedRetirement: requestedRetirement, stdoutBytes: stdoutBytes, stderrBytes: stderrBytes,
            stdoutTail: String(decoding: stdout, as: UTF8.self), stderrTail: String(decoding: stderr, as: UTF8.self),
            stderrHead: String(decoding: stderrHead, as: UTF8.self), outputComplete: stdoutEnded && stderrEnded,
            executablePath: executablePath, launchAfterUnixMs: launchAfterUnixMs, launchBeforeUnixMs: launchBeforeUnixMs,
            observedExitUnixMs: observedExitUnixMs ?? (running ? nil : Date().timeIntervalSince1970 * 1000))
    }
    func reportFirstFailure(process: Process?, arguments: [String], cliStatus: Int32?, cliError: String, cliOutput: String) {
        changed.lock(); let first = !failureReported; failureReported = true; changed.unlock()
        guard first else { return }
        let evidence = snapshot(process: process)
        Self.emit("CLI_ENGINE_FIRST_FAILURE", evidence)
        let request = ["arguments": arguments.joined(separator: " "), "status": cliStatus.map { String($0) } ?? "unavailable",
                       "error": String(cliError.suffix(8192)), "stdoutBytes": String(cliOutput.utf8.count),
                       "stdoutHead": String(decoding: Data(cliOutput.utf8).prefix(8192), as: UTF8.self),
                       "stdoutTail": String(decoding: Data(cliOutput.utf8).suffix(8192), as: UTF8.self)]
        if let encoded = try? JSONSerialization.data(withJSONObject: request, options: [.sortedKeys]) {
            FileHandle.standardError.write(Data("CLI_FIRST_REQUEST ".utf8) + encoded + Data([10]))
        }
    }
    private static func emit(_ label: String, _ evidence: CLIEngineEvidence) {
        if let encoded = try? JSONEncoder().encode(evidence) {
            FileHandle.standardError.write(Data((label + " ").utf8) + encoded + Data([10]))
        }
    }
}

// MARK: - Socket handover

/// Decides when a stub engine may be replaced. The listen path is shared
/// across the suite; a new process must not bind it while the previous
/// one can still accept, and an exit 4 aimed at a different `--socket`
/// must not be treated as this engine dying.
enum CLIEngineHandover {

    /// The last `--socket PATH` wins, matching `parseCLI`. No override
    /// means the harness socket.
    static func targetsEngine(_ arguments: [String], engineSocket: String) -> Bool {
        var selected = engineSocket
        var index = 0
        while index < arguments.count {
            if arguments[index] == "--socket" {
                guard index + 1 < arguments.count else { return false }
                selected = arguments[index + 1]
                index += 2
                continue
            }
            index += 1
        }
        return selected == engineSocket
    }

    static func socketIsLive(_ socketPath: URL) -> Bool {
        guard let connection = try? ControlClient.connect(to: socketPath) else { return false }
        connection.close()
        return true
    }

    /// True only once `isLive` has returned false. A socket that keeps
    /// accepting through `timeout` is not quiet.
    static func waitUntilQuiet(
        timeout: TimeInterval,
        poll: TimeInterval = 0.05,
        isLive: () -> Bool
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while isLive() {
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: poll)
        }
        return true
    }
}

private struct HandoverEcho: ControlHandling {
    func handle(_ request: ControlRequest, context: ControlCommandContext) async {
        context.reply(.success(id: request.id, result: .object(["pong": .bool(true)])))
    }
}

@Suite("CLI engine handover")
struct CLIEngineHandoverTests {

    @Test("Replacement waits until the previous socket stops accepting")
    func waitsUntilPreviousSocketIsQuiet() throws {
        let socket = URL(
            fileURLWithPath: "/tmp/rctl-handover-\(UUID().uuidString.prefix(8))/control.sock")
        let directory = socket.deletingLastPathComponent()
        defer { try? FileManager.default.removeItem(at: directory) }
        let server = ControlServer(socketPath: socket, handler: HandoverEcho())
        try server.start()
        defer { server.stop() }

        let stillLive = CLIEngineHandover.waitUntilQuiet(
            timeout: 0.2,
            isLive: { CLIEngineHandover.socketIsLive(socket) })
        #expect(!stillLive)
        #expect(CLIEngineHandover.socketIsLive(socket))

        server.stop()
        let quiet = CLIEngineHandover.waitUntilQuiet(
            timeout: 2,
            isLive: { CLIEngineHandover.socketIsLive(socket) })
        #expect(quiet)
        #expect(!CLIEngineHandover.socketIsLive(socket))

        let replacement = ControlServer(socketPath: socket, handler: HandoverEcho())
        try replacement.start()
        defer { replacement.stop() }
        let connection = try ControlClient.connect(to: socket)
        defer { connection.close() }
        let (response, _) = try connection.roundTrip(
            ControlRequest(id: "handover", cmd: "ping"), timeout: 2)
        #expect(response.ok)
    }

    @Test("An explicit --socket to another path is not the harness engine")
    func foreignSocketIsNotTheHarnessEngine() {
        let engine = "/tmp/rctl-cli-test/control.sock"
        #expect(CLIEngineHandover.targetsEngine(["guide"], engineSocket: engine))
        #expect(CLIEngineHandover.targetsEngine(
            ["--socket", engine, "status"], engineSocket: engine))
        #expect(!CLIEngineHandover.targetsEngine(
            ["--socket", "/tmp/absent/control.sock", "--no-launch", "guide"],
            engineSocket: engine))
        #expect(!CLIEngineHandover.targetsEngine(
            ["--socket", engine, "--socket", "/tmp/absent/control.sock", "guide"],
            engineSocket: engine))
    }
}

/// `Process` is not sent across the wait queue as a Sendable value; the
/// box is the only reference the reaper block touches.
private final class ReapBox: @unchecked Sendable {
    let process: Process
    init(_ process: Process) { self.process = process }
}

private final class CLIOutputCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var output = Data()
    private var errorOutput = Data()
    private var stages: [String: String] = [:]
    func markReaderEntered(_ stream: String) {
        lock.withLock { stages[stream + "EnteredUnixMs"] = String(Date().timeIntervalSince1970 * 1000) }
    }
    func readerStages() -> [String: String] {
        lock.withLock {
            var result = stages
            result["stdoutBytesReturned"] = String(output.count)
            result["stderrBytesReturned"] = String(errorOutput.count)
            return result
        }
    }
    // Descriptor numbers may be reused after launch; device/inode identity is
    // retained as well. poll never consumes bytes from the owned pipe.
    static func kernelState(_ descriptor: Int32) -> [String: String] {
        var value: [String: String] = ["descriptor": String(descriptor)]
        let flags = fcntl(descriptor, F_GETFD, 0)
        value["descriptorFlags"] = String(flags)
        value["flagsErrno"] = String(flags == -1 ? errno : 0)
        var identity = stat()
        let observed = fstat(descriptor, &identity)
        value["fstatResult"] = String(observed)
        value["fstatErrno"] = String(observed == -1 ? errno : 0)
        if observed == 0 { value["device"] = String(identity.st_dev); value["inode"] = String(identity.st_ino) }
        var readiness = pollfd(fd: descriptor, events: Int16(POLLIN | POLLHUP), revents: 0)
        let polled = Darwin.poll(&readiness, 1, 0)
        value["pollResult"] = String(polled); value["pollEvents"] = String(readiness.revents)
        value["observedUnixMs"] = String(Date().timeIntervalSince1970 * 1000)
        return value
    }
    var stdout: Data {
        get { lock.withLock { output } }
        set { lock.withLock { output = newValue; stages["stdoutReturnedUnixMs"] = String(Date().timeIntervalSince1970 * 1000) } }
    }
    var stderr: Data {
        get { lock.withLock { errorOutput } }
        set { lock.withLock { errorOutput = newValue; stages["stderrReturnedUnixMs"] = String(Date().timeIntervalSince1970 * 1000) } }
    }
}
