package io.markerusa.feedback

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.markerusa.feedback.annotate.AnnotationRenderer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Redaction, verified on real hardware by reading pixels back.
 *
 * This is the assertion that matters most in the whole Android library. Every
 * other test can pass while redaction quietly fails to cover anything, and the
 * failure mode is a customer's password shipped to a server. JVM unit tests
 * cannot check it: android.graphics is stubbed there, so Canvas draws nothing
 * and every colour assertion would trivially pass.
 */
@RunWith(AndroidJUnit4::class)
class AnnotationRendererInstrumentedTest {

    private fun redBitmap(width: Int = 400, height: Int = 200): Bitmap {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        Canvas(bitmap).drawColor(Color.RED)
        return bitmap
    }

    private fun decode(bytes: ByteArray): Bitmap =
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)

    @Test
    fun redactionActuallyCoversPixels() {
        val source = redBitmap()

        // Cover the left half.
        val flattened = decode(
            AnnotationRenderer.flatten(
                source,
                listOf(Annotation.Blur(Point(0f, 0f), width = 0.5f, height = 1f)),
            ),
        )

        val covered = flattened.getPixel(100, 100)
        val untouched = flattened.getPixel(300, 100)

        // The redacted region must no longer be the original colour...
        assertNotEquals("redaction did not change the covered pixels", Color.RED, covered)
        // ...and the rest of the image must be intact.
        assertEquals("redaction bled outside its bounds", Color.RED, untouched)
    }

    @Test
    fun redactionIsOpaque() {
        val source = redBitmap()
        val flattened = decode(
            AnnotationRenderer.flatten(
                source,
                listOf(Annotation.Blur(Point(0.25f, 0.25f), width = 0.5f, height = 0.5f)),
            ),
        )

        val covered = flattened.getPixel(200, 100)

        // A translucent fill would leave the underlying content recoverable by
        // anyone who adjusts levels on the delivered PNG.
        assertEquals("redaction is not fully opaque", 255, Color.alpha(covered))
        assertTrue(
            "redaction is not dark enough to obscure content",
            Color.red(covered) < 60 && Color.green(covered) < 60 && Color.blue(covered) < 60,
        )
    }

    @Test
    fun flattenDoesNotMutateTheSourceBitmap() {
        val source = redBitmap()

        AnnotationRenderer.flatten(
            source,
            listOf(Annotation.Blur(Point(0f, 0f), width = 1f, height = 1f)),
        )

        // Mutating the caller's bitmap is how you get a redacted preview but an
        // unredacted upload, or vice versa.
        assertEquals("flatten mutated the source", Color.RED, source.getPixel(10, 10))
    }

    @Test
    fun normalizedCoordinatesMapToFullResolution() {
        // Deliberately not square, and much larger than any preview would be.
        val source = redBitmap(width = 1080, height = 2400)

        val flattened = decode(
            AnnotationRenderer.flatten(
                source,
                // Bottom-right quadrant.
                listOf(Annotation.Blur(Point(0.5f, 0.5f), width = 0.5f, height = 0.5f)),
            ),
        )

        assertEquals("output resolution changed", 1080, flattened.width)
        assertEquals("output resolution changed", 2400, flattened.height)

        // Rendering at preview scale instead of full resolution would leave the
        // bottom-right corner exposed.
        assertNotEquals(Color.RED, flattened.getPixel(1000, 2300))
        assertEquals(Color.RED, flattened.getPixel(100, 100))
    }

    @Test
    fun annotationsRenderWithoutCrashingOnRealCanvas() {
        val source = redBitmap()

        val bytes = AnnotationRenderer.flatten(
            source,
            listOf(
                Annotation.Rect(Point(0.1f, 0.1f), 0.3f, 0.3f, "#FF3B30"),
                Annotation.Arrow(Point(0.1f, 0.9f), Point(0.9f, 0.1f), "#FF3B30"),
                Annotation.Pen(
                    listOf(Point(0.2f, 0.2f), Point(0.4f, 0.5f), Point(0.6f, 0.3f)),
                    "#FF3B30",
                    strokeWidth = 3f,
                ),
                Annotation.Blur(Point(0.7f, 0.7f), 0.2f, 0.2f),
            ),
        )

        val flattened = decode(bytes)
        assertEquals(400, flattened.width)
        // A malformed colour must fall back rather than throw and lose the report.
        assertTrue("PNG encoding produced nothing", bytes.isNotEmpty())
    }

    @Test
    fun invalidColourFallsBackInsteadOfCrashing() {
        val source = redBitmap()

        val bytes = AnnotationRenderer.flatten(
            source,
            listOf(Annotation.Rect(Point(0.1f, 0.1f), 0.5f, 0.5f, "not-a-colour")),
        )

        assertTrue(bytes.isNotEmpty())
    }
}
