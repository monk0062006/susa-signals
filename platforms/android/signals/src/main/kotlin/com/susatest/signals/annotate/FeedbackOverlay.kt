package com.susatest.signals.annotate

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.susatest.signals.Annotation

/**
 * The report composer: annotate the screenshot, describe the problem, send.
 *
 * Built programmatically rather than from XML layouts. A library shipping layout
 * resources forces resource merging on every host app and risks id collisions;
 * views in code keep the AAR self-contained.
 *
 * Attaches to the Activity's content view instead of launching an Activity of its
 * own, so integrating the SDK needs no manifest entry from the customer.
 */
internal class FeedbackOverlay(
    private val activity: Activity,
    private val screenshot: Bitmap,
    private val onSend: (title: String, description: String?, annotations: List<Annotation>, flattened: ByteArray) -> Unit,
    private val onCancel: () -> Unit
) {
    private companion object {
        const val ACCENT = "#3B82F6"
        const val MARK_COLOR = "#FF3B30"
        const val PANEL_BG = 0xFF1C1F26.toInt()
        const val FIELD_BG = 0xFF12151B.toInt()
        const val TEXT = 0xFFF4F5F7.toInt()
        const val MUTED = 0xFF8B93A1.toInt()
    }

    private var root: FrameLayout? = null
    private lateinit var canvasView: AnnotationCanvasView

    fun show() {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()

        val overlay = FrameLayout(activity).apply {
            setBackgroundColor(0xD10F1115.toInt())
            // Consume touches so taps never fall through to the app being reported.
            isClickable = true
            isFocusable = true
        }

        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(24), dp(16), dp(16))
        }

        canvasView = AnnotationCanvasView(activity, screenshot, MARK_COLOR)
        column.addView(
            canvasView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0
            ).apply { weight = 1f }
        )

        column.addView(buildToolbar(::dp), rowParams(dp(12)))
        column.addView(buildFields(::dp), rowParams(dp(12)))
        column.addView(buildActions(::dp), rowParams(dp(12)))

        overlay.addView(column, FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))

        content.addView(overlay, ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ))
        root = overlay
    }

    fun dismiss() {
        root?.let { (it.parent as? ViewGroup)?.removeView(it) }
        root = null
    }

    // --- pieces ---------------------------------------------------------------

    private lateinit var titleField: EditText
    private lateinit var descriptionField: EditText

    private fun rowParams(topMargin: Int) = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { setMargins(0, topMargin, 0, 0) }

    private fun buildToolbar(dp: (Int) -> Int): View {
        val row = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val buttons = mutableMapOf<Tool, Button>()

        fun styleButton(button: Button, active: Boolean) {
            button.background = GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(if (active) Color.parseColor(ACCENT) else Color.TRANSPARENT)
                setStroke(dp(1), if (active) Color.parseColor(ACCENT) else 0xFF363B45.toInt())
            }
            button.setTextColor(if (active) Color.WHITE else 0xFFC7CCD6.toInt())
        }

        val tools = listOf(
            Tool.RECT to "Box",
            Tool.ARROW to "Arrow",
            Tool.PEN to "Pen",
            Tool.BLUR to "Redact"
        )

        for ((tool, label) in tools) {
            val button = Button(activity).apply {
                text = label
                textSize = 13f
                isAllCaps = false
                setPadding(dp(10), dp(6), dp(10), dp(6))
                setOnClickListener {
                    canvasView.tool = tool
                    buttons.forEach { (key, b) -> styleButton(b, key == tool) }
                }
            }
            styleButton(button, tool == Tool.RECT)
            buttons[tool] = button
            row.addView(button, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                weight = 1f
                marginEnd = dp(6)
            })
        }

        val undo = Button(activity).apply {
            text = "Undo"
            textSize = 13f
            isAllCaps = false
            setTextColor(0xFFC7CCD6.toInt())
            background = GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.TRANSPARENT)
                setStroke(dp(1), 0xFF363B45.toInt())
            }
            setOnClickListener { canvasView.undo() }
        }
        row.addView(undo, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply { weight = 1f })

        return row
    }

    private fun buildFields(dp: (Int) -> Int): View {
        val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

        fun fieldBackground() = GradientDrawable().apply {
            cornerRadius = dp(6).toFloat()
            setColor(FIELD_BG)
            setStroke(dp(1), 0xFF363B45.toInt())
        }

        titleField = EditText(activity).apply {
            hint = "Brief summary of the issue"
            setHintTextColor(MUTED)
            setTextColor(TEXT)
            textSize = 15f
            background = fieldBackground()
            setPadding(dp(10), dp(10), dp(10), dp(10))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            maxLines = 1
        }

        descriptionField = EditText(activity).apply {
            hint = "Steps to reproduce…"
            setHintTextColor(MUTED)
            setTextColor(TEXT)
            textSize = 15f
            background = fieldBackground()
            setPadding(dp(10), dp(10), dp(10), dp(10))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2
            maxLines = 4
            gravity = Gravity.TOP or Gravity.START
        }

        val hint = TextView(activity).apply {
            text = "Use Redact to cover sensitive data before sending."
            setTextColor(MUTED)
            textSize = 12f
        }

        column.addView(titleField, rowParams(0))
        column.addView(descriptionField, rowParams(dp(8)))
        column.addView(hint, rowParams(dp(6)))
        return column
    }

    private fun buildActions(dp: (Int) -> Int): View {
        val row = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }

        val send = Button(activity).apply {
            text = "Send report"
            isAllCaps = false
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.parseColor(ACCENT))
            }
            setOnClickListener { attemptSend() }
        }

        val cancel = Button(activity).apply {
            text = "Cancel"
            isAllCaps = false
            setTextColor(0xFFC7CCD6.toInt())
            background = GradientDrawable().apply {
                cornerRadius = dp(6).toFloat()
                setColor(Color.TRANSPARENT)
                setStroke(dp(1), 0xFF363B45.toInt())
            }
            setOnClickListener {
                dismiss()
                onCancel()
            }
        }

        row.addView(send, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            weight = 2f
            marginEnd = dp(8)
        })
        row.addView(cancel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT).apply { weight = 1f })
        return row
    }

    private fun attemptSend() {
        val title = titleField.text.toString().trim()
        if (title.isEmpty()) {
            // An untitled report is unusable in a triage queue; block rather than guess.
            titleField.error = "Required"
            titleField.requestFocus()
            return
        }

        val description = descriptionField.text.toString().trim().ifEmpty { null }
        val annotations = canvasView.annotations.toList()

        // Flatten on the main thread before dismissing: the view owns the bitmap,
        // and tearing it down first would race the encode.
        val flattened = canvasView.flatten()

        dismiss()
        onSend(title, description, annotations, flattened)
    }
}
