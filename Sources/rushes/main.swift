import Foundation
import RushCore

/// The `rushes` CLI: a thin socket client of the engine (docs/PLAN.md,
/// Control interface; CLI target: "a thin socket client"). JSON on stdout,
/// JSON errors on stderr, NDJSON events with `--wait`, and the stable
/// exit-code table from the guide:
/// 0 ok, 1 runtime error, 2 usage, 3 permission, 4 engine unreachable,
/// 5 not found.
///
/// Phase 1: the CLI never launches anything. When no engine answers on the
/// socket it prints the engine-not-running error and exits 4. The
/// `--engine-path` flag and `RUSHES_ENGINE` environment variable are the
/// reserved seam for the Phase 2 launch-on-demand; both are parsed and
/// reported in the error today so the contract is visible.

let cliVersion = "0.1.0-dev"

// MARK: - Output helpers

func printJSON(_ value: JSONValue) {
    if let data = try? ControlWire.encoder.encode(value),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

func printNDJSON(_ value: JSONValue) {
    if let data = try? ControlWire.encoder.encode(value),
       let text = String(data: data, encoding: .utf8) {
        print(text)
        fflush(stdout)
    }
}

/// Every failure path prints `{"error":{...}}` on stderr and exits with
/// the mapped stable code.
func fail(_ code: String, _ message: String, extra: [String: JSONValue] = [:]) -> Never {
    let payload = ControlErrorPayload(code: code, message: message, details: extra)
    let response = ControlResponse(
        id: nil, ok: false, result: nil, error: payload)
    if let data = try? ControlWire.line(response),
       let text = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(Data(text.utf8))
    }
    exit(ControlExitCode.exitCode(forErrorCode: code).rawValue)
}

func failFromResponse(_ response: ControlResponse) -> Never {
    let payload = response.error
        ?? ControlErrorPayload(code: ControlErrorCode.internalError, message: nil)
    let wrapper = ControlResponse(id: nil, ok: false, result: nil, error: payload)
    if let data = try? ControlWire.line(wrapper),
       let text = String(data: data, encoding: .utf8) {
        FileHandle.standardError.write(Data(text.utf8))
    }
    exit(ControlExitCode.exitCode(forErrorCode: payload.code).rawValue)
}

// MARK: - Argument parsing

struct CLIInvocation {
    var socketPath: URL
    /// Reserved Phase 2 seam (engine binary to launch when the socket is
    /// absent). Parsed, never acted on this phase.
    var enginePath: String?
    var command: String
    var positional: [String] = []
    var flags: [String: String] = [:]   // value flags
    var switches: Set<String> = []      // boolean flags
}

func parseCLI(_ arguments: [String]) -> CLIInvocation {
    let tokens = Array(arguments.dropFirst())
    // The plan's default socket (docs/PLAN.md, Process model): the engine
    // serves `~/Library/Application Support/Rushes/control.sock`, and the CLI
    // connects there unless `--socket` or `RUSHES_SOCKET` says otherwise.
    var socket = ProcessInfo.processInfo.environment["RUSHES_SOCKET"]
        ?? ControlServer.defaultSocketPath.path
    var enginePath = ProcessInfo.processInfo.environment["RUSHES_ENGINE"]
    var index = 0

    // Global flags may sit anywhere; command words do not start with "--".
    var words: [String] = []
    while index < tokens.count {
        let token = tokens[index]
        switch token {
        case "--socket":
            index += 1
            guard index < tokens.count else { fail("usage", "--socket needs a path") }
            socket = tokens[index]
            index += 1
        case "--engine-path":
            index += 1
            guard index < tokens.count else { fail("usage", "--engine-path needs a path") }
            enginePath = tokens[index]
            index += 1
        default:
            words.append(token)
            index += 1
        }
    }

    guard !words.isEmpty else {
        fail("usage", "a command is required; run `rushes guide --json` for every command")
    }
    guard !socket.isEmpty else {
        fail(
            "usage",
            "no socket path: pass --socket PATH or set RUSHES_SOCKET",
            extra: ["enginePath": enginePath.map(JSONValue.string) ?? .null])
    }
    let socketPath = socket

    let command = words[0]
    let rest = Array(words.dropFirst())
    var invocation = CLIInvocation(
        socketPath: URL(fileURLWithPath: socketPath),
        enginePath: enginePath,
        command: command)
    if command == "record", !rest.isEmpty {
        invocation.command = "record \(rest[0])"
        parseArguments(Array(rest.dropFirst()), into: &invocation)
    } else if command == "selftest", !rest.isEmpty {
        invocation.command = "selftest \(rest[0])"
        parseArguments(Array(rest.dropFirst()), into: &invocation)
    } else if command == "analyze", !rest.isEmpty {
        invocation.command = "analyze \(rest[0])"
        parseArguments(Array(rest.dropFirst()), into: &invocation)
    } else {
        parseArguments(rest, into: &invocation)
    }
    return invocation
}

