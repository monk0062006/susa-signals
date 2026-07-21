package com.susatest.signals.annotate

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.view.MotionEvent
import android.view.View
import com.susatest.signals.Annotation
import com.susatest.signals.Point

/**
 * The drawable screenshot surface.
 *
 * Holds annotations in normalized 0..1 coordinates and converts on the way in and
 * out, so what the user draws over a scaled preview lands correctly on the
 * full-resolution original.
 */
@SuppressLint("ViewConstructor")
internal class AnnotationCanvasView(
    context: Context,
    private val screenshot: Bitmap,
    private val color: String
) : View(context) {

    val annotations = mutableListOf<Annotation>()
    var tool: Tool = Tool.RECT

    private var dragStart: Point? = null
    private var dragCurrent: Point? = null
    private val penPoints = mutableListOf<Point>()
    private val bitmapPaint = Paint().apply { isFilterBitmap = true; isAntiAlias = true }

    private var imageRect = ImageRect(0f, 0f, 0f, 0f)

    fun undo() {
        if (annotations.isNotEmpty()) {
            annotations.removeAt(annotations.size - 1)
            invalidate()
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        imageRect = AnnotationGeometry.fitRect(
            w.toFloat(),
            h.toFloat(),
            screenshot.width.toFloat(),
            screenshot.height.toFloat()
        )
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (imageRect.width <= 0f) return

        canvas.drawBitmap(
            screenshot,
            null,
            android.graphics.RectF(
                imageRect.left,
                imageRect.top,
                imageRect.left + imageRect.width,
                imageRect.top + imageRect.height
            ),
            bitmapPaint
        )

        AnnotationRenderer.draw(canvas, annotations, imageRect)

        // Render the in-progress shape without committing it, so the user sees
        // what they are about to create.
        inProgress()?.let { AnnotationRenderer.draw(canvas, listOf(it), imageRect) }
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val point = AnnotationGeometry.toNormalized(event.x, event.y, imageRect)

        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragStart = point
                dragCurrent = point
                penPoints.clear()
                if (tool == Tool.PEN) penPoints.add(point)
                // Claim the gesture so the parent scroll container cannot steal it
                // mid-stroke, which would truncate every drawing.
                parent?.requestDisallowInterceptTouchEvent(true)
                invalidate()
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                dragCurrent = point
                if (tool == Tool.PEN) penPoints.add(point)
                invalidate()
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                // Commit on UP only. Committing on CANCEL would create shapes from
                // gestures the system took over (a back-swipe, a notification pull).
                if (event.actionMasked == MotionEvent.ACTION_UP) {
                    inProgress()?.let { annotations.add(it) }
                }
                dragStart = null
                dragCurrent = null
                penPoints.clear()
                parent?.requestDisallowInterceptTouchEvent(false)
                invalidate()
                return true
            }
        }

        return super.onTouchEvent(event)
    }

    private fun inProgress(): Annotation? {
        val start = dragStart ?: return null
        val current = dragCurrent ?: return null
        return AnnotationGeometry.build(tool, start, current, penPoints, color)
    }

    /** Burns the committed annotations into the screenshot for upload. */
    fun flatten(): ByteArray = AnnotationRenderer.flatten(screenshot, annotations)
}
