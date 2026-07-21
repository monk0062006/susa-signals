package com.susatest.signals

import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Product analytics.
 *
 * Deliberately does NOT use [SubmissionQueue]. Reports and research responses
 * are irreplaceable — a person typed them — so they persist to disk before any
 * network call and retry for days. Events are individually worthless, valuable
 * only in aggregate, and produced hundreds of times more often. Routing them
 * through the same outbox would exhaust SharedPreferences and evict the reports
 * that outbox exists to protect.
 *
 * So events batch in memory, flush on a timer or when a batch fills, and are
 * dropped on overflow. Losing a screen view is a rounding error; losing a bug
 * report is a lost customer conversation.
 *
 * Mirrors `packages/core/src/analytics.ts`. The two must not drift.
 */
class Analytics(
    private val transport: EventTransport,
    private val consent: ConsentManager,
    private val device: () -> DeviceContext,
    private val options: Options = Options(),
    private val log: (String) -> Unit = {},
) {
    data class Options(
        /** Events per batch. Reaching it triggers an immediate flush. */
        val batchSize: Int = 25,
        /** Flush cadence for traffic too slow to fill a batch. */
        val flushIntervalMs: Long = 15_000,
        /**
         * Ceiling on the in-memory buffer. Beyond this the OLDEST events are
         * dropped: during an outage, recent behaviour explains what the user is
         * doing now far better than the distant past.
         */
        val maxBuffered: Int = 500,
    )

    data class Event(
        val id: String,
        val name: String,
        val properties: Map<String, String>,
        val userId: String?,
        val sessionId: String,
        val timestamp: Long,
    )

    /** Seam so the batching logic is testable without a network. */
    interface EventTransport {
        fun sendEvents(events: List<Event>, device: DeviceContext)
    }

    private val buffer = ArrayDeque<Event>()
    private val sessionId: String = UUID.randomUUID().toString()

    @Volatile
    private var userId: String? = null

    private var scheduler: ScheduledExecutorService? = null

    fun getSessionId(): String = sessionId

    /** Begins periodic flushing. Safe to call more than once. */
    @Synchronized
    fun start() {
        if (scheduler != null) return

        scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
            // Daemon: analytics must never hold the host app's process open.
            Thread(runnable, "susa-signals-analytics").apply { isDaemon = true }
        }.also {
            it.scheduleWithFixedDelay(
                { flush() },
                options.flushIntervalMs,
                options.flushIntervalMs,
                TimeUnit.MILLISECONDS,
            )
        }
    }

    /**
     * Records an event.
     *
     * Consent is checked at flush rather than here, so a grant arriving between
     * buffering and sending cannot retroactively authorise capture, and a
     * revocation discards everything still buffered.
     */
    fun track(name: String, properties: Map<String, String> = emptyMap()) {
        if (name.isBlank()) return

        val event = Event(
            id = UUID.randomUUID().toString(),
            name = name.take(200),
            properties = properties,
            userId = userId,
            sessionId = sessionId,
            timestamp = System.currentTimeMillis(),
        )

        synchronized(buffer) {
            buffer.addLast(event)
            while (buffer.size > options.maxBuffered) buffer.removeFirst()
            buffer.size
        }.let { size ->
            if (size >= options.batchSize) flushAsync()
        }
    }

    /** Associates subsequent events with a person. */
    fun identify(user: Reporter) {
        userId = user.externalId ?: user.email
    }

    fun identify(id: String) {
        userId = id
    }

    private fun flushAsync() {
        val service = scheduler
        if (service != null && !service.isShutdown) service.execute { flush() } else flush()
    }

    /**
     * Sends whatever is buffered. Never throws.
     *
     * A failed batch is discarded rather than retried: retrying would grow the
     * buffer during exactly the outage that caused the failure.
     */
    fun flush(): Int {
        val batch: List<Event>
        synchronized(buffer) {
            if (buffer.isEmpty()) return 0
            batch = buffer.toList()
            buffer.clear()
        }

        // The gate. Without a grant the events are discarded, not held — holding
        // them would mean transmitting later on a consent never given for the
        // moment they were captured.
        if (!consent.has(ConsentScope.ANALYTICS)) {
            log("analytics: discarded ${batch.size} event(s), no consent")
            return 0
        }

        return try {
            transport.sendEvents(batch, device())
            batch.size
        } catch (e: Exception) {
            log("analytics: dropped ${batch.size} event(s): ${e.message}")
            0
        }
    }

    /** Discards buffered events without sending. Used when consent is withdrawn. */
    fun discard() {
        val dropped = synchronized(buffer) {
            val n = buffer.size
            buffer.clear()
            n
        }
        if (dropped > 0) log("analytics: discarded $dropped buffered event(s)")
    }

    @Synchronized
    fun stop() {
        scheduler?.shutdown()
        scheduler = null
        flush()
    }

    /** Exposed for tests and diagnostics. */
    fun buffered(): Int = synchronized(buffer) { buffer.size }
}

/** Ships batches to the ingest service. */
internal class HttpEventTransport(
    private val projectId: String,
    private val client: IngestClient,
) : Analytics.EventTransport {

    override fun sendEvents(events: List<Analytics.Event>, device: DeviceContext) {
        val json = JsonWriter().obj {
            array("events", events) { event ->
                str("id", event.id)
                str("name", event.name)
                str("sessionId", event.sessionId)
                num("timestamp", event.timestamp)
                str("userId", event.userId)
                if (event.properties.isNotEmpty()) {
                    obj("properties") {
                        event.properties.forEach { (k, v) -> str(k, v) }
                    }
                }
            }
            obj("device") { writeDeviceContext(device) }
        }.toString()

        client.sendEvents(json)
    }
}
