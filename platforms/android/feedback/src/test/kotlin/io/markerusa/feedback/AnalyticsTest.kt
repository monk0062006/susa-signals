package io.markerusa.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Batching behaviour. Mirrors the constraints in `packages/core/src/analytics.ts`;
 * divergence between the two is the first sign the platforms have drifted.
 */
class AnalyticsTest {

    private class FakeTransport : Analytics.EventTransport {
        val batches = mutableListOf<List<Analytics.Event>>()
        var failWith: Exception? = null

        override fun sendEvents(events: List<Analytics.Event>, device: DeviceContext) {
            failWith?.let { throw it }
            batches.add(events)
        }

        fun totalSent(): Int = batches.sumOf { it.size }
    }

    private lateinit var storage: KeyValueStore
    private lateinit var consent: ConsentManager
    private lateinit var transport: FakeTransport

    private val device = DeviceContext(sdkVersion = "0.0.0")

    private fun analytics(options: Analytics.Options = Analytics.Options()) =
        Analytics(transport, consent, { device }, options)

    @Before
    fun setUp() {
        storage = InMemoryStore()
        consent = ConsentManager(storage, "1")
        transport = FakeTransport()
    }

    @Test
    fun `events are discarded when analytics consent is absent`() {
        val a = analytics()
        a.track("viewed")
        a.track("clicked")

        assertEquals(0, a.flush())
        // Discarded, not held: transmitting later would rely on a consent that
        // was never given for the moment of capture.
        assertEquals(0, a.buffered())
        assertEquals(0, transport.totalSent())
    }

    @Test
    fun `events are sent once consent exists`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("viewed", mapOf("path" to "/billing"))

        assertEquals(1, a.flush())
        assertEquals(1, transport.totalSent())
        assertEquals("viewed", transport.batches[0][0].name)
        assertEquals("/billing", transport.batches[0][0].properties["path"])
    }

    @Test
    fun `granting screenshot consent does not enable analytics`() {
        consent.grant(listOf(ConsentScope.SCREENSHOT, ConsentScope.DIAGNOSTICS), "host_app")

        val a = analytics()
        a.track("viewed")

        // Analytics is a separate legal basis; it must never ride on the
        // implicit consent that filing a report carries.
        assertEquals(0, a.flush())
    }

    @Test
    fun `a full batch flushes without waiting for the timer`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics(Analytics.Options(batchSize = 3))
        repeat(3) { a.track("event-$it") }

        assertEquals(3, transport.totalSent())
        assertEquals(0, a.buffered())
    }

    @Test
    fun `overflow drops the oldest events, not the newest`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        // batchSize above maxBuffered so nothing auto-flushes mid-test.
        val a = analytics(Analytics.Options(batchSize = 1000, maxBuffered = 5))
        repeat(8) { a.track("event-$it") }

        assertEquals(5, a.buffered())
        a.flush()

        val names = transport.batches.flatten().map { it.name }
        // During an outage the recent past explains current behaviour; the
        // distant past does not.
        assertTrue("oldest should have been dropped", "event-0" !in names)
        assertTrue("newest should survive", "event-7" in names)
    }

    @Test
    fun `a failed batch is dropped rather than retried`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("viewed")
        transport.failWith = RuntimeException("offline")

        assertEquals(0, a.flush())
        // Re-buffering would grow the buffer during exactly the outage that
        // caused the failure.
        assertEquals(0, a.buffered())
    }

    @Test
    fun `identify attaches the user to subsequent events only`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("before")
        a.identify(Reporter(email = "dana@example.com"))
        a.track("after")
        a.flush()

        val events = transport.batches.flatten()
        assertEquals(null, events.first { it.name == "before" }.userId)
        assertEquals("dana@example.com", events.first { it.name == "after" }.userId)
    }

    @Test
    fun `identify prefers the host app external id over email`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.identify(Reporter(email = "dana@example.com", externalId = "user_42"))
        a.track("viewed")
        a.flush()

        assertEquals("user_42", transport.batches.flatten()[0].userId)
    }

    @Test
    fun `all events in one session share a session id`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("one")
        a.track("two")
        a.flush()

        val ids = transport.batches.flatten().map { it.sessionId }.distinct()
        assertEquals(1, ids.size)
        assertEquals(a.getSessionId(), ids[0])
    }

    @Test
    fun `discard drops buffered events without sending`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics(Analytics.Options(batchSize = 100))
        a.track("viewed")
        a.discard()

        assertEquals(0, a.buffered())
        assertEquals(0, a.flush())
        assertEquals(0, transport.totalSent())
    }

    @Test
    fun `blank event names are ignored`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("")
        a.track("   ")

        assertEquals(0, a.buffered())
    }

    @Test
    fun `absurd event names are truncated rather than stored`() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("x".repeat(5000))
        a.flush()

        assertTrue(transport.batches.flatten()[0].name.length <= 200)
    }
}
