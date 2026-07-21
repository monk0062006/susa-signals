package io.markerusa.feedback.survey

import android.app.Activity
import android.content.Context
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
import io.markerusa.feedback.Answer

/**
 * Microsurvey panel.
 *
 * A bottom sheet rather than a full-screen takeover: a research survey
 * interrupts someone who opened the app to do something else, and a takeover
 * converts curiosity into dismissal. One question at a time keeps it small
 * enough to answer without feeling like a form.
 *
 * Partial responses are returned, not discarded. Someone who answers two of four
 * questions and closes has still told the researcher something, and dropping it
 * would bias results toward people with time to finish.
 *
 * Built in code rather than XML: a library shipping layout resources forces
 * resource merging on every host app and risks id collisions.
 */
internal class SurveyPanel(
    private val activity: Activity,
    private val study: Study,
    private val onDone: (answers: List<Answer>, completed: Boolean, durationMs: Long) -> Unit,
    private val onDismiss: () -> Unit
) {
    private companion object {
        const val ACCENT = "#4F46E5"
        const val SURFACE = 0xFFFFFFFF.toInt()
        const val TEXT = 0xFF101828.toInt()
        const val MUTED = 0xFF667085.toInt()
        const val BORDER = 0xFFE4E7EC.toInt()
        const val FIELD_BG = 0xFFF9FAFB.toInt()
    }

    private var root: FrameLayout? = null
    private var index = 0
    private val values = LinkedHashMap<String, Any>()
    private val startedAt = System.currentTimeMillis()

    private lateinit var body: LinearLayout
    private lateinit var progressFill: View
    private lateinit var counter: TextView
    private lateinit var nextButton: Button
    private lateinit var skipButton: Button

    private val density = activity.resources.displayMetrics.density
    private fun dp(value: Int) = (value * density).toInt()

    fun show() {
        val problems = validateStudy(study)
        if (problems.isNotEmpty()) {
            // Loudly at integration time, rather than a blank question shown to
            // a real user.
            android.util.Log.e("MarkerFeedback", "invalid study \"${study.id}\":\n  ${problems.joinToString("\n  ")}")
            onDismiss()
            return
        }

        val content = activity.findViewById<ViewGroup>(android.R.id.content)

        val scrim = FrameLayout(activity).apply {
            setBackgroundColor(0x66000000)
            isClickable = true
            isFocusable = true
            // Tapping the scrim dismisses, matching platform convention for a
            // sheet the user did not ask for.
            setOnClickListener { finish(false) }
        }

        val sheet = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                cornerRadii = floatArrayOf(
                    dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(),
                    0f, 0f, 0f, 0f
                )
                setColor(SURFACE)
            }
            setPadding(dp(20), dp(14), dp(20), dp(18))
            // Swallow taps so they do not reach the dismissing scrim behind.
            isClickable = true
        }

        sheet.addView(buildHeader())
        body = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        sheet.addView(body, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(14) })
        sheet.addView(buildFooter(), LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(16) })

        scrim.addView(sheet, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))
        content.addView(scrim, ViewGroup.LayoutParams(MATCH, MATCH))
        root = scrim

        renderStep()
    }

    private fun dismissView() {
        root?.let { (it.parent as? ViewGroup)?.removeView(it) }
        root = null
    }

    private fun finish(completed: Boolean) {
        val answers = values.map { (questionId, value) -> toAnswer(questionId, value) }
        dismissView()

        // Nothing answered and dismissed: a decline, not a response.
        if (!completed && answers.isEmpty()) {
            onDismiss()
            return
        }
        onDone(answers, completed, System.currentTimeMillis() - startedAt)
    }

    // --- chrome ---------------------------------------------------------------

    private fun buildHeader(): View {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val track = FrameLayout(activity).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(2).toFloat()
                setColor(0xFFF2F4F7.toInt())
            }
        }
        progressFill = View(activity).apply {
            background = GradientDrawable().apply {
                cornerRadius = dp(2).toFloat()
                setColor(Color.parseColor(ACCENT))
            }
        }
        track.addView(progressFill, FrameLayout.LayoutParams(0, dp(3)))

        val close = TextView(activity).apply {
            text = "✕"
            textSize = 15f
            setTextColor(MUTED)
            setPadding(dp(12), dp(4), dp(4), dp(4))
            contentDescription = "Dismiss survey"
            setOnClickListener { finish(false) }
        }

        row.addView(track, LinearLayout.LayoutParams(0, dp(3)).apply { weight = 1f })
        row.addView(close)
        return row
    }

    private fun buildFooter(): View {
        val row = LinearLayout(activity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        counter = TextView(activity).apply {
            textSize = 12f
            setTextColor(0xFF98A2B3.toInt())
        }

        skipButton = Button(activity).apply {
            text = "Skip"
            isAllCaps = false
            textSize = 13f
            setTextColor(MUTED)
            background = GradientDrawable().apply {
                cornerRadius = dp(7).toFloat()
                setColor(Color.TRANSPARENT)
            }
            setOnClickListener { advance(skipped = true) }
        }

        nextButton = Button(activity).apply {
            isAllCaps = false
            textSize = 13f
            setTextColor(Color.WHITE)
            background = GradientDrawable().apply {
                cornerRadius = dp(7).toFloat()
                setColor(Color.parseColor(ACCENT))
            }
            setPadding(dp(18), 0, dp(18), 0)
            setOnClickListener { advance(skipped = false) }
        }

        row.addView(counter, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
        row.addView(skipButton)
        row.addView(nextButton, LinearLayout.LayoutParams(WRAP, WRAP).apply { marginStart = dp(6) })
        return row
    }

    // --- steps ----------------------------------------------------------------

    private fun renderStep() {
        val question = study.questions.getOrNull(index) ?: return
        val total = study.questions.size

        counter.text = "${index + 1} of $total"
        nextButton.text = if (index == total - 1) "Submit" else "Next"
        // A required question cannot be skipped, so the affordance is removed
        // rather than left visible and inert.
        skipButton.visibility = if (question.required) View.GONE else View.VISIBLE

        progressFill.layoutParams = (progressFill.layoutParams as FrameLayout.LayoutParams).apply {
            width = ((activity.resources.displayMetrics.widthPixels - dp(40)) * index / total)
        }
        progressFill.requestLayout()

        body.removeAllViews()
        body.addView(TextView(activity).apply {
            text = question.prompt
            textSize = 16f
            setTextColor(TEXT)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
        })

        question.help?.let {
            body.addView(TextView(activity).apply {
                text = it
                textSize = 13f
                setTextColor(MUTED)
            }, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(4) })
        }

        val input = when (question) {
            is Question.Nps -> scaleView(question.id, 0, 10, question.labels)
            is Question.Rating -> scaleView(question.id, 1, question.scale, question.labels)
            is Question.Choice -> choiceView(question)
            is Question.Text -> textView(question)
        }
        body.addView(input, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(14) })

        syncNext()
    }

    private fun scaleView(
        questionId: String,
        from: Int,
        to: Int,
        labels: Pair<String, String>?
    ): View {
        val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        val row = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
        val buttons = mutableMapOf<Int, Button>()

        fun style(button: Button, on: Boolean) {
            button.background = GradientDrawable().apply {
                cornerRadius = dp(7).toFloat()
                setColor(if (on) Color.parseColor(ACCENT) else Color.TRANSPARENT)
                setStroke(dp(1), if (on) Color.parseColor(ACCENT) else BORDER)
            }
            button.setTextColor(if (on) Color.WHITE else 0xFF475467.toInt())
        }

        for (value in from..to) {
            val button = Button(activity).apply {
                text = value.toString()
                textSize = 13f
                isAllCaps = false
                setPadding(0, 0, 0, 0)
                minWidth = 0
                minimumWidth = 0
                setOnClickListener {
                    values[questionId] = value
                    buttons.forEach { (v, b) -> style(b, v == value) }
                    syncNext()
                }
            }
            style(button, values[questionId] == value)
            buttons[value] = button
            row.addView(button, LinearLayout.LayoutParams(0, dp(40)).apply {
                weight = 1f
                marginEnd = dp(3)
            })
        }

        column.addView(row)

        labels?.let { (low, high) ->
            val ends = LinearLayout(activity).apply { orientation = LinearLayout.HORIZONTAL }
            ends.addView(TextView(activity).apply {
                text = low; textSize = 11f; setTextColor(0xFF98A2B3.toInt())
            }, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
            ends.addView(TextView(activity).apply {
                text = high; textSize = 11f; setTextColor(0xFF98A2B3.toInt()); gravity = Gravity.END
            }, LinearLayout.LayoutParams(0, WRAP).apply { weight = 1f })
            column.addView(ends, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(6) })
        }

        return column
    }

    private fun choiceView(question: Question.Choice): View {
        val column = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        val buttons = mutableMapOf<String, Button>()

        fun style(button: Button, on: Boolean) {
            button.background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(if (on) 0xFFEEF2FF.toInt() else Color.TRANSPARENT)
                setStroke(dp(1), if (on) Color.parseColor(ACCENT) else BORDER)
            }
            button.setTextColor(if (on) 0xFF3730A3.toInt() else 0xFF344054.toInt())
        }

        for (option in question.options) {
            val button = Button(activity).apply {
                text = option
                textSize = 14f
                isAllCaps = false
                gravity = Gravity.START or Gravity.CENTER_VERTICAL
                setPadding(dp(12), dp(10), dp(12), dp(10))
                setOnClickListener {
                    if (question.multiple) {
                        @Suppress("UNCHECKED_CAST")
                        val current = (values[question.id] as? List<String>)?.toMutableList() ?: mutableListOf()
                        if (current.contains(option)) current.remove(option) else current.add(option)

                        if (current.isEmpty()) values.remove(question.id) else values[question.id] = current
                        style(this, current.contains(option))
                    } else {
                        values[question.id] = option
                        buttons.forEach { (o, b) -> style(b, o == option) }
                    }
                    syncNext()
                }
            }

            val selected = if (question.multiple) {
                @Suppress("UNCHECKED_CAST")
                (values[question.id] as? List<String>)?.contains(option) == true
            } else {
                values[question.id] == option
            }
            style(button, selected)

            buttons[option] = button
            column.addView(button, LinearLayout.LayoutParams(MATCH, WRAP).apply { topMargin = dp(6) })
        }

        return column
    }

    private fun textView(question: Question.Text): View =
        EditText(activity).apply {
            hint = question.placeholder ?: "Type your answer…"
            textSize = 14f
            setTextColor(TEXT)
            setHintTextColor(0xFF98A2B3.toInt())
            background = GradientDrawable().apply {
                cornerRadius = dp(8).toFloat()
                setColor(FIELD_BG)
                setStroke(dp(1), BORDER)
            }
            setPadding(dp(11), dp(10), dp(11), dp(10))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
            gravity = Gravity.TOP or Gravity.START
            filters = arrayOf(android.text.InputFilter.LengthFilter(question.maxLength))
            setText(values[question.id] as? String ?: "")

            addTextChangedListener(object : android.text.TextWatcher {
                override fun afterTextChanged(s: android.text.Editable?) {
                    val value = s?.toString().orEmpty()
                    if (value.isBlank()) values.remove(question.id) else values[question.id] = value
                    syncNext()
                }
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            })
        }

    private fun syncNext() {
        val question = study.questions.getOrNull(index) ?: return
        val ok = !question.required || isAnswered(question, values[question.id])
        nextButton.isEnabled = ok
        nextButton.alpha = if (ok) 1f else 0.45f
    }

    private fun advance(skipped: Boolean) {
        val question = study.questions.getOrNull(index)
        if (question != null && skipped) values.remove(question.id)

        if (index >= study.questions.size - 1) {
            showThanks()
            return
        }
        index++
        renderStep()
    }

    private fun showThanks() {
        body.removeAllViews()
        body.addView(TextView(activity).apply {
            text = study.thanks ?: "Thanks — that helps."
            textSize = 15f
            setTextColor(0xFF475467.toInt())
            gravity = Gravity.CENTER
            setPadding(0, dp(18), 0, dp(18))
        })
        counter.visibility = View.GONE
        skipButton.visibility = View.GONE
        nextButton.visibility = View.GONE

        // Resolve now so the host records the response immediately; the sheet
        // lingers only as an acknowledgement.
        val answers = values.map { (questionId, value) -> toAnswer(questionId, value) }
        onDone(answers, true, System.currentTimeMillis() - startedAt)

        body.postDelayed({ dismissView() }, 1600)
    }
}

private const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
private const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
