package io.markerusa.feedback

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Minimal host with a known background colour, so captures can be checked. */
class CaptureTestActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val label = TextView(this).apply {
            text = "capture target"
            setBackgroundColor(Color.rgb(0, 128, 255))
            setTextColor(Color.WHITE)
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        }
        setContentView(label)
    }
}

/**
 * Screenshot capture on real hardware.
 *
 * PixelCopy is the most device-dependent path in the library: it can report
 * success and still hand back an all-black bitmap depending on the window's
 * surface state, and no amount of type-checking catches that. The colour
 * assertions are the point — asserting merely that a Bitmap came back would
 * pass on a black frame.
 */
@RunWith(AndroidJUnit4::class)
class ScreenCaptureInstrumentedTest {

    /**
     * Starts the capture on the UI thread and waits on the *test* thread.
     *
     * PixelCopy delivers its callback on the main looper, so awaiting from
     * inside `onActivity` — which already runs there — deadlocks until the
     * timeout and yields a null bitmap. The capture must be kicked off on the
     * UI thread and awaited from off it.
     */
    private fun capture(scenario: ActivityScenario<CaptureTestActivity>): Bitmap? {
        val latch = CountDownLatch(1)
        // AtomicReference rather than @Volatile: the annotation is not allowed on
        // a local, and the write happens on the main thread while the read
        // happens on the test thread.
        val result = java.util.concurrent.atomic.AtomicReference<Bitmap?>(null)

        scenario.onActivity { activity ->
            ScreenCapture.capture(activity) { bitmap ->
                result.set(bitmap)
                latch.countDown()
            }
        }

        assertTrue("capture never invoked its callback", latch.await(10, TimeUnit.SECONDS))
        return result.get()
    }

    /** Lets the window render a frame before it is captured. */
    private fun settle() = Thread.sleep(800)

    @Test
    fun capturesTheWindowAtItsRealSize() {
        ActivityScenario.launch(CaptureTestActivity::class.java).use { scenario ->
            settle()

            var width = 0
            var height = 0
            scenario.onActivity { activity ->
                width = activity.window.decorView.width
                height = activity.window.decorView.height
            }

            val bitmap = capture(scenario)

            assertNotNull("capture returned null", bitmap)
            assertEquals("captured width does not match the window", width, bitmap!!.width)
            assertEquals("captured height does not match the window", height, bitmap.height)
        }
    }

    @Test
    fun capturedContentIsNotBlank() {
        ActivityScenario.launch(CaptureTestActivity::class.java).use { scenario ->
            settle()

            val bitmap = capture(scenario)
            assertNotNull("capture returned null", bitmap)

            // Sample the middle of the window, well inside the coloured view.
            val pixel = bitmap!!.getPixel(bitmap.width / 2, bitmap.height / 2)

            // A silently-failing PixelCopy returns a fully black or transparent
            // frame — exactly the bug this test exists to catch.
            assertTrue(
                "captured frame is blank — PixelCopy likely failed silently (pixel=$pixel)",
                Color.alpha(pixel) > 0 &&
                    (Color.red(pixel) + Color.green(pixel) + Color.blue(pixel)) > 30,
            )
        }
    }

    @Test
    fun captureEncodesToAUsablePng() {
        ActivityScenario.launch(CaptureTestActivity::class.java).use { scenario ->
            settle()

            val bitmap = capture(scenario)
            assertNotNull("capture returned null", bitmap)

            val bytes = ScreenCapture.encode(bitmap!!)
            assertTrue("PNG encoding produced nothing", bytes.size > 1000)

            // PNG magic number: proves it is a real image, not an empty buffer.
            assertEquals(0x89.toByte(), bytes[0])
            assertEquals('P'.code.toByte(), bytes[1])
            assertEquals('N'.code.toByte(), bytes[2])
            assertEquals('G'.code.toByte(), bytes[3])
        }
    }
}
