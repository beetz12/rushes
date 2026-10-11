// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "loom-clone",
    platforms: [
        .macOS("26.4")
    ],
    targets: [
        .target(
            name: "LoomCore",
            path: "Sources/LoomCore"
        ),
        .executableTarget(
            name: "loomcore-engine",
            dependencies: ["LoomCore"],
            path: "Sources/loomcore-engine"
        ),
        .executableTarget(
            name: "loomclone",
            dependencies: ["LoomCore"],
            path: "Sources/loomclone"
        ),
        .testTarget(
            name: "LoomCoreTests",
            dependencies: ["LoomCore"],
            path: "Tests/LoomCoreTests"
        ),
    ]
)
