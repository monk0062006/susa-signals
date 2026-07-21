package io.markerusa.feedback

import android.app.Activity
import android.content.Context
import android.util.Log
import io.markerusa.feedback.annotate.FeedbackOverlay
import io.markerusa.feedback.replay.FrameRecorder
import io.markerusa.feedback.survey.Study
import io.markerusa.feedback.survey.SurveyPanel
import io.markerusa.feedback.replay.HttpFrameUploader
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** Bump when consent copy changes materially; prior grants stop counting. */
private const val CONSENT_POLICY_VERSION = "1"
private const val SDK_VERSION = "0.0.0"
private const val TAG = "MarkerFeedback"

data class FeedbackConfig(
    val projectId: String,
    val endpoint: String,
    val reporter: Reporter? = null,
    val customData: Map<String, String> = emptyMap(),
    val silent: Boolean = false
)

/**
 * Public entry point, the Android counterpart to web's `loadWidget`.
 *
 * All network and storage work runs on a single background thread. The SDK never
 * blocks the caller's thread and never assumes the host app has a coroutine scope
 * it is willing to share.
 */
class FeedbackSdk private constructor(
    private val context: Context,
    private val config: FeedbackConfig,
    private val storage: KeyValueStore,
    private val client: IngestClient,
    private val queue: SubmissionQueue,
    private val consent: ConsentManager
) {
    private val worker: ExecutorService = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "markerio-feedback").apply { isDaemon = true }
    }

    private var reporter: Reporter? = config.reporter
    private var customData: Map<String, String> = config.customData

    /** Guards against a second composer opening over a live one. */
    @Volatile
    private var overlayVisible = false

    /** Guards against a second survey sheet opening over a live one. */
    @Volatile
    private var surveyOpen = false

    /**
     * Frame-based session replay. Created eagerly but inert until `start` is
     * called AND consent exists — constructing it costs nothing and starts
     * nothing.
     */
    /**
     * Product analytics. Batches in memory and never touches the outbox — see
     * Analytics for why events and reports must not share a queue.
     */
    private val analytics: Analytics = Analytics(
        transport = HttpEventTransport(config.projectId, client),
        consent = consent,
        device = { DeviceInfo.collect(context, SDK_VERSION, null) },
        log = ::log,
    )

    private val replay: FrameRecorder = FrameRecorder(
        consent = consent,
        uploader = HttpFrameUploader(config.endpoint, config.projectId, client),
        log = ::log,
    )

    companion object {
        @Volatile
        private var instance: FeedbackSdk? = null

        /**
         * Initializes the SDK. Safe to call more than once; later calls return the
         * existing instance rather than starting a second queue over the same
         * storage, which would double-send.
         */
        @JvmStatic
        fun init(context: Context, config: FeedbackConfig): FeedbackSdk {
            instance?.let { return it }

            return synchronized(this) {
                instance ?: run {
                    val storage = SharedPrefsStore(context)
                    val client = IngestClient(config.endpoint, config.projectId)
                    val sdk = FeedbackSdk(
                        context.applicationContext,
                        config,
                        storage,
                        client,
                        SubmissionQueue(storage, client),
                        ConsentManager(storage, CONSENT_POLICY_VERSION)
                    )
                    instance = sdk
                    sdk.onInit()
                    sdk
                }
            }
        }

        @JvmStatic
        fun get(): FeedbackSdk? = instance
    }

    private fun onInit() {
        // Filing a report is itself the consent act for screenshot and diagnostics:
        // the user opened the reporter, sees what will be sent, and can redact it.
        // Session replay has no such moment and is excluded here by design.
        if (consent.load() == null) {
            consent.grant(listOf(ConsentScope.SCREENSHOT, ConsentScope.DIAGNOSTICS), "host_app")
        }

        analytics.start()

        // Deliver anything stranded by a previous process's network failure.
        worker.execute {
            val result = queue.flush()
            if (result.sent > 0) log("delivered ${result.sent} queued submission(s)")
        }
    }

    fun setReporter(next: Reporter) { reporter = next }

    fun setCustomData(data: Map<String, String>) { customData = data }

    /**
     * Records a product analytics event.
     *
     * Buffered and batched, never persisted to the outbox: events are
     * high-volume and individually disposable, and sharing storage with reports
     * would evict the reports.
     */
    fun track(event: String, properties: Map<String, String> = emptyMap()) =
        analytics.track(event, properties)

    /** Associates subsequent events with a person. */
    fun identify(user: Reporter) = analytics.identify(user)

    fun identify(userId: String) = analytics.identify(userId)

    /**
     * Presents a research survey and submits whatever was collected.
     *
     * The counterpart to web's `showSurvey`. Must be called on the main thread —
     * it inflates views.
     *
     * `onComplete` receives true if anything was collected, including a partial
     * response from someone who answered two questions and dismissed. Discarding
     * partials would bias results toward people with time to finish.
     */
    fun showSurvey(
        activity: Activity,
        study: Study,
        route: String? = null,
        onComplete: (Boolean) -> Unit = {}
    ) {
        // A second sheet over a live one would split the response in two.
        if (surveyOpen) {
            log("survey ignored: one is already open")
            return
        }
        surveyOpen = true

        SurveyPanel(
            activity = activity,
            study = study,
            onDone = { answers, completed, durationMs ->
                surveyOpen = false
                submitResearchResponse(study.id, answers, completed, durationMs, route)
                log("survey ${study.id} ${if (completed) "completed" else "partial"} (${answers.size} answer(s))")
                onComplete(true)
            },
            onDismiss = {
                surveyOpen = false
                log("survey ${study.id} dismissed without answers")
                onComplete(false)
            }
        ).show()
    }

    /** Sends buffered events immediately. Returns how many were delivered. */
    fun flushEvents(onComplete: (Int) -> Unit = {}) {
        worker.execute { onComplete(analytics.flush()) }
    }

    fun grantConsent(scopes: List<ConsentScope>) {
        consent.grant(scopes, "explicit_prompt")
        log("consent granted: ${scopes.joinToString(",") { it.wire }}")
    }

    fun revokeConsent() {
        consent.revoke()
        // Withdrawal is immediate: buffered data is discarded, not sent.
        replay.abandon()
        analytics.discard()
        log("consent revoked")
    }

    /**
     * Starts session replay if consent allows. Returns the session id, or null.
     *
     * Takes an Activity because frames come from a live window. Callers should
     * restart it in `onResume` and stop it in `onPause` — a recorder that keeps
     * capturing a backgrounded app burns battery for frames of nothing.
     */
    fun startRecording(activity: Activity): String? = replay.start(activity)

    fun stopRecording() = replay.stop()

    /** The id linking a report filed during this session to its recording. */
    fun currentSessionId(): String? = replay.getSessionId()

    /**
     * Captures the screen and presents the annotation composer.
     *
     * This is the counterpart to web's `widget.capture()`, and the path that gives
     * the user a chance to redact before anything leaves the device. Must be called
     * on the main thread — it inflates views.
     */
    fun capture(
        activity: Activity,
        kind: ReportKind = ReportKind.BUG,
        route: String? = null,
        onComplete: (Boolean) -> Unit = {}
    ) {
        if (!consent.has(ConsentScope.SCREENSHOT)) {
            log("capture skipped: no screenshot consent")
            onComplete(false)
            return
        }

        // A second overlay over a live one would double-submit.
        if (overlayVisible) {
            log("capture ignored: composer already open")
            return
        }

        ScreenCapture.capture(activity) { bitmap ->
            if (bitmap == null) {
                log("capture failed: no screenshot")
                onComplete(false)
                return@capture
            }

            overlayVisible = true
            FeedbackOverlay(
                activity = activity,
                screenshot = bitmap,
                onSend = { title, description, annotations, flattened ->
                    overlayVisible = false
                    submitAnnotated(title, description, kind, route, annotations, flattened, onComplete)
                },
                onCancel = {
                    overlayVisible = false
                    log("capture cancelled")
                    onComplete(false)
                }
            ).show()
        }
    }

    /**
     * Submits a report without any UI. For programmatic reporting — crash handlers,
     * automated test failures — where there is no user present to annotate.
     */
    fun report(
        activity: Activity,
        title: String,
        description: String? = null,
        kind: ReportKind = ReportKind.BUG,
        route: String? = null,
        onComplete: (Boolean) -> Unit = {}
    ) {
        if (!consent.has(ConsentScope.SCREENSHOT)) {
            log("report skipped: no screenshot consent")
            onComplete(false)
            return
        }

        ScreenCapture.capture(activity) { bitmap ->
            val bytes = bitmap?.let { ScreenCapture.encode(it) }
            submitAnnotated(
                title = title,
                description = description,
                kind = kind,
                route = route,
                annotations = emptyList(),
                screenshotBytes = bytes,
                onComplete = onComplete,
                width = bitmap?.width ?: 0,
                height = bitmap?.height ?: 0
            )
        }
    }

    private fun submitAnnotated(
        title: String,
        description: String?,
        kind: ReportKind,
        route: String?,
        annotations: List<Annotation>,
        screenshotBytes: ByteArray?,
        onComplete: (Boolean) -> Unit,
        width: Int = 0,
        height: Int = 0
    ) {
        worker.execute {
            try {
                val attachments = mutableListOf<Attachment>()
                if (screenshotBytes != null) {
                    // Upload failure must not lose the user's written text, which is
                    // the part that cannot be recreated.
                    runCatching { uploadScreenshot(screenshotBytes, width, height) }
                        .onSuccess { attachments.add(it) }
                        .onFailure { log("screenshot upload failed; sending without it") }
                }

                val submission = Submission(
                    projectId = config.projectId,
                    payload = SubmissionPayload.BugReport(
                        kind = kind,
                        title = title,
                        description = description,
                        annotations = annotations
                    ),
                    device = DeviceInfo.collect(context, SDK_VERSION, route),
                    reporter = reporter,
                    attachments = attachments,
                    customData = customData,
                    // Links the report to the recording, so it can be watched
                    // in context — the whole point of pairing the two.
                    sessionId = replay.getSessionId(),
                    consent = consent.load()
                )

                queue.enqueue(submission.id, submission.toJson())
                log("submission ${submission.id} queued")
                onComplete(true)
            } catch (e: Exception) {
                log("report failed: ${e.message}")
                onComplete(false)
            }
        }
    }

    /** Submits a research response. No screenshot, so no capture step. */
    fun submitResearchResponse(
        studyId: String,
        answers: List<Answer>,
        completed: Boolean,
        durationMs: Long? = null,
        route: String? = null
    ) {
        worker.execute {
            val submission = Submission(
                projectId = config.projectId,
                payload = SubmissionPayload.ResearchResponse(studyId, answers, completed, durationMs),
                device = DeviceInfo.collect(context, SDK_VERSION, route),
                reporter = reporter,
                customData = customData,
                consent = consent.load()
            )
            queue.enqueue(submission.id, submission.toJson())
            log("research response ${submission.id} queued")
        }
    }

    /** Retry anything stranded by an earlier network failure. */
    fun flush(onComplete: (SubmissionQueue.FlushResult) -> Unit = {}) {
        worker.execute { onComplete(queue.flush()) }
    }

    private fun uploadScreenshot(bytes: ByteArray, width: Int, height: Int): Attachment {
        val id = MultipartUploader(config.endpoint, config.projectId).upload(bytes, "screenshot.png")
        return Attachment(
            id = id,
            kind = "screenshot",
            mimeType = "image/png",
            byteSize = bytes.size.toLong(),
            width = width,
            height = height
        )
    }

    private fun log(message: String) {
        if (!config.silent) Log.i(TAG, message)
    }
}
