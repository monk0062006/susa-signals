import Foundation

/**
 Coordinate math for the annotation surface, deliberately free of UIKit so it is
 testable without a simulator. Mirrors `AnnotationGeometry.kt` case for case.

 The screenshot is drawn aspect-fit inside the view, which letterboxes it. Every
 touch therefore has to be mapped through the *drawn image rect*, not the view
 bounds — mapping through view bounds puts every annotation in the wrong place on
 any device whose aspect ratio differs from the screenshot's.
 */
public struct ImageRect: Equatable {
    public let left: Double
    public let top: Double
    public let width: Double
    public let height: Double

    public init(left: Double, top: Double, width: Double, height: Double) {
        self.left = left
        self.top = top
        self.width = width
        self.height = height
    }
}

/// Tools a user can draw with. Mirrors the web overlay and Android.
public enum Tool {
    case rect, arrow, pen, blur
}

public enum AnnotationGeometry {

    /// Smallest drag that counts as a shape. Below this it is a stray tap.
    public static let minExtent: Double = 0.005

    /// Aspect-fit placement of an image inside a view, centered.
    public static func fitRect(
        viewWidth: Double,
        viewHeight: Double,
        imageWidth: Double,
        imageHeight: Double
    ) -> ImageRect {
        guard viewWidth > 0, viewHeight > 0, imageWidth > 0, imageHeight > 0 else {
            return ImageRect(left: 0, top: 0, width: 0, height: 0)
        }

        let scale = min(viewWidth / imageWidth, viewHeight / imageHeight)
        let drawnWidth = imageWidth * scale
        let drawnHeight = imageHeight * scale

        return ImageRect(
            left: (viewWidth - drawnWidth) / 2,
            top: (viewHeight - drawnHeight) / 2,
            width: drawnWidth,
            height: drawnHeight
        )
    }

    /// Maps a touch in view coordinates to 0..1 image space, clamped so a drag that
    /// leaves the image produces a shape flush with the border.
    public static func toNormalized(touchX: Double, touchY: Double, rect: ImageRect) -> Point {
        guard rect.width > 0, rect.height > 0 else { return Point(x: 0, y: 0) }
        return Point(
            x: min(max((touchX - rect.left) / rect.width, 0), 1),
            y: min(max((touchY - rect.top) / rect.height, 0), 1)
        )
    }

    /// Maps normalized image coordinates back to view coordinates, for rendering.
    public static func toView(_ point: Point, rect: ImageRect) -> (x: Double, y: Double) {
        (x: rect.left + point.x * rect.width, y: rect.top + point.y * rect.height)
    }

    /// Builds the annotation a drag represents, or nil if it was too small to be
    /// intentional.
    public static func build(
        tool: Tool,
        start: Point,
        end: Point,
        penPoints: [Point],
        color: String
    ) -> Annotation? {
        let dx = end.x - start.x
        let dy = end.y - start.y

        switch tool {
        case .rect, .blur:
            guard abs(dx) >= minExtent, abs(dy) >= minExtent else { return nil }
            // Normalize so a box dragged up-and-left still has positive extents.
            let origin = Point(x: min(start.x, end.x), y: min(start.y, end.y))
            let width = abs(dx)
            let height = abs(dy)
            return tool == .blur
                ? .blur(origin: origin, width: width, height: height)
                : .rect(origin: origin, width: width, height: height, color: color)

        case .arrow:
            // Largest axis, so a purely horizontal arrow is not rejected for
            // having zero height.
            let distance = max(abs(dx), abs(dy))
            guard distance >= minExtent * 2 else { return nil }
            return .arrow(from: start, to: end, color: color)

        case .pen:
            guard penPoints.count >= 2 else { return nil }
            return .pen(points: penPoints, color: color, strokeWidth: 3)
        }
    }
}
