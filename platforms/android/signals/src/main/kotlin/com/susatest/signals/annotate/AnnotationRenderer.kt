package com.susatest.signals.annotate

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import com.susatest.signals.Annotation
import java.io.ByteArrayOutputStream
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * Draws annotations onto a canvas, and flattens them into the screenshot bytes.
 *
 * `flatten` is the security-relevant path: redactions must be burned into the
 * pixels before upload. Transmitting a clean screenshot plus a "blur this region"
 * instruction would send the very data the user asked to hide, and would leave it
 * recoverable by anyone who reads the raw attachment.
 */
internal object AnnotationRenderer {

    private const val ARROW_HEAD_PX = 28f

    /** Solid fill, not a Gaussian blur: blur is reversible enough to be unsafe. */
    private val redactionColor = Color.parseColor("#11141A")

    fun draw(canvas: Canvas, annotations: List<Annotation>, rect: ImageRect) {
        for (annotation in annotations) {
            drawOne(canvas, annotation, rect)
        }
    }

    private fun drawOne(canvas: Canvas, annotation: Annotation, rect: ImageRect) {
        when (annotation) {
            is Annotation.Rect -> {
                val paint = strokePaint(annotation.color, 6f)
                val (left, top) = AnnotationGeometry.toView(annotation.origin, rect)
                canvas.drawRect(
                    left,
                    top,
                    left + annotation.width * rect.width,
                    top + annotation.height * rect.height,
                    paint
                )
            }

            is Annotation.Blur -> {
                val paint = Paint().apply {
                    color = redactionColor
                    style = Paint.Style.FILL
                    isAntiAlias = true
                }
                val (left, top) = AnnotationGeometry.toView(annotation.origin, rect)
                canvas.drawRect(
                    left,
                    top,
                    left + annotation.width * rect.width,
                    top + annotation.height * rect.height,
                    paint
                )
            }

            is Annotation.Arrow -> {
                val paint = strokePaint(annotation.color, 6f)
                val (x1, y1) = AnnotationGeometry.toView(annotation.from, rect)
                val (x2, y2) = AnnotationGeometry.toView(annotation.to, rect)
                canvas.drawLine(x1, y1, x2, y2, paint)

                // Filled triangle head.
                val angle = atan2((y2 - y1).toDouble(), (x2 - x1).toDouble())
                val head = Path().apply {
                    moveTo(x2, y2)
                    lineTo(
                        x2 - (ARROW_HEAD_PX * cos(angle - Math.PI / 6)).toFloat(),
                        y2 - (ARROW_HEAD_PX * sin(angle - Math.PI / 6)).toFloat()
                    )
                    lineTo(
                        x2 - (ARROW_HEAD_PX * cos(angle + Math.PI / 6)).toFloat(),
                        y2 - (ARROW_HEAD_PX * sin(angle + Math.PI / 6)).toFloat()
                    )
                    close()
                }
                canvas.drawPath(head, fillPaint(annotation.color))
            }

            is Annotation.Pen -> {
                if (annotation.points.size < 2) return
                val paint = strokePaint(annotation.color, annotation.strokeWidth * 2f).apply {
                    strokeJoin = Paint.Join.ROUND
                    strokeCap = Paint.Cap.ROUND
                }
                val path = Path()
                annotation.points.forEachIndexed { index, point ->
                    val (x, y) = AnnotationGeometry.toView(point, rect)
                    if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                canvas.drawPath(path, paint)
            }
        }
    }

    /**
     * Burns annotations into the screenshot and re-encodes it.
     *
     * Renders at full bitmap resolution rather than at the on-screen preview size,
     * so a redaction the user drew over a 1080px-wide preview covers the same
     * region on the 2400px original. Rendering at preview scale would leave the
     * sensitive pixels partially exposed at the edges.
     */
    fun flatten(source: Bitmap, annotations: List<Annotation>): ByteArray {
        // Copy: the source may be referenced elsewhere, and mutating a caller's
        // bitmap is how you get a redacted preview but an unredacted upload.
        val flattened = source.copy(Bitmap.Config.ARGB_8888, true)
        val canvas = Canvas(flattened)

        // Full-bitmap rect: normalized coords map directly onto the real pixels.
        val rect = ImageRect(0f, 0f, flattened.width.toFloat(), flattened.height.toFloat())
        draw(canvas, annotations, rect)

        val out = ByteArrayOutputStream()
        flattened.compress(Bitmap.CompressFormat.PNG, 100, out)
        return out.toByteArray()
    }

    private fun strokePaint(color: String, width: Float) = Paint().apply {
        this.color = parseColor(color)
        style = Paint.Style.STROKE
        strokeWidth = width
        isAntiAlias = true
    }

    private fun fillPaint(color: String) = Paint().apply {
        this.color = parseColor(color)
        style = Paint.Style.FILL
        isAntiAlias = true
    }

    /** Falls back rather than throwing: a bad colour must not lose the report. */
    private fun parseColor(value: String): Int =
        try {
            Color.parseColor(value)
        } catch (e: IllegalArgumentException) {
            Color.RED
        }
}
