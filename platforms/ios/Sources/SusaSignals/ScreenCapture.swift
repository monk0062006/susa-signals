#if canImport(UIKit)
import UIKit

/**
 Screenshot capture — the iOS counterpart to Android's PixelCopy path.

 `drawHierarchy(afterScreenUpdates:)` renders the real composited hierarchy,
 including Metal/SceneKit/AVPlayer content that `layer.render(in:)` reproduces as
 blank. The layer path stays as a fallback because `drawHierarchy` returns false
 for windows that are not yet on screen.

 Must be called on the main thread — UIKit rendering is not thread-safe.
 */
enum ScreenCapture {

    /// Returns the raw image rather than encoded bytes, because the annotation
    /// composer needs to draw on it. Encoding happens once, after annotation.
    static func captureImage() -> UIImage? {
        assert(Thread.isMainThread, "ScreenCapture must run on the main thread")

        guard let window = keyWindow() else { return nil }
        let bounds = window.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }

        let format = UIGraphicsImageRendererFormat()
        // Cap at 2x: 3x on a Pro Max triples the bytes for no triage value.
        format.scale = min(window.screen.scale, 2)
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        return renderer.image { context in
            // afterScreenUpdates: false — true forces a synchronous layout pass and
            // can deadlock if called from inside a view lifecycle callback.
            if !window.drawHierarchy(in: bounds, afterScreenUpdates: false) {
                window.layer.render(in: context.cgContext)
            }
        }
    }

    /// Key window, for the composer to attach to.
    static func activeWindow() -> UIWindow? { keyWindow() }

    static func capture() -> (data: Data, width: Int, height: Int)? {
        assert(Thread.isMainThread, "ScreenCapture.capture() must run on the main thread")

        guard let window = keyWindow() else { return nil }
        let bounds = window.bounds
        guard bounds.width > 0, bounds.height > 0 else { return nil }

        let format = UIGraphicsImageRendererFormat()
        // Cap at 2x: 3x on a Pro Max triples the bytes for no triage value.
        format.scale = min(window.screen.scale, 2)
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        let image = renderer.image { context in
            // afterScreenUpdates: false — true forces a synchronous layout pass and
            // can deadlock if called from inside a view lifecycle callback.
            if !window.drawHierarchy(in: bounds, afterScreenUpdates: false) {
                window.layer.render(in: context.cgContext)
            }
        }

        // PNG: screenshots are UI, where lossy artifacts around text make a bug
        // report harder to read than the bytes saved are worth.
        guard let data = image.pngData() else { return nil }
        return (data, Int(image.size.width * format.scale), Int(image.size.height * format.scale))
    }

    private static func keyWindow() -> UIWindow? {
        // UIApplication.keyWindow is deprecated and returns nil in multi-scene apps,
        // which is every iPad app and many iPhone ones.
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)
            ?? UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .flatMap(\.windows)
                .first
    }
}
#endif
