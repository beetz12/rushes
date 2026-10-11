// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "rushes",
    platforms: [
        .macOS("26.4")
    ],
    targets: [
        .target(
            name: "RushCore",
            path: "Sources/RushCore"
        ),
        .executableTarget(
            name: "rushcore-engine",
            dependencies: ["RushCore"],
            path: "Sources/rushcore-engine"
        ),
        .executableTarget(
            name: "rushes",
            dependencies: ["RushCore"],
            path: "Sources/rushes"
        ),
        .testTarget(
            name: "RushCoreTests",
            dependencies: ["RushCore"],
            path: "Tests/RushCoreTests"
        ),
    ]
)
