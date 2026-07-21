package com.susatest.signals

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.susatest.signals.survey.Question
import com.susatest.signals.survey.Study
import com.susatest.signals.survey.SurveyPanel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Bare host for the survey sheet. */
class SurveyTestActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
        })
    }
}

/**
 * The survey sheet on real hardware.
 *
 * Unit tests cover validation and serialization; they cannot tell you the sheet
 * renders, that a required question actually blocks Next, or that tapping
 * through produces the answers the researcher will read. Those only exist once
 * views are inflated on a device.
 */
@RunWith(AndroidJUnit4::class)
class SurveyPanelInstrumentedTest {

    private val study = Study(
        id = "instrumented-study",
        name = "Checkout experience",
        questions = listOf(
            Question.Nps(
                id = "nps",
                prompt = "How likely are you to recommend us?",
                required = true,
                labels = "Not likely" to "Very likely",
            ),
            Question.Choice(
                id = "blocker",
                prompt = "What got in your way?",
                options = listOf("Payment failed", "Confusing pricing", "Nothing"),
                multiple = true,
            ),
            Question.Text(id = "why", prompt = "Anything else?"),
        ),
        thanks = "Thanks — that helps.",
    )

    /** Depth-first search for a view whose text matches. */
    private fun findByText(root: View, text: String): View? {
        if (root is TextView && root.text?.toString() == text) return root
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) {
                findByText(root.getChildAt(i), text)?.let { return it }
            }
        }
        return null
    }

    private fun collect(root: View, into: MutableList<View>) {
        into.add(root)
        if (root is ViewGroup) for (i in 0 until root.childCount) collect(root.getChildAt(i), into)
    }

    private fun allViews(activity: Activity): List<View> {
        val out = mutableListOf<View>()
        collect(activity.window.decorView, out)
        return out
    }

    private fun show(
        scenario: ActivityScenario<SurveyTestActivity>,
        onDone: (List<Answer>, Boolean, Long) -> Unit = { _, _, _ -> },
        onDismiss: () -> Unit = {},
    ) {
        scenario.onActivity { activity ->
            SurveyPanel(activity, study, onDone, onDismiss).show()
        }
        Thread.sleep(600)
    }

    @Test
    fun panelRendersTheFirstQuestion() {
        ActivityScenario.launch(SurveyTestActivity::class.java).use { scenario ->
            show(scenario)

            scenario.onActivity { activity ->
                assertNotNull(
                    "first question not rendered",
                    findByText(activity.window.decorView, "How likely are you to recommend us?"),
                )
                // NPS is 0..10 inclusive — eleven buttons, not ten.
                val scaleButtons = allViews(activity)
                    .filterIsInstance<Button>()
                    .filter { it.text?.toString()?.toIntOrNull() != null }
                assertEquals("expected an 11-point NPS scale", 11, scaleButtons.size)
            }
        }
    }

    @Test
    fun requiredQuestionBlocksNextUntilAnswered() {
        ActivityScenario.launch(SurveyTestActivity::class.java).use { scenario ->
            show(scenario)

            scenario.onActivity { activity ->
                val next = allViews(activity).filterIsInstance<Button>()
                    .first { it.text?.toString() == "Next" }
                assertFalse("Next should be disabled before answering", next.isEnabled)

                // Answer 9.
                allViews(activity).filterIsInstance<Button>()
                    .first { it.text?.toString() == "9" }
                    .performClick()

                assertTrue("Next should enable once answered", next.isEnabled)
            }
        }
    }

    @Test
    fun tappingThroughProducesTheExpectedAnswers() {
        ActivityScenario.launch(SurveyTestActivity::class.java).use { scenario ->
            val captured = AtomicReference<List<Answer>>(emptyList())
            val completedFlag = AtomicReference(false)
            val latch = CountDownLatch(1)

            show(scenario, onDone = { answers, completed, _ ->
                captured.set(answers)
                completedFlag.set(completed)
                latch.countDown()
            })

            // Q1: NPS 9
            scenario.onActivity { activity ->
                allViews(activity).filterIsInstance<Button>().first { it.text?.toString() == "9" }.performClick()
                allViews(activity).filterIsInstance<Button>().first { it.text?.toString() == "Next" }.performClick()
            }
            Thread.sleep(300)

            // Q2: two options, exercising multi-select
            scenario.onActivity { activity ->
                allViews(activity).filterIsInstance<Button>()
                    .first { it.text?.toString() == "Payment failed" }.performClick()
                allViews(activity).filterIsInstance<Button>()
                    .first { it.text?.toString() == "Confusing pricing" }.performClick()
                allViews(activity).filterIsInstance<Button>()
                    .first { it.text?.toString() == "Next" }.performClick()
            }
            Thread.sleep(300)

            // Q3: free text, then Submit
            scenario.onActivity { activity ->
                allViews(activity).filterIsInstance<EditText>().first().setText("checkout kept failing")
                allViews(activity).filterIsInstance<Button>()
                    .first { it.text?.toString() == "Submit" }.performClick()
            }

            assertTrue("onDone never fired", latch.await(5, TimeUnit.SECONDS))

            val answers = captured.get()
            assertTrue(completedFlag.get())
            assertEquals(3, answers.size)

            assertEquals("9", answers.first { it.questionId == "nps" }.value)
            assertEquals("checkout kept failing", answers.first { it.questionId == "why" }.value)

            // The multi-choice answer must be an array. A joined string would
            // aggregate to zero in the dashboard while looking valid on the wire.
            val blocker = answers.first { it.questionId == "blocker" }
            assertEquals(listOf("Payment failed", "Confusing pricing"), blocker.values)
        }
    }

    @Test
    fun dismissingAfterOneAnswerKeepsThePartial() {
        ActivityScenario.launch(SurveyTestActivity::class.java).use { scenario ->
            val captured = AtomicReference<List<Answer>>(emptyList())
            val completedFlag = AtomicReference(true)
            val latch = CountDownLatch(1)

            show(scenario, onDone = { answers, completed, _ ->
                captured.set(answers)
                completedFlag.set(completed)
                latch.countDown()
            })

            scenario.onActivity { activity ->
                allViews(activity).filterIsInstance<Button>().first { it.text?.toString() == "7" }.performClick()
                // The close affordance.
                findByText(activity.window.decorView, "✕")?.performClick()
            }

            assertTrue("partial was not reported", latch.await(5, TimeUnit.SECONDS))

            // Kept, and marked incomplete. Discarding partials would bias
            // results toward people with time to finish.
            assertEquals(1, captured.get().size)
            assertFalse("a dismissed survey is not completed", completedFlag.get())
        }
    }

    @Test
    fun dismissingWithoutAnsweringIsADeclineNotAResponse() {
        ActivityScenario.launch(SurveyTestActivity::class.java).use { scenario ->
            val dismissed = CountDownLatch(1)
            val doneFired = AtomicReference(false)

            show(
                scenario,
                onDone = { _, _, _ -> doneFired.set(true) },
                onDismiss = { dismissed.countDown() },
            )

            scenario.onActivity { activity ->
                findByText(activity.window.decorView, "✕")?.performClick()
            }

            assertTrue("onDismiss never fired", dismissed.await(5, TimeUnit.SECONDS))
            assertFalse("an empty dismissal must not submit a response", doneFired.get())
        }
    }
}
