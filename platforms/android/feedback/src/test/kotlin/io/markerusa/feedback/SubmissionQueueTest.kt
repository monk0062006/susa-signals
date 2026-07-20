package io.markerusa.feedback

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The outbox exists to survive exactly the conditions that break uploads, so its
 * failure handling is tested directly rather than inferred.
 */
class SubmissionQueueTest {

    /** Stands in for the network without one. */
    private class FakeClient(
        var failWith: IngestException? = null
    ) : SubmissionTransport {
        val submitted = mutableListOf<String>()
        var calls = 0

        override fun submit(submissionJson: String, idempotencyKey: String) {
            calls++
            failWith?.let { throw it }
            submitted.add(idempotencyKey)
        }
    }

    private fun queue(client: FakeClient, store: KeyValueStore = InMemoryStore(), clock: () -> Long) =
        SubmissionQueue(store, client, clock)

    @Test
    fun `successful submit clears the item`() {
        val client = FakeClient()
        val q = queue(client) { 1_000 }

        val result = q.enqueue("id-1", """{"id":"id-1"}""")

        assertEquals(1, result.sent)
        assertEquals(0, result.remaining)
        assertEquals(listOf("id-1"), client.submitted)
    }

    @Test
    fun `retryable failure keeps the item for a later flush`() {
        val client = FakeClient(IngestException("offline", null, retryable = true))
        val store = InMemoryStore()
        var clock = 1_000L
        val q = SubmissionQueue(store, client) { clock }

        val result = q.enqueue("id-1", """{"id":"id-1"}""")

        assertEquals(0, result.sent)
        assertEquals(1, result.remaining)

        // Network comes back, but the item is still inside its backoff window.
        client.failWith = null
        assertEquals(0, q.flush().sent)

        // Past the backoff: the stored bytes are replayed verbatim.
        clock += 31_000
        assertEquals(1, q.flush().sent)
        assertEquals(0, q.size())
    }

    @Test
    fun `backoff stops rapid flushes from burning the retry budget`() {
        val client = FakeClient(IngestException("offline", null, retryable = true))
        val store = InMemoryStore()
        var clock = 1_000L
        val q = SubmissionQueue(store, client) { clock }

        q.enqueue("id-1", """{"id":"id-1"}""")
        val callsAfterEnqueue = client.calls

        // Simulates a burst of reports during one outage, each triggering a flush.
        repeat(50) { q.flush() }

        // The item must not have been retried 50 times, and must still be queued —
        // this is the regression that discarded reports minutes into an outage.
        assertEquals(callsAfterEnqueue, client.calls)
        assertEquals(1, q.size())
    }

    @Test
    fun `permanent rejection drops the item instead of retrying forever`() {
        val client = FakeClient(IngestException("bad request", 400, retryable = false))
        val q = queue(client) { 1_000 }

        val result = q.enqueue("id-1", """{"id":"id-1"}""")

        assertEquals(0, result.sent)
        // A 400 will never become a 200; keeping it would block the queue forever.
        assertEquals(0, result.remaining)
    }

    @Test
    fun `a poison item is abandoned after the attempt limit`() {
        val client = FakeClient(IngestException("server down", 500, retryable = true))
        val store = InMemoryStore()
        var clock = 1_000L
        val q = SubmissionQueue(store, client) { clock }

        q.enqueue("id-1", """{"id":"id-1"}""")

        // Advance past each backoff window so attempts actually accrue.
        repeat(12) {
            clock += 7 * 60 * 60 * 1000L // beyond the 6h cap
            q.flush()
        }

        assertEquals(0, q.size())
    }

    @Test
    fun `overflow evicts oldest first, not at random`() {
        val client = FakeClient(IngestException("offline", null, retryable = true))
        val store = InMemoryStore()
        var clock = 1_000L
        val q = SubmissionQueue(store, client) { clock }

        // 25 items into a queue capped at 20.
        repeat(25) { i ->
            clock += 1_000
            q.enqueue("id-$i", """{"seq":$i}""")
        }

        assertEquals(20, q.size())

        // The five oldest must be gone and the newest must remain. UUID-keyed
        // storage would have evicted an arbitrary five instead.
        val remaining = store.keys("markerio.outbox.")
        assertTrue(remaining.none { it.endsWith("id-0") })
        assertTrue(remaining.none { it.endsWith("id-4") })
        assertTrue(remaining.any { it.endsWith("id-24") })
    }

    @Test
    fun `queue survives being rebuilt over the same storage`() {
        val client = FakeClient(IngestException("offline", null, retryable = true))
        val store = InMemoryStore()

        SubmissionQueue(store, client) { 1_000 }.enqueue("id-1", """{"id":"id-1"}""")

        // Simulates process death: new instance, same underlying storage. The clock
        // is past the backoff window, which itself survived the restart.
        val revived = SubmissionQueue(store, FakeClient()) { 40_000 }
        assertEquals(1, revived.size())
        assertEquals(1, revived.flush().sent)
    }
}
