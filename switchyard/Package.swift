// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Switchyard",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Switchyard",
            path: "Sources/Switchyard",
            linkerSettings: [
                // SkyLight hosts the window-server calls used to focus a specific
                // window and to capture thumbnails of windows on other Spaces.
                .unsafeFlags(["-F/System/Library/PrivateFrameworks", "-framework", "SkyLight"])
            ]
        )
    ]
)
