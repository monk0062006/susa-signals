// swift-tools-version:5.9
import PackageDescription

/**
 Root manifest.

 SPM resolves a package from the root of whatever repository it is pointed at,
 so a manifest nested under `platforms/ios/` cannot be consumed at all — the
 sources existed but no consumer could depend on them. The paths below point
 back into `platforms/ios/`, keeping the per-platform layout intact while making
 the package resolvable.
 */
let package = Package(
    name: "Feedback",
    platforms: [
        // UIGraphicsImageRenderer needs iOS 10; 13 is the realistic floor for
        // anything shipping today. Raising it is a compatibility decision, not
        // something to change to work around a build error.
        .iOS(.v13)
    ],
    products: [
        .library(name: "Feedback", targets: ["Feedback"])
    ],
    targets: [
        // No third-party dependencies, for the same reason as Android: this
        // library is embedded in other companies' apps, and a version conflict
        // caused by an SDK is debugged by the customer.
        .target(name: "Feedback", path: "platforms/ios/Sources/Feedback"),
        .testTarget(
            name: "FeedbackTests",
            dependencies: ["Feedback"],
            path: "platforms/ios/Tests/FeedbackTests"
        )
    ]
)
