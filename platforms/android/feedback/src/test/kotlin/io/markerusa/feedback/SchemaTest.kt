package io.markerusa.feedback

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The schema is hand-mirrored from TypeScript, so serialization is where drift
 * between platforms would first show up. These assert on the exact wire text.
 */
class SchemaTest {

    private fun submission(payload: SubmissionPayload) = Submission(
        id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        projectId = "proj_test",
        payload = payload,
        device = DeviceContext(sdkVersion = "0.0.0", osVersion = "14", deviceModel = "Pixel 8"),
        createdAt = 1_750_000_000_000
    )

    @Test
    fun `bug report serializes with discriminated payload type`() {
        val json = submission(
            SubmissionPayload.BugReport(ReportKind.BUG, "Checkout fails", "Tapping Pay does nothing")
        ).toJson()

        assertTrue(json.contains("\"type\":\"bug_report\""))
        assertTrue(json.contains("\"title\":\"Checkout fails\""))
        assertTrue(json.contains("\"platform\":\"android\""))
        assertTrue(json.contains("\"deviceModel\":\"Pixel 8\""))
    }

    @Test
    fun `research response serializes with its own payload type`() {
        val json = submission(
            SubmissionPayload.ResearchResponse(
                studyId = "study_1",
                answers = listOf(Answer("q1", "Very easy")),
                completed = true,
                durationMs = 45_000
            )
        ).toJson()

        assertTrue(json.contains("\"type\":\"research_response\""))
        assertTrue(json.contains("\"studyId\":\"study_1\""))
        assertTrue(json.contains("\"completed\":true"))
        assertTrue(json.contains("\"questionId\":\"q1\""))
    }

    @Test
    fun `null optional fields are omitted rather than emitted as null`() {
        val json = submission(SubmissionPayload.BugReport(ReportKind.BUG, "No description")).toJson()

        // Absent and null mean different things to the validator; emitting
        // "description":null would be a value the server has to special-case.
        assertFalse(json.contains("\"description\""))
        assertFalse(json.contains("\"reporter\""))
        assertFalse(json.contains("null"))
    }

    @Test
    fun `quotes and newlines in user text cannot break out of the string`() {
        // A title like this is exactly what a user reporting a JSON bug would type.
        val hostile = "He said \"hi\"\nthen \\ left\ttab"
        val json = submission(SubmissionPayload.BugReport(ReportKind.BUG, hostile)).toJson()

        assertTrue(json.contains("\\\"hi\\\""))
        assertTrue(json.contains("\\n"))
        assertTrue(json.contains("\\\\"))
        assertTrue(json.contains("\\t"))
        // The raw newline must not survive into the payload.
        assertFalse(json.contains("hi\"\nthen"))
    }

    @Test
    fun `control characters are escaped as unicode`() {
        val json = submission(
            SubmissionPayload.BugReport(ReportKind.BUG, "belland separator")
        ).toJson()

        assertTrue(json.contains("\\u0007"))
        // U+2028 is valid JSON but breaks JavaScript parsers downstream.
        assertTrue(json.contains("\\u2028"))
    }

    @Test
    fun `annotations serialize in normalized coordinates`() {
        val json = submission(
            SubmissionPayload.BugReport(
                kind = ReportKind.BUG,
                title = "Annotated",
                annotations = listOf(
                    Annotation.Blur(Point(0.1f, 0.2f), 0.3f, 0.4f),
                    Annotation.Arrow(Point(0f, 0f), Point(1f, 1f), "#ff3b30")
                )
            )
        ).toJson()

        assertTrue(json.contains("\"type\":\"blur\""))
        assertTrue(json.contains("\"type\":\"arrow\""))
        assertTrue(json.contains("\"color\":\"#ff3b30\""))
    }
}
