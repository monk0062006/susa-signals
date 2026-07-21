package com.susatest.signals

import java.util.UUID

/**
 * Kotlin mirror of the TypeScript wire format in `packages/core`.
 *
 * This is a hand-maintained copy, which is a real risk: three independent
 * implementations of one schema drift silently, and the drift surfaces as a
 * malformed field in production rather than a compile error. Generating all three
 * from one source is the correct long-term fix — see README.
 */

enum class Platform(val wire: String) {
    WEB("web"),
    IOS("ios"),
    ANDROID("android")
}

enum class ReportKind(val wire: String) {
    BUG("bug"),
    FEEDBACK("feedback"),
    QUESTION("question")
}

data class Reporter(
    val email: String? = null,
    val fullName: String? = null,
    val externalId: String? = null
)

data class DeviceContext(
    val platform: Platform = Platform.ANDROID,
    val sdkVersion: String,
    val osName: String? = "Android",
    val osVersion: String? = null,
    val deviceModel: String? = null,
    val locale: String? = null,
    val timezone: String? = null,
    val screenWidth: Int? = null,
    val screenHeight: Int? = null,
    val pixelRatio: Float? = null,
    /** The screen/route the user was on. The native analogue of a URL. */
    val route: String? = null,
    val appVersion: String? = null,
    val appBuild: String? = null,
    val networkType: String? = null
)

data class LogEntry(val level: String, val message: String, val timestamp: Long)

data class Attachment(
    val id: String,
    val kind: String,
    val mimeType: String,
    val byteSize: Long,
    val width: Int? = null,
    val height: Int? = null
)

/** Normalized 0..1 so annotations survive any rescale, exactly as on web. */
data class Point(val x: Float, val y: Float)

sealed class Annotation {
    data class Rect(val origin: Point, val width: Float, val height: Float, val color: String) : Annotation()
    data class Arrow(val from: Point, val to: Point, val color: String) : Annotation()
    data class Pen(val points: List<Point>, val color: String, val strokeWidth: Float) : Annotation()
    /** Must be burned into the image, never merely overlaid. */
    data class Blur(val origin: Point, val width: Float, val height: Float) : Annotation()
}

sealed class SubmissionPayload {
    data class BugReport(
        val kind: ReportKind,
        val title: String,
        val description: String? = null,
        val annotations: List<Annotation> = emptyList(),
        val logs: List<LogEntry> = emptyList()
    ) : SubmissionPayload()

    data class ResearchResponse(
        val studyId: String,
        val answers: List<Answer>,
        val completed: Boolean,
        val durationMs: Long? = null
    ) : SubmissionPayload()
}

/**
 * One answer.
 *
 * `values` exists because multi-choice must serialize as a JSON array, matching
 * web. Comma-joining into `value` would look correct on the wire and then
 * aggregate to zero: the dashboard's countChoices matches exact option strings,
 * so "Payment failed, Confusing pricing" matches neither option.
 */
data class Answer(
    val questionId: String,
    val value: String? = null,
    val values: List<String>? = null
)

data class Submission(
    val id: String = UUID.randomUUID().toString(),
    val projectId: String,
    val payload: SubmissionPayload,
    val device: DeviceContext,
    val reporter: Reporter? = null,
    val attachments: List<Attachment> = emptyList(),
    val customData: Map<String, String> = emptyMap(),
    val sessionId: String? = null,
    val consent: ConsentRecord? = null,
    val createdAt: Long = System.currentTimeMillis()
) {
    fun toJson(): String = JsonWriter().obj {
        str("id", id)
        str("projectId", projectId)
        obj("payload") { writePayload(payload) }
        obj("device") { writeDevice(device) }
        reporter?.let { r ->
            obj("reporter") {
                str("email", r.email)
                str("fullName", r.fullName)
                str("externalId", r.externalId)
            }
        }
        array("attachments", attachments) { a ->
            str("id", a.id)
            str("kind", a.kind)
            str("mimeType", a.mimeType)
            num("byteSize", a.byteSize)
            num("width", a.width)
            num("height", a.height)
        }
        if (customData.isNotEmpty()) {
            obj("customData") { customData.forEach { (k, v) -> str(k, v) } }
        }
        str("sessionId", sessionId)
        consent?.let { c ->
            obj("consent") {
                strArray("scopes", c.scopes.map { it.wire })
                str("policyVersion", c.policyVersion)
                num("grantedAt", c.grantedAt)
                str("source", c.source)
            }
        }
        num("createdAt", createdAt)
    }.toString()
}

private fun JsonWriter.ObjectScope.writePayload(payload: SubmissionPayload) {
    when (payload) {
        is SubmissionPayload.BugReport -> {
            str("type", "bug_report")
            str("kind", payload.kind.wire)
            str("title", payload.title)
            str("description", payload.description)
            array("annotations", payload.annotations) { writeAnnotation(it) }
            array("consoleLogs", payload.logs) { log ->
                str("level", log.level)
                str("message", log.message)
                num("timestamp", log.timestamp)
            }
        }
        is SubmissionPayload.ResearchResponse -> {
            str("type", "research_response")
            str("studyId", payload.studyId)
            array("answers", payload.answers) { a ->
                str("questionId", a.questionId)
                if (a.values != null) strArray("value", a.values) else str("value", a.value)
            }
            bool("completed", payload.completed)
            num("durationMs", payload.durationMs)
        }
    }
}

private fun JsonWriter.ObjectScope.writeAnnotation(annotation: Annotation) {
    when (annotation) {
        is Annotation.Rect -> {
            str("type", "rect")
            obj("origin") { num("x", annotation.origin.x); num("y", annotation.origin.y) }
            num("width", annotation.width)
            num("height", annotation.height)
            str("color", annotation.color)
        }
        is Annotation.Arrow -> {
            str("type", "arrow")
            obj("from") { num("x", annotation.from.x); num("y", annotation.from.y) }
            obj("to") { num("x", annotation.to.x); num("y", annotation.to.y) }
            str("color", annotation.color)
        }
        is Annotation.Pen -> {
            str("type", "pen")
            array("points", annotation.points) { p -> num("x", p.x); num("y", p.y) }
            str("color", annotation.color)
            num("strokeWidth", annotation.strokeWidth)
        }
        is Annotation.Blur -> {
            str("type", "blur")
            obj("origin") { num("x", annotation.origin.x); num("y", annotation.origin.y) }
            num("width", annotation.width)
            num("height", annotation.height)
        }
    }
}

/** Shared by submissions and analytics batches, so one device shape exists. */
internal fun JsonWriter.ObjectScope.writeDeviceContext(device: DeviceContext) = writeDevice(device)

private fun JsonWriter.ObjectScope.writeDevice(device: DeviceContext) {
    str("platform", device.platform.wire)
    str("sdkVersion", device.sdkVersion)
    str("osName", device.osName)
    str("osVersion", device.osVersion)
    str("deviceModel", device.deviceModel)
    str("locale", device.locale)
    str("timezone", device.timezone)
    if (device.screenWidth != null && device.screenHeight != null) {
        obj("screen") {
            num("width", device.screenWidth)
            num("height", device.screenHeight)
            num("pixelRatio", device.pixelRatio ?: 1f)
        }
    }
    str("route", device.route)
    str("appVersion", device.appVersion)
    str("appBuild", device.appBuild)
    str("networkType", device.networkType)
}
