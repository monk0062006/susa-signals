package io.markerusa.feedback

import io.markerusa.feedback.annotate.AnnotationGeometry
import io.markerusa.feedback.annotate.ImageRect
import io.markerusa.feedback.annotate.Tool
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Coordinate math for the annotation surface.
 *
 * This is the highest-value thing to unit test in the composer: a letterboxing
 * error does not crash, it silently places every redaction in the wrong spot —
 * which means a redaction that appears to cover a password covers empty space,
 * and the password ships.
 */
class AnnotationGeometryTest {

    private val tolerance = 0.0001f

    @Test
    fun `image wider than view is letterboxed vertically`() {
        // 1000x500 image into a 400x400 view: scale 0.4, drawn 400x200, centered.
        val rect = AnnotationGeometry.fitRect(400f, 400f, 1000f, 500f)

        assertEquals(0f, rect.left, tolerance)
        assertEquals(100f, rect.top, tolerance)
        assertEquals(400f, rect.width, tolerance)
        assertEquals(200f, rect.height, tolerance)
    }

    @Test
    fun `image taller than view is pillarboxed horizontally`() {
        // 500x1000 into 400x400: scale 0.4, drawn 200x400, centered.
        val rect = AnnotationGeometry.fitRect(400f, 400f, 500f, 1000f)

        assertEquals(100f, rect.left, tolerance)
        assertEquals(0f, rect.top, tolerance)
        assertEquals(200f, rect.width, tolerance)
        assertEquals(400f, rect.height, tolerance)
    }

    @Test
    fun `a touch in the letterbox band maps to the image edge, not outside it`() {
        val rect = AnnotationGeometry.fitRect(400f, 400f, 1000f, 500f) // band above y=100

        // y=10 is in the black band above the image.
        val point = AnnotationGeometry.toNormalized(200f, 10f, rect)

        assertEquals(0.5f, point.x, tolerance)
        // Clamped to the top edge rather than going negative.
        assertEquals(0f, point.y, tolerance)
    }

    @Test
    fun `touch maps through the drawn rect, not the view bounds`() {
        val rect = AnnotationGeometry.fitRect(400f, 400f, 1000f, 500f)

        // Centre of the drawn image is (200, 200) in view space.
        val centre = AnnotationGeometry.toNormalized(200f, 200f, rect)
        assertEquals(0.5f, centre.x, tolerance)
        assertEquals(0.5f, centre.y, tolerance)

        // Bottom-right of the drawn image is (400, 300).
        val corner = AnnotationGeometry.toNormalized(400f, 300f, rect)
        assertEquals(1f, corner.x, tolerance)
        assertEquals(1f, corner.y, tolerance)
    }

    @Test
    fun `normalized to view round trips`() {
        val rect = AnnotationGeometry.fitRect(400f, 400f, 1000f, 500f)
        val original = Point(0.25f, 0.75f)

        val (viewX, viewY) = AnnotationGeometry.toView(original, rect)
        val back = AnnotationGeometry.toNormalized(viewX, viewY, rect)

        assertEquals(original.x, back.x, tolerance)
        assertEquals(original.y, back.y, tolerance)
    }

    @Test
    fun `a rectangle dragged up-and-left still has positive extents`() {
        val annotation = AnnotationGeometry.build(
            Tool.RECT,
            start = Point(0.8f, 0.9f),
            end = Point(0.2f, 0.3f),
            penPoints = emptyList(),
            color = "#FF3B30"
        )

        val rect = annotation as? Annotation.Rect
        assertNotNull(rect)
        // Origin is the top-left corner regardless of drag direction; negative
        // width would make the redaction cover nothing at all.
        assertEquals(0.2f, rect!!.origin.x, tolerance)
        assertEquals(0.3f, rect.origin.y, tolerance)
        assertTrue(rect.width > 0f)
        assertTrue(rect.height > 0f)
    }

    @Test
    fun `redaction drag produces a blur annotation`() {
        val annotation = AnnotationGeometry.build(
            Tool.BLUR,
            start = Point(0.1f, 0.1f),
            end = Point(0.5f, 0.5f),
            penPoints = emptyList(),
            color = "#FF3B30"
        )

        assertTrue(annotation is Annotation.Blur)
    }

    @Test
    fun `a stray tap does not create a shape`() {
        val annotation = AnnotationGeometry.build(
            Tool.RECT,
            start = Point(0.5f, 0.5f),
            end = Point(0.5001f, 0.5001f),
            penPoints = emptyList(),
            color = "#FF3B30"
        )

        assertNull(annotation)
    }

    @Test
    fun `a horizontal arrow is not rejected for having zero height`() {
        val annotation = AnnotationGeometry.build(
            Tool.ARROW,
            start = Point(0.1f, 0.5f),
            end = Point(0.9f, 0.5f),
            penPoints = emptyList(),
            color = "#FF3B30"
        )

        assertTrue(annotation is Annotation.Arrow)
    }

    @Test
    fun `a pen stroke needs at least two points`() {
        val single = AnnotationGeometry.build(
            Tool.PEN, Point(0.1f, 0.1f), Point(0.1f, 0.1f),
            penPoints = listOf(Point(0.1f, 0.1f)), color = "#FF3B30"
        )
        assertNull(single)

        val stroke = AnnotationGeometry.build(
            Tool.PEN, Point(0.1f, 0.1f), Point(0.2f, 0.2f),
            penPoints = listOf(Point(0.1f, 0.1f), Point(0.2f, 0.2f)), color = "#FF3B30"
        )
        assertTrue(stroke is Annotation.Pen)
    }

    @Test
    fun `degenerate view size does not divide by zero`() {
        val rect = AnnotationGeometry.fitRect(0f, 0f, 1000f, 500f)
        assertEquals(ImageRect(0f, 0f, 0f, 0f), rect)

        // Must return a value rather than NaN, which would poison the payload.
        val point = AnnotationGeometry.toNormalized(10f, 10f, rect)
        assertEquals(0f, point.x, tolerance)
        assertEquals(0f, point.y, tolerance)
    }
}
