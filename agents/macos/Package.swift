// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "nrvl-agent",
    platforms: [.macOS(.v13)],
    targets: [
        .target(name: "AgentCore"),
        .executableTarget(name: "nrvl-agent", dependencies: ["AgentCore"]),
        .testTarget(name: "AgentCoreTests", dependencies: ["AgentCore"]),
    ]
)