/// Splits remaining words into value flags (`--flag v`), switches
/// (`--flag`), and positionals. A value flag may also be written
/// `--flag=v`.
func parseArguments(_ words: [String], into invocation: inout CLIInvocation) {
    let valueFlags: Set<String> = [
        "--display", "--window", "--camera", "--mic", "--duration",
        "--countdown", "--title", "--id", "--limit",
        "--seconds", "--pause-at",
    ]
    var index = 0
    while index < words.count {
        let word = words[index]
        if word.hasPrefix("--") {
            let (name, inlineValue) = splitFlag(word)
            if let inlineValue {
                invocation.flags[name] = inlineValue
                index += 1
                continue
            }
            if valueFlags.contains(name) {
                guard index + 1 < words.count else {
                    fail("usage", "\(name) needs a value")
                }
                invocation.flags[name] = words[index + 1]
                index += 2
            } else {
                invocation.switches.insert(name)
                index += 1
            }
        } else {
            invocation.positional.append(word)
            index += 1
        }
    }
}

func splitFlag(_ word: String) -> (String, String?) {
    guard let equals = word.firstIndex(of: "=") else { return (word, nil) }
    return (String(word[..<equals]), String(word[word.index(after: equals)...]))
}

// MARK: - Engine connection

func connectOrFail(_ invocation: CLIInvocation) -> ControlConnection {
    do {
        return try ControlClient.connect(to: invocation.socketPath)
    } catch {
        var extra: [String: JSONValue] = [
            "socket": .string(invocation.socketPath.path),
        ]
        if let enginePath = invocation.enginePath {
            extra["enginePath"] = .string(enginePath)
        }
        fail(
            ControlErrorCode.engineUnreachable,
            "engine not running at \(invocation.socketPath.path);"
                + " start it with rushcore-engine"
                + (invocation.enginePath.map { " (seam: \($0))" } ?? ""),
            extra: extra)
    }
}

nonisolated(unsafe) var requestCounter = 0
func nextRequestID() -> String {
    requestCounter += 1
    return "cli-\(requestCounter)"
}

/// Runs one request and prints its result JSON; any error fails with the
/// mapped exit code.
func runRequest(
    _ invocation: CLIInvocation,
    cmd: String,
    args: JSONValue = .object([:]),
    timeout: TimeInterval = 30
) -> ControlResponse {
    let connection = connectOrFail(invocation)
    defer { connection.close() }
    let request = ControlRequest(id: nextRequestID(), cmd: cmd, args: args)
    do {
        let (response, _) = try connection.roundTrip(request, timeout: timeout)
        guard response.ok else { failFromResponse(response) }
        return response
    } catch let error as ControlClientError {
        switch error {
        case .timedOut:
            fail(
                ControlErrorCode.timeout,
                error.description,
                extra: ["socket": .string(invocation.socketPath.path)])
        case .socketUnavailable, .connectionClosed:
            fail(
                ControlErrorCode.connectionClosed,
                error.description,
                extra: ["socket": .string(invocation.socketPath.path)])
        }
    } catch {
        fail(
            ControlErrorCode.internalError,
            String(describing: error),
            extra: ["socket": .string(invocation.socketPath.path)])
    }
}

// MARK: - record start --wait streaming

/// Streams NDJSON events to stdout while the request is open, and stops the
/// recording on SIGINT/SIGTERM (docs/PLAN.md: stopping on a signal applies
/// when `--wait` is used; closing stdin is not a stop).
final class InterruptFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false
    var isRaised: Bool {
        lock.lock()
        defer { lock.unlock() }
        return raised
    }
    func raise() {
        lock.lock()
        raised = true
        lock.unlock()
    }
}

/// The wait loop's cross-thread state: the signal flag and whether a stop
/// request has already been sent for it. Once the stop is sent the read
/// loop no longer gives up on quiet poll windows, so the stop's outcome is
/// always collected.
final class WaitState: @unchecked Sendable {
    let interrupted = InterruptFlag()
    private let lock = NSLock()
    private var _stopSent = false

    var stopSent: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _stopSent
    }

    func markStopSent() {
        lock.lock()
        _stopSent = true
        lock.unlock()
    }

    /// Keep reading while no interrupt happened, or after the interrupt's
    /// stop request is already on the wire.
    var shouldContinue: Bool {
        !interrupted.isRaised || stopSent
    }
}

