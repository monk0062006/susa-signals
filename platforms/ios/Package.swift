// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Feedback",
    platforms: [
        // PixelCopy's counterpart, UIGraphicsImageRenderer, needs iOS 10; 13 is the
        // realistic floor for anything shipping today.
        .iOS(.v13)
    ],
    products: [
        .library(name: "Feedback", targets: ["Feedback"])
    ],
    targets: [
        // No third-party dependencies, for the same reason as Android: this library
        // is embedded in other companies' apps, and a version conflict caused by an
        // SDK is debugged by the customer.
        .target(name: "Feedback", path: "Sources/Feedback"),
        .testTarget(name: "FeedbackTests", dependencies: ["Feedback"], path: "Tests/FeedbackTests")
    ]
)
