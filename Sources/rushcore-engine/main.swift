import Foundation
import RushCore

let engineVersion = "0.1.0-dev"

if CommandLine.arguments.contains("--version") {
    print("{\"name\":\"rushcore-engine\",\"version\":\"\(engineVersion)\"}")
    exit(0)
}

// The engine will boot LoomCore and serve the control socket here (Phase 1,
// docs/PLAN.md "Roadmap" item 8). Until then it only reports its version.
print("{\"name\":\"rushcore-engine\",\"version\":\"\(engineVersion)\",\"status\":\"not-implemented\"}")
exit(1)
