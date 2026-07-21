#if canImport(UIKit)
import UIKit

/**
 Draws annotations, and flattens them into the screenshot bytes.

 `flatten` is the security-relevant path: redactions must be burned into the pixels
 before upload. Transmitting a clean screenshot plus a "blur this region"
 instruction would send the very data the user asked to hide.
 */
enum AnnotationRenderer {

    private static let arrowHead: CGFloat = 28

    /// Solid fill, not a Gaussian blur: blur is reversible enough to be unsafe.
    private static let redactionColor = UIColor(red: 0.067, green: 0.078, blue: 0.102, alpha: 1)

    static func draw(_ annotations: [Annotation], in context: CGContext, rect: ImageRect) {
        for annotation in annotations {
            drawOne(annotation, in: context, rect: rect)
        }
    }

    private static func drawOne(_ annotation: Annotation, in context: CGContext, rect: ImageRect) {
        switch annotation {
        case let .rect(origin, width, height, color):
            let point = AnnotationGeometry.toView(origin, rect: rect)
            context.setStrokeColor(parse(color).cgColor)
            context.setLineWidth(6)
            context.stroke(CGRect(
                x: point.x,
                y: point.y,
                width: width * rect.width,
                height: height * rect.height
            ))

        case let .blur(origin, width, height):
            let point = AnnotationGeometry.toView(origin, rect: rect)
            context.setFillColor(redactionColor.cgColor)
            context.fill(CGRect(
                x: point.x,
                y: point.y,
                width: width * rect.width,
                height: height * rect.height
            ))

        case let .arrow(from, to, color):
            let start = AnnotationGeometry.toView(from, rect: rect)
            let end = AnnotationGeometry.toView(to, rect: rect)

            context.setStrokeColor(parse(color).cgColor)
            context.setFillColor(parse(color).cgColor)
            context.setLineWidth(6)
            context.move(to: CGPoint(x: start.x, y: start.y))
            context.addLine(to: CGPoint(x: end.x, y: end.y))
            context.strokePath()

            let angle = atan2(end.y - start.y, end.x - start.x)
            context.move(to: CGPoint(x: end.x, y: end.y))
            context.addLine(to: CGPoint(
                x: end.x - Double(arrowHead) * cos(angle - .pi / 6),
                y: end.y - Double(arrowHead) * sin(angle - .pi / 6)
            ))
            context.addLine(to: CGPoint(
                x: end.x - Double(arrowHead) * cos(angle + .pi / 6),
                y: end.y - Double(arrowHead) * sin(angle + .pi / 6)
            ))
            context.closePath()
            context.fillPath()

        case let .pen(points, color, strokeWidth):
            guard points.count >= 2 else { return }
            context.setStrokeColor(parse(color).cgColor)
            context.setLineWidth(CGFloat(strokeWidth) * 2)
            context.setLineJoin(.round)
            context.setLineCap(.round)

            for (index, point) in points.enumerated() {
                let view = AnnotationGeometry.toView(point, rect: rect)
                let cgPoint = CGPoint(x: view.x, y: view.y)
                if index == 0 {
                    context.move(to: cgPoint)
                } else {
                    context.addLine(to: cgPoint)
                }
            }
            context.strokePath()
        }
    }

    /**
     Burns annotations into the screenshot and re-encodes it.

     Renders at full image resolution rather than at the on-screen preview size, so
     a redaction drawn over a scaled-down preview covers the same region on the
     original. Rendering at preview scale would leave sensitive pixels exposed at
     the edges.
     */
    static func flatten(image: UIImage, annotations: [Annotation]) -> Data? {
        let pixelSize = CGSize(
            width: image.size.width * image.scale,
            height: image.size.height * image.scale
        )

        let format = UIGraphicsImageRendererFormat()
        // scale 1 with an explicit pixel-sized canvas: the source image's scale is
        // already baked into pixelSize, and applying it twice would double the
        // canvas and misplace every annotation.
        format.scale = 1
        format.opaque = true

        let renderer = UIGraphicsImageRenderer(size: pixelSize, format: format)
        let flattened = renderer.image { ctx in
            image.draw(in: CGRect(origin: .zero, size: pixelSize))

            // Full-image rect: normalized coords map directly onto real pixels.
            let rect = ImageRect(
                left: 0,
                top: 0,
                width: Double(pixelSize.width),
                height: Double(pixelSize.height)
            )
            draw(annotations, in: ctx.cgContext, rect: rect)
        }

        // PNG: lossy artifacts around UI text make a bug report harder to read.
        return flattened.pngData()
    }

    /// Falls back rather than crashing: a bad colour must not lose the report.
    private static func parse(_ value: String) -> UIColor {
        var hex = value
        if hex.hasPrefix("#") { hex.removeFirst() }
        guard hex.count == 6, let int = UInt32(hex, radix: 16) else { return .red }

        return UIColor(
            red: CGFloat((int >> 16) & 0xFF) / 255,
            green: CGFloat((int >> 8) & 0xFF) / 255,
            blue: CGFloat(int & 0xFF) / 255,
            alpha: 1
        )
    }
}
#endif
