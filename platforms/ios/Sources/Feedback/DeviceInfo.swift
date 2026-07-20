import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Collects the iOS equivalent of web's `collectDeviceContext`.
enum DeviceInfo {

    static func collect(sdkVersion: String, route: String?) -> DeviceContext {
        var context = DeviceContext(sdkVersion: sdkVersion)
        context.platform = .ios
        context.osName = "iOS"
        context.locale = Locale.current.identifier
        context.timezone = TimeZone.current.identifier
        context.route = route

        let bundle = Bundle.main
        context.appVersion = bundle.infoDictionary?["CFBundleShortVersionString"] as? String
        context.appBuild = bundle.infoDictionary?["CFBundleVersion"] as? String
        context.deviceModel = hardwareIdentifier()

        #if canImport(UIKit)
        context.osVersion = UIDevice.current.systemVersion
        // UIScreen.main is deprecated in multi-scene apps but remains the only
        // synchronous way to get screen metrics off the main thread.
        let screen = UIScreen.main
        context.screen = ScreenInfo(
            width: Int(screen.bounds.width),
            height: Int(screen.bounds.height),
            pixelRatio: Double(screen.scale)
        )
        #endif

        // Deliberately omitted: determining it requires Network framework monitoring
        // that must be started at launch and kept alive, which is more lifecycle
        // intrusion than a diagnostic field justifies.
        context.networkType = nil

        return context
    }

    /// Returns the machine identifier ("iPhone15,2") rather than the marketing name.
    /// UIDevice.model only ever returns "iPhone", which is useless for triage.
    private static func hardwareIdentifier() -> String? {
        var systemInfo = utsname()
        uname(&systemInfo)

        let mirror = Mirror(reflecting: systemInfo.machine)
        let identifier = mirror.children.reduce(into: "") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            partial.append(Character(UnicodeScalar(UInt8(bitPattern: value))))
        }

        return identifier.isEmpty ? nil : identifier
    }
}
