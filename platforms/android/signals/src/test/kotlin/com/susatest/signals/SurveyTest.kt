package com.susatest.signals

import com.susatest.signals.survey.Question
import com.susatest.signals.survey.Study
import com.susatest.signals.survey.isAnswered
import com.susatest.signals.survey.toAnswer
import com.susatest.signals.survey.validateStudy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Study validation and answer serialization.
 *
 * Mirrors the rules in `packages/core/src/study.ts`; divergence between the two
 * is the first sign the platforms have drifted on what a question means.
 */
class SurveyTest {

    private fun study(vararg questions: Question) =
        Study(id = "s1", name = "Study", questions = questions.toList())

    @Test
    fun `a well-formed study validates`() {
        val problems = validateStudy(
            study(
                Question.Nps(id = "nps", prompt = "How likely?"),
                Question.Text(id = "why", prompt = "Why?")
            )
        )
        assertTrue(problems.toString(), problems.isEmpty())
    }

    @Test
    fun `a study with no questions is rejected`() {
        assertTrue(validateStudy(study()).any { it.contains("at least one question") })
    }

    @Test
    fun `duplicate question ids are rejected`() {
        val problems = validateStudy(
            study(
                Question.Nps(id = "same", prompt = "First"),
                Question.Text(id = "same", prompt = "Second")
            )
        )
        // Duplicates silently overwrite in the answer map, losing a response
        // with no error anywhere.
        assertTrue(problems.any { it.contains("duplicate") })
    }

    @Test
    fun `a rating scale outside 2 to 10 is rejected`() {
        assertTrue(validateStudy(study(Question.Rating(id = "r", prompt = "Rate", scale = 1)))
            .any { it.contains("scale") })
        assertTrue(validateStudy(study(Question.Rating(id = "r", prompt = "Rate", scale = 50)))
            .any { it.contains("scale") })
    }

    @Test
    fun `duplicate choice options are rejected`() {
        val problems = validateStudy(
            study(Question.Choice(id = "c", prompt = "Pick", options = listOf("A", "B", "A")))
        )
        // Duplicate labels make the choice breakdown ambiguous.
        assertTrue(problems.any { it.contains("unique") })
    }

    @Test
    fun `required questions gate on being answered`() {
        val nps = Question.Nps(id = "nps", prompt = "How likely?", required = true)
        assertFalse(isAnswered(nps, null))
        assertTrue(isAnswered(nps, 9))

        val text = Question.Text(id = "t", prompt = "Why?", required = true)
        assertFalse(isAnswered(text, "   "))
        assertTrue(isAnswered(text, "because"))

        val multi = Question.Choice(id = "c", prompt = "Pick", options = listOf("A"), multiple = true)
        assertFalse(isAnswered(multi, emptyList<String>()))
        assertTrue(isAnswered(multi, listOf("A")))
    }

    @Test
    fun `multi-choice serializes as an array, not a joined string`() {
        val answer = toAnswer("blocker", listOf("Payment failed", "Confusing pricing"))

        // This is the one that matters. The dashboard counts by matching exact
        // option strings, so "Payment failed, Confusing pricing" would match
        // neither option and aggregate to zero while looking valid on the wire.
        assertNull("multi-choice must not use the scalar field", answer.value)
        assertEquals(listOf("Payment failed", "Confusing pricing"), answer.values)
    }

    @Test
    fun `single choice serializes as a scalar`() {
        val answer = toAnswer("blocker", "Payment failed")
        assertEquals("Payment failed", answer.value)
        assertNull(answer.values)
    }

    @Test
    fun `numeric answers serialize as their value`() {
        assertEquals("9", toAnswer("nps", 9).value)
    }

    @Test
    fun `a multi-choice answer survives the full submission payload`() {
        val submission = Submission(
            projectId = "proj",
            payload = SubmissionPayload.ResearchResponse(
                studyId = "s1",
                answers = listOf(
                    toAnswer("blocker", listOf("Payment failed", "Missing feature")),
                    toAnswer("nps", 9)
                ),
                completed = true
            ),
            device = DeviceContext(sdkVersion = "0.0.0")
        )

        val json = submission.toJson()
        // Array form on the wire, matching web.
        assertTrue(json, json.contains("""["Payment failed","Missing feature"]"""))
        assertTrue(json, json.contains(""""value":"9""""))
    }
}
