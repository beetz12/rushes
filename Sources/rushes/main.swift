import Foundation
import RushCore

let cliVersion = "0.1.0-dev"

if CommandLine.arguments.contains("--version") {
    print("{\"name\":\"rushes\",\"version\":\"\(cliVersion)\"}")
    exit(0)
}

// The CLI will be a thin client of the engine's control socket (Phase 1,
// docs/PLAN.md "Roadmap" item 8). Until then it only reports its version.
FileHandle.standardError.write(
    Data(("error: no commands implemented yet; see docs/PLAN.md Phase 1\n").utf8))
exit(1)
