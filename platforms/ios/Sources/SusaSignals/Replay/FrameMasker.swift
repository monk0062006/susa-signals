#if canImport(UIKit)
import UIKit
import WebKit

/**
 Finds regions of the screen that must never appear in a recording, and paints
 over them.

 The web recorder masks by CSS selector and Android by view hierarchy; this is
 the UIKit equivalent. The principle is identical and non-negotiable: **default
 to hiding**. A recorder that captures everything until someone remembers to
 exclude the password field will eventually ship a password to a server —
 silently, permanently, and discovered by a customer.

 Mirrors `FrameMasker.kt`. Divergence between the two is the first sign the
 platforms have drifted on the guarantee that matters most.
 */
enum FrameMasker {

    /// Set `view.accessibilityIdentifier` to this, or add it to
    /// `susaPrivateViews`, to exclude a view. Mirrors `data-private` on web
    /// and the `susa-private` tag on Android.
    static let privateIdentifier = "susa-private"

    /// Solid fill, never a blur: blur is reversible enough to be unsafe.
    private static let redaction = UIColor(red: 0.067, green: 0.078, blue: 0.102, alpha: 1)

    /**
     Collects rectangles to obscure, in window coordinates.

     Walks the whole hierarchy rather than sampling: a missed subtree is a
     leaked field, and view trees are shallow enough that traversal costs
     nothing next to the frame encode.
     */
    static func sensitiveRegions(in root: UIView) -> [CGRect] {
        var regions: [CGRect] = []
        collect(root, into: &regions, window: root.window ?? root)
        return regions
    }

    private static func collect(_ view: UIView, into regions: inout [CGRect], window: UIView) {
        // Hidden views cannot leak what is not drawn, and skipping them avoids
        // masking regions the user cannot see anyway.
        guard !view.isHidden, view.alpha > 0.01 else { return }

        if isSensitive(view) {
            regions.append(view.convert(view.bounds, to: window))
            // No need to descend: the whole subtree is already covered.
            return
        }

        for subview in view.subviews {
            collect(subview, into: &regions, window: window)
        }
    }

    private static func isSensitive(_ view: UIView) -> Bool {
        if view.accessibilityIdentifier == privateIdentifier { return true }

        // Web views render arbitrary remote content this SDK cannot inspect, so
        // their contents are unknowable and treated as sensitive wholesale.
        if view is WKWebView { return true }

        if let field = view as? UITextField {
            if field.isSecureTextEntry { return true }
            if let type = field.textContentType, sensitiveContentTypes.contains(type) {
                return true
            }
        }

        if let textView = view as? UITextView {
            if textView.isSecureTextEntry { return true }
            if let type = textView.textContentType, sensitiveContentTypes.contains(type) {
                return true
            }
        }

        return false
    }

    /// Payment and credential fields, matched the way UIKit declares them. The
    /// host app already labels these for autofill, so reusing that costs the
    /// integrator nothing.
    private static let sensitiveContentTypes: Set<UITextContentType> = {
        var types: Set<UITextContentType> = [
            .password,
            .newPassword,
            .username,
            .creditCardNumber,
            .emailAddress,
            .telephoneNumber,
        ]
        if #available(iOS 15.0, *) {
            types.insert(.oneTimeCode)
        }
        return types
    }()

    /// Paints over every sensitive region. Must run before the frame is encoded.
    static func apply(_ regions: [CGRect], in context: CGContext, scale: CGFloat) {
        guard !regions.isEmpty else { return }
        context.setFillColor(redaction.cgColor)

        for region in regions {
            context.fill(CGRect(
                x: region.origin.x * scale,
                y: region.origin.y * scale,
                width: region.width * scale,
                height: region.height * scale
            ))
        }
    }
}
#endif
