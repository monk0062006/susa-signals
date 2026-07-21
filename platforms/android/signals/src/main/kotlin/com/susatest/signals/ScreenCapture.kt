package com.susatest.signals

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import java.io.ByteArrayOutputStream

/**
 * Screenshot capture — the native counterpart to web's DOM rasterization.
 *
 * `View.draw()` into a bitmap silently produces black or blank regions for
 * anything hardware-accelerated: video, MapView, GL surfaces, and Compose content
 * backed by a SurfaceView. PixelCopy reads the actual composited window instead,
 * which is why it is the primary path and API 24 is the floor.
 */
internal object ScreenCapture {

    /**
     * Hands back the raw Bitmap rather than encoded bytes, because the annotation
     * overlay needs to draw on it. Encoding happens once, after the user has
     * finished annotating — encoding here would waste a PNG compress on an image
     * that is about to be redrawn anyway.
     */
    fun capture(activity: Activity, callback: (Bitmap?) -> Unit) {
        val window = activity.window
        val view = window.decorView

        if (view.width == 0 || view.height == 0) {
            // Called before layout; nothing meaningful to capture.
            callback(null)
            return
        }

        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)

        // PixelCopy needs a window with a valid surface. It exists from API 24 but
        // only became reliable for the whole decor view later; fall back on failure
        // rather than shipping a black screenshot.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PixelCopy.request(
                    window,
                    Rect(0, 0, view.width, view.height),
                    bitmap,
                    { result ->
                        if (result == PixelCopy.SUCCESS) {
                            callback(bitmap)
                        } else {
                            callback(drawFallback(view, bitmap))
                        }
                    },
                    Handler(Looper.getMainLooper())
                )
                return
            } catch (e: IllegalArgumentException) {
                // Window not yet attached to a surface.
            }
        }

        callback(drawFallback(view, bitmap))
    }

    /** Software draw. Loses hardware-accelerated content — accepted over failing. */
    private fun drawFallback(view: View, bitmap: Bitmap): Bitmap? {
        return try {
            view.draw(Canvas(bitmap))
            bitmap
        } catch (e: Exception) {
            null
        }
    }

    /** PNG: lossy artifacts around UI text make a bug report harder to read. */
    fun encode(bitmap: Bitmap): ByteArray {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }
}
