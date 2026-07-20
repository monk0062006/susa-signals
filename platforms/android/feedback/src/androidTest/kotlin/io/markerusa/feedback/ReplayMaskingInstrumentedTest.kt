package io.markerusa.feedback

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.markerusa.feedback.replay.FrameMasker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** A screen containing exactly the field types a recorder must never capture. */
class MaskingTestActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
            layoutParams = ViewGroup.LayoutParams(MATCH, MATCH)
        }

        column.addView(TextView(this).apply {
            text = "ordinary label"
            id = ID_PUBLIC
            setBackgroundColor(Color.rgb(0, 200, 0))
            layoutParams = ViewGroup.LayoutParams(MATCH, 200)
        })

        column.addView(EditText(this).apply {
            id = ID_PASSWORD
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            setText("hunter2")
            setBackgroundColor(Color.rgb(200, 0, 0))
            layoutParams = ViewGroup.LayoutParams(MATCH, 200)
        })

        column.addView(EditText(this).apply {
            id = ID_TAGGED
            tag = FrameMasker.PRIVATE_TAG
            setText("secret note")
            setBackgroundColor(Color.rgb(0, 0, 200))
            layoutParams = ViewGroup.LayoutParams(MATCH, 200)
        })

        setContentView(column)
    }

    companion object {
        const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
        const val ID_PUBLIC = 1001
        const val ID_PASSWORD = 1002
        const val ID_TAGGED = 1003
    }
}

/**
 * Replay masking, verified on hardware by reading pixels back.
 *
 * The recorder captures frames rather than DOM mutations, so nothing about
 * masking is structural — it is pixels painted over pixels. That makes this the
 * only way to know it works, and it is the highest-stakes assertion in the
 * Android library: a gap here streams a password to a server continuously,
 * rather than once.
 */
@RunWith(AndroidJUnit4::class)
class ReplayMaskingInstrumentedTest {

    @Test
    fun passwordFieldsAreDetectedAsSensitive() {
        ActivityScenario.launch(MaskingTestActivity::class.java).use { scenario ->
            Thread.sleep(600)

            var regions = 0
            scenario.onActivity { activity ->
                val decor = activity.window.decorView
                regions = FrameMasker.sensitiveRegions(decor).size
            }

            // Password field and tagged field; the plain label must not match.
            assertEquals("expected exactly two sensitive regions", 2, regions)
        }
    }

    @Test
    fun maskingPaintsOverSensitiveRegionsOnly() {
        ActivityScenario.launch(MaskingTestActivity::class.java).use { scenario ->
            Thread.sleep(600)

            var result: Bitmap? = null
            var publicRect: android.graphics.Rect? = null
            var passwordRect: android.graphics.Rect? = null

            scenario.onActivity { activity ->
                val decor = activity.window.decorView
                val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
                decor.draw(Canvas(bitmap))

                val regions = FrameMasker.sensitiveRegions(decor)
                FrameMasker.apply(Canvas(bitmap), regions, scale = 1f)

                fun rectOf(id: Int): android.graphics.Rect {
                    val view: View = activity.findViewById(id)
                    val loc = IntArray(2)
                    view.getLocationInWindow(loc)
                    return android.graphics.Rect(loc[0], loc[1], loc[0] + view.width, loc[1] + view.height)
                }

                publicRect = rectOf(MaskingTestActivity.ID_PUBLIC)
                passwordRect = rectOf(MaskingTestActivity.ID_PASSWORD)
                result = bitmap
            }

            val bitmap = requireNotNull(result)
            val pub = requireNotNull(publicRect)
            val pwd = requireNotNull(passwordRect)

            val publicPixel = bitmap.getPixel(pub.centerX(), pub.centerY())
            val passwordPixel = bitmap.getPixel(pwd.centerX(), pwd.centerY())

            // The password field must be painted over...
            assertTrue(
                "password field was not masked (pixel=$passwordPixel)",
                Color.red(passwordPixel) < 60 &&
                    Color.green(passwordPixel) < 60 &&
                    Color.blue(passwordPixel) < 60,
            )
            // ...and the ordinary label must survive, or masking is just a
            // black rectangle over the whole screen and proves nothing.
            assertTrue(
                "ordinary content was masked too (pixel=$publicPixel)",
                Color.green(publicPixel) > 120,
            )
        }
    }

    @Test
    fun webViewsAreTreatedAsSensitiveWholesale() {
        ActivityScenario.launch(MaskingTestActivity::class.java).use { scenario ->
            Thread.sleep(400)

            var before = 0
            var after = 0
            scenario.onActivity { activity ->
                val root = activity.findViewById<View>(MaskingTestActivity.ID_PUBLIC).parent as ViewGroup
                before = FrameMasker.sensitiveRegions(activity.window.decorView).size

                // A WebView renders remote content the SDK cannot inspect, so
                // its contents are unknowable and must be excluded entirely.
                root.addView(WebView(activity).apply {
                    layoutParams = ViewGroup.LayoutParams(MaskingTestActivity.MATCH, 150)
                })
                root.requestLayout()
            }

            Thread.sleep(500)
            scenario.onActivity { activity ->
                after = FrameMasker.sensitiveRegions(activity.window.decorView).size
            }

            assertEquals("WebView was not treated as sensitive", before + 1, after)
        }
    }

    @Test
    fun invisibleViewsAreNotMasked() {
        ActivityScenario.launch(MaskingTestActivity::class.java).use { scenario ->
            Thread.sleep(400)

            var visibleCount = 0
            var hiddenCount = 0
            scenario.onActivity { activity ->
                visibleCount = FrameMasker.sensitiveRegions(activity.window.decorView).size
                activity.findViewById<View>(MaskingTestActivity.ID_PASSWORD).visibility = View.GONE
            }

            Thread.sleep(400)
            scenario.onActivity { activity ->
                hiddenCount = FrameMasker.sensitiveRegions(activity.window.decorView).size
            }

            // Nothing is drawn, so nothing needs covering.
            assertEquals(visibleCount - 1, hiddenCount)
        }
    }
}