/// Signal sources must outlive the wait loop; they live here.
nonisolated(unsafe) var retainedSignalSources: [DispatchSourceSignal] = []

func runRecordStartWait(
    _ invocation: CLIInvocation, args: [String: JSONValue]
) -> Never {
    signal(SIGINT, SIG_IGN)
    signal(SIGTERM, SIG_IGN)
    let state = WaitState()
    // The handler must be explicitly `@Sendable` (see the engine's note):
    // otherwise it inherits MainActor isolation at this top level and never
    // runs when the signal arrives.
    retainedSignalSources = [SIGINT, SIGTERM].map { signum in
        let source = DispatchSource.makeSignalSource(
            signal: signum, queue: DispatchQueue.global(qos: .userInitiated))
        source.setEventHandler { @Sendable in
            state.interrupted.raise()
        }
        source.resume()
        return source
    }

    let connection = connectOrFail(invocation)
    defer { connection.close() }
    let startRequest = ControlRequest(
        id: nextRequestID(), cmd: "record.start",
        args: .object(args.merging(["wait": .bool(true)]) { current, _ in current }))
    var stopRequestID = ""

    do {
        try connection.send(startRequest)
        while true {
            if let message = try connection.streamMessage(
                shouldContinue: { state.shouldContinue }
            ) {
                switch message {
                case .event(let event):
                    printNDJSON(CLIEventAdapter.outputJSON(event))
                case .response(let response):
                    if response.id == startRequest.id {
                        finishWaitResponse(response)
                    }
                    if state.stopSent, response.id == stopRequestID {
                        finishWaitResponse(response)
                    }
                    // Responses to other requests: ignore.
                }
                continue
            }
            // A quiet poll window ended after an interrupt: put the stop on
            // the wire and keep reading until the outcome arrives.
            if state.interrupted.isRaised, !state.stopSent {
                stopRequestID = nextRequestID()
                try connection.send(ControlRequest(
                    id: stopRequestID, cmd: "record.stop"))
                state.markStopSent()
            }
        }
    } catch let error as ControlClientError {
        fail(
            ControlErrorCode.connectionClosed,
            error.description,
            extra: ["socket": .string(invocation.socketPath.path)])
    } catch {
        fail(
            ControlErrorCode.internalError,
            String(describing: error),
            extra: ["socket": .string(invocation.socketPath.path)])
    }
}

/// The CLI's event shape (docs/PLAN.md, Control interface): one line per
/// event, `id` the recording id, `t` media milliseconds.
enum CLIEventAdapter {
    static func outputJSON(_ event: ControlEvent) -> JSONValue {
        var object: [String: JSONValue] = ["event": .string(event.event)]
        if let recordingId = event.recordingId {
            object["id"] = .string(recordingId)
        }
        if let state = event.state {
            object["state"] = .string(state)
        }
        if let t = event.t {
            object["t"] = .double(t)
        }
        if let code = event.code {
            object["code"] = .string(code)
        }
        if let message = event.message {
            object["message"] = .string(message)
        }
        if let result = event.result {
            object["result"] = result
        }
        return .object(object)
    }
}

func finishWaitResponse(_ response: ControlResponse) -> Never {
    if response.ok, let result = response.result {
        printNDJSON(.object(["event": .string("done"), "result": result]))
        exit(0)
    }
    failFromResponse(response)
}

// MARK: - Command table

let invocation = parseCLI(CommandLine.arguments)

// Offline commands.

if invocation.command == "version" || invocation.switches.contains("--version") {
    var object: [String: JSONValue] = [
        "name": .string("rushes"),
        "version": .string(cliVersion),
        "protocol": .string("1"),
    ]
    if let enginePath = invocation.enginePath {
        object["enginePath"] = .string(enginePath)
    }
    printJSON(.object(object))
    exit(0)
}

// Engine commands.

