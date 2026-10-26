import AppKit
import Foundation
import Security
import Darwin
import CryptoKit

// This executable is a diagnostic parent, not a replacement product shell.
// It launches unchanged Rushes helpers and never opens physical capture devices.
func entitlement(_ name: String) -> Any {
    guard let task = SecTaskCreateFromSelf(nil) else { return NSNull() }
    return SecTaskCopyValueForEntitlement(task, name as CFString, nil) ?? NSNull()
}

func command(_ executable: URL, _ arguments: [String], timeout: Double = 45) throws -> [String: Any] {
    let child = Process(), output = Pipe(), error = Pipe()
    child.executableURL = executable
    child.arguments = arguments
    child.standardOutput = output
    child.standardError = error
    let done = DispatchSemaphore(value: 0)
    child.terminationHandler = { _ in done.signal() }
    try child.run()
    let timedOut = done.wait(timeout: .now() + timeout) == .timedOut
    if timedOut {
        child.terminate()
        if done.wait(timeout: .now() + 3) == .timedOut {
            kill(child.processIdentifier, SIGKILL)
            done.wait()
        }
    }
    return ["arguments": arguments, "exit": child.terminationStatus, "timedOut": timedOut,
            "stdout": String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self),
            "stderr": String(decoding: error.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)]
}

func jsonLines(_ row: [String: Any]) -> [[String: Any]] {
    (row["stdout"] as? String ?? "").split(separator: "\n").compactMap {
        (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
    }
}

func retired(_ child: Process, socket: URL) -> [String: Any] {
    if child.isRunning { child.terminate() }
    let deadline = Date().addingTimeInterval(12)
    while child.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    if child.isRunning { kill(child.processIdentifier, SIGKILL); child.waitUntilExit() }
    return ["pid": child.processIdentifier, "exited": !child.isRunning,
            "exit": child.terminationStatus, "socketAbsent": !FileManager.default.fileExists(atPath: socket.path)]
}

func experiment() throws -> [String: Any] {
    let fileManager = FileManager.default
    let args = CommandLine.arguments
    guard args.count >= 3 else { throw NSError(domain: "Probe", code: 2) }
    let outside = URL(fileURLWithPath: args[1]), nonce = args[2]
    let home = fileManager.homeDirectoryForCurrentUser
    let root = home.appendingPathComponent("Library/Application Support/RushesMASProbe/" + nonce)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    let allowed = root.appendingPathComponent("allowed.txt")
    try Data("Rushes sandbox positive control".utf8).write(to: allowed)
    var result: [String: Any] = ["home": home.path, "root": root.path,
        "sandboxEntitlement": entitlement("com.apple.security.app-sandbox"),
        "inheritEntitlement": entitlement("com.apple.security.inherit"),
        "containerWrite": fileManager.fileExists(atPath: allowed.path), "physicalCapture": false]
    do {
        try Data("Rushes sandbox enforcement control".utf8).write(to: outside)
        result["outsideWrite"] = ["allowed": true]
    } catch {
        let error = error as NSError
        result["outsideWrite"] = ["allowed": false, "domain": error.domain, "code": error.code,
            "underlyingDomain": (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.domain ?? "",
            "underlyingCode": (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.code ?? 0]
    }
    if args.contains("--filesystem-only") { return result }
    let resources = Bundle.main.bundleURL.appendingPathComponent("Contents/Resources/bin")
    let engine = resources.appendingPathComponent("rushcore-engine")
    let cli = resources.appendingPathComponent("rushes")
    let socketFolder = home.appendingPathComponent(".s")
    try fileManager.createDirectory(at: socketFolder, withIntermediateDirectories: true)
    let socket = socketFolder.appendingPathComponent(String(nonce.prefix(6)) + ".sock")
    guard socket.path.utf8.count < 104 else { throw NSError(domain: "SocketPath", code: 3) }
    result["socket"] = socket.path
    var rounds: [[String: Any]] = []
    for round in 1...2 {
        let log = root.appendingPathComponent("engine-\(round).log")
        fileManager.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        let child = Process()
        child.executableURL = engine
        child.arguments = ["--capture-stub", "--socket-path", socket.path,
            "--recordings-root", root.appendingPathComponent("recordings").path,
            "--index-path", root.appendingPathComponent("index.sqlite").path]
        child.standardOutput = handle
        child.standardError = handle
        try child.run()
        var row: [String: Any] = ["round": round, "pid": child.processIdentifier]
        do {
            let deadline = Date().addingTimeInterval(15)
            while child.isRunning && !fileManager.fileExists(atPath: socket.path) && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.03)
            }
            if !child.isRunning || !fileManager.fileExists(atPath: socket.path) {
                row["startupFailure"] = "Unchanged inherited helper did not publish its socket"
            } else {
                var requests: [[String: Any]] = []
                requests.append(try command(cli, ["--socket", socket.path, "ping"]))
                requests.append(try command(cli, ["--socket", socket.path, "status"]))
                requests.append(try command(cli, ["--socket", socket.path, "list"]))
                let take = try command(cli, ["--socket", socket.path, "record", "start", "--display", "main",
                    "--camera", "default", "--mic", "default", "--system-audio", "--duration", "3", "--wait"])
                requests.append(take)
                if let done = jsonLines(take).last(where: { $0["event"] as? String == "done" })?["result"] as? [String: Any],
                   let id = done["id"] as? String, let package = done["packagePath"] as? String {
                    row["recording"] = done
                    row["package"] = package
                    let manifestURL = URL(fileURLWithPath: package).appendingPathComponent("manifest.json")
                    let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as! [String: Any]
                    var before: [String: String] = [:]
                    for track in manifest["tracks"] as? [[String: Any]] ?? [] {
                        if track["present"] as? Bool == true, let name = track["file"] as? String {
                            let bytes = try Data(contentsOf: URL(fileURLWithPath: package).appendingPathComponent(name))
                            before[name] = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
                        }
                    }
                    row["originalHashesBeforeExport"] = before
                    requests.append(try command(cli, ["--socket", socket.path, "verify", id]))
                    let exportRoot = root.appendingPathComponent("exports-\(round)")
                    try fileManager.createDirectory(at: exportRoot, withIntermediateDirectories: true)
                    requests.append(try command(cli, ["--socket", socket.path, "export", id,
                        "--preset", "share", "--output", exportRoot.appendingPathComponent("combined.mp4").path], timeout: 90))
                    requests.append(try command(cli, ["--socket", socket.path, "export", id,
                        "--preset", "editor-tracks", "--output", exportRoot.appendingPathComponent("originals").path], timeout: 90))
                    row["exports"] = exportRoot.path
                }
                row["requests"] = requests
            }
        } catch { row["error"] = String(describing: error) }
        row["retirement"] = retired(child, socket: socket)
        try handle.close()
        row["engineLog"] = (try? String(contentsOf: log, encoding: .utf8)) ?? ""
        rounds.append(row)
    }
    result["rounds"] = rounds
    result["helperOutsideIndex"] = try command(engine, ["--capture-stub", "--socket-path", socket.path,
        "--recordings-root", root.appendingPathComponent("recordings").path,
        "--index-path", outside.appendingPathExtension("sqlite").path], timeout: 15)
    return result
}

do {
    let result = try experiment()
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    print(String(decoding: data, as: UTF8.self))
    exit(0)
} catch {
    let data = try! JSONSerialization.data(withJSONObject: ["runnerError": String(describing: error)])
    print(String(decoding: data, as: UTF8.self))
    exit(1)
}
