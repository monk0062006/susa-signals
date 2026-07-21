package com.susatest.signals.annotate

import com.susatest.signals.Annotation
import com.susatest.signals.Point
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Coordinate math for the annotation surface, deliberately free of Android types
 * so it is unit-testable on the JVM.
 *
 * The screenshot is drawn aspect-fit inside the view, which letterboxes it. Every
 * touch therefore has to be mapped through the *drawn image rect*, not the view
 * bounds — mapping through view bounds puts every annotation in the wrong place on
 * any device whose aspect ratio differs from the screenshot's, which is most of
 * them once you account for system bars.
 */
data class ImageRect(val left: Float, val top: Float, val width: Float, val height: Float)

/** Tools a user can draw with. Mirrors the web overlay. */
enum class Tool { RECT, ARROW, PEN, BLUR }

object AnnotationGeometry {

    /** Smallest drag that counts as a shape. Below this it is a stray tap. */
    const val MIN_EXTENT = 0.005f

    /**
     * Aspect-fit placement of an image inside a view, centered, never upscaled
     * beyond the view.
     */
    fun fitRect(viewWidth: Float, viewHeight: Float, imageWidth: Float, imageHeight: Float): ImageRect {
        if (viewWidth <= 0f || viewHeight <= 0f || imageWidth <= 0f || imageHeight <= 0f) {
            return ImageRect(0f, 0f, 0f, 0f)
        }

        val scale = min(viewWidth / imageWidth, viewHeight / imageHeight)
        val drawnWidth = imageWidth * scale
        val drawnHeight = imageHeight * scale

        return ImageRect(
            left = (viewWidth - drawnWidth) / 2f,
            top = (viewHeight - drawnHeight) / 2f,
            width = drawnWidth,
            height = drawnHeight
        )
    }

    /**
     * Maps a touch in view coordinates to 0..1 image space.
     *
     * Clamped, so a drag that leaves the image edge produces a shape flush with the
     * border rather than coordinates outside the picture.
     */
    fun toNormalized(touchX: Float, touchY: Float, rect: ImageRect): Point {
        if (rect.width <= 0f || rect.height <= 0f) return Point(0f, 0f)
        return Point(
            x = ((touchX - rect.left) / rect.width).coerceIn(0f, 1f),
            y = ((touchY - rect.top) / rect.height).coerceIn(0f, 1f)
        )
    }

    /** Maps normalized image coordinates back to view coordinates, for rendering. */
    fun toView(point: Point, rect: ImageRect): Pair<Float, Float> =
        Pair(rect.left + point.x * rect.width, rect.top + point.y * rect.height)

    /**
     * Builds the annotation a drag represents, or null if the drag was too small
     * to be intentional.
     */
    fun build(
        tool: Tool,
        start: Point,
        end: Point,
        penPoints: List<Point>,
        color: String
    ): Annotation? {
        val dx = end.x - start.x
        val dy = end.y - start.y

        return when (tool) {
            Tool.RECT, Tool.BLUR -> {
                if (abs(dx) < MIN_EXTENT || abs(dy) < MIN_EXTENT) return null
                // Normalize so a box dragged up-and-left still has positive extents.
                val origin = Point(min(start.x, end.x), min(start.y, end.y))
                val width = abs(dx)
                val height = abs(dy)
                if (tool == Tool.BLUR) {
                    Annotation.Blur(origin, width, height)
                } else {
                    Annotation.Rect(origin, width, height, color)
                }
            }

            Tool.ARROW -> {
                // Diagonal distance, so a purely horizontal arrow is not rejected
                // for having zero height.
                val distance = max(abs(dx), abs(dy))
                if (distance < MIN_EXTENT * 2) return null
                Annotation.Arrow(start, end, color)
            }

            Tool.PEN -> {
                if (penPoints.size < 2) return null
                Annotation.Pen(penPoints.toList(), color, strokeWidth = 3f)
            }
        }
    }
}