switch invocation.command {
case "guide":
    let response = runRequest(invocation, cmd: "guide")
    printJSON(response.result ?? .object([:]))
    exit(0)

case "ping":
    let response = runRequest(invocation, cmd: "ping")
    printJSON(response.result ?? .object([:]))
    exit(0)

case "status":
    let response = runRequest(invocation, cmd: "status")
    printJSON(response.result ?? .object([:]))
    exit(0)

case "targets":
    let response = runRequest(invocation, cmd: "targets")
    printJSON(response.result ?? .object([:]))
    exit(0)

case "list":
    var args: [String: JSONValue] = [:]
    if let limit = invocation.flags["--limit"] {
        guard let value = Int64(limit), value > 0 else {
            fail("usage", "--limit needs a positive integer")
        }
        args["limit"] = .int(value)
    }
    let response = runRequest(invocation, cmd: "list", args: .object(args))
    printJSON(response.result ?? .object([:]))
    exit(0)

case "show":
    guard let id = invocation.positional.first, !id.isEmpty else {
        fail("usage", "show needs a recording id: rushes show ID")
    }
    let response = runRequest(invocation, cmd: "show", args: .object(["id": .string(id)]))
    printJSON(response.result ?? .object([:]))
    exit(0)

case "verify":
    guard let id = invocation.positional.first, !id.isEmpty else {
        fail("usage", "verify needs a recording id: rushes verify ID")
    }
    let response = runRequest(invocation, cmd: "verify", args: .object(["id": .string(id)]))
    printJSON(response.result ?? .object([:]))
    exit(0)

case "record start":
    var args: [String: JSONValue] = [:]
    if let display = invocation.flags["--display"] { args["display"] = .string(display) }
    if let window = invocation.flags["--window"] { args["window"] = .string(window) }
    if let camera = invocation.flags["--camera"] { args["camera"] = .string(camera) }
    if let mic = invocation.flags["--mic"] { args["mic"] = .string(mic) }
    if invocation.switches.contains("--system-audio") { args["systemAudio"] = .bool(true) }
    if let duration = invocation.flags["--duration"] {
        guard let value = Double(duration), value > 0 else {
            fail("usage", "--duration needs a positive number of seconds")
        }
        args["duration"] = .double(value)
    }
    if let countdown = invocation.flags["--countdown"] {
        guard let value = Int64(countdown), value >= 0 else {
            fail("usage", "--countdown needs a non-negative integer")
        }
        args["countdownSeconds"] = .int(value)
    }
    if let title = invocation.flags["--title"] { args["title"] = .string(title) }
    // `--camera`/`--mic` as bare switches mean "default".
    if invocation.switches.contains("--camera"), args["camera"] == nil {
        args["camera"] = .string("default")
    }
    if invocation.switches.contains("--mic"), args["mic"] == nil {
        args["mic"] = .string("default")
    }

    if invocation.switches.contains("--wait") {
        runRecordStartWait(invocation, args: args)
    }
    let response = runRequest(invocation, cmd: "record.start", args: .object(args))
    printJSON(response.result ?? .object([:]))
    exit(0)

case "record stop":
    var args: [String: JSONValue] = [:]
    if let id = invocation.flags["--id"], !id.isEmpty {
        args["id"] = .string(id)
    } else if let id = invocation.positional.first, !id.isEmpty {
        args["id"] = .string(id)
    }
    let response = runRequest(invocation, cmd: "record.stop", args: .object(args))
    printJSON(response.result ?? .object([:]))
    exit(0)

case "record pause":
    let response = runRequest(invocation, cmd: "record.pause")
    printJSON(response.result ?? .object([:]))
    exit(0)

case "record resume":
    let response = runRequest(invocation, cmd: "record.resume")
    printJSON(response.result ?? .object([:]))
    exit(0)

case "selftest sync":
    var args: [String: JSONValue] = [:]
    var seconds = 20.0
    var pauseAt: Double?
    if let raw = invocation.flags["--seconds"] {
        guard let value = Double(raw), value >= 6, value <= 600 else {
            fail("usage", "--seconds needs a number between 6 and 600")
        }
        seconds = value
    }
    args["seconds"] = .double(seconds)
    if let raw = invocation.flags["--pause-at"] {
        // The plan spells the flag as a list (`--pause-at S,S`); one pause is
        // what the selftest schedules, so the first value wins.
        guard let first = raw.split(separator: ",").first,
              let value = Double(first), value > 1, value < seconds - 3 else {
            fail("usage", "--pause-at needs a second between 1 and seconds-3")
        }
        pauseAt = value
        args["pauseAt"] = .double(value)
    }
    // The request covers the whole take plus finalization and measurement.
    let response = runRequest(
        invocation, cmd: "selftest.sync", args: .object(args),
        timeout: seconds + (pauseAt.map { _ in 3 } ?? 0) + 120)
    printJSON(response.result ?? .object([:]))
    exit(0)

case "analyze clap":
    guard let id = invocation.positional.first, !id.isEmpty else {
        fail("usage", "analyze clap needs a recording id: rushes analyze clap ID")
    }
    let response = runRequest(
        invocation, cmd: "analyze.clap", args: .object(["id": .string(id)]),
        timeout: 120)
    printJSON(response.result ?? .object([:]))
    exit(0)

default:
    fail(
        "usage",
        "unknown command `\(invocation.command)`; run `rushes guide --json`"
            + " for every command, its arguments and its exit codes")
}
