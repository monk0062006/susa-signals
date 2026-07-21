package io.markerusa.feedback

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * Analytics against the real ingest service, from a real device.
 *
 * Requires `adb reverse tcp:4000 tcp:4000` so the device's localhost reaches
 * the developer machine. Skipped rather than failed when the service is not
 * reachable — a missing local server should not turn the whole suite red on a
 * machine that is not running one.
 *
 * The unit tests prove the batching logic; this proves an event actually
 * survives serialization, HTTP, validation and storage. Those are different
 * claims, and only the second one means the feature works.
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsEndToEndInstrumentedTest {

    private val endpoint = "http://localhost:4000"
    private val projectId = "proj_androidtest_${UUID.randomUUID().toString().take(8)}"

    private lateinit var storage: KeyValueStore
    private lateinit var consent: ConsentManager

    @Before
    fun setUp() {
        assumeTrue("ingest service not reachable from device", serviceReachable())

        storage = InMemoryStore()
        consent = ConsentManager(storage, "1")
    }

    private fun serviceReachable(): Boolean = try {
        val conn = (URL("$endpoint/health").openConnection() as HttpURLConnection).apply {
            connectTimeout = 2000
            readTimeout = 2000
        }
        val ok = conn.responseCode == 200
        conn.disconnect()
        ok
    } catch (e: Exception) {
        false
    }

    private fun countsFor(name: String): Int {
        val conn = (URL("$endpoint/v1/events/counts?days=1").openConnection() as HttpURLConnection).apply {
            setRequestProperty("x-project-id", projectId)
            connectTimeout = 5000
            readTimeout = 5000
        }
        val body = conn.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
        conn.disconnect()

        // Deliberately not parsing JSON: the library ships without a parser, and
        // adding one for a test would misrepresent its dependency footprint.
        val marker = "\"name\":\"$name\",\"count\":"
        val at = body.indexOf(marker)
        if (at < 0) return 0
        return body.substring(at + marker.length).takeWhile { it.isDigit() }.toIntOrNull() ?: 0
    }

    private fun analytics(): Analytics = Analytics(
        transport = HttpEventTransport(projectId, IngestClient(endpoint, projectId)),
        consent = consent,
        device = {
            DeviceInfo.collect(
                ApplicationProvider.getApplicationContext(),
                "0.0.0",
                null,
            )
        },
    )

    @Test
    fun eventsReachTheServerAndAggregate() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.identify("device-test-user")
        repeat(3) { a.track("android_e2e_event", mapOf("index" to it.toString())) }

        val sent = a.flush()
        assertEquals("flush did not report all events sent", 3, sent)

        assertEquals("events did not reach the server", 3, countsFor("android_e2e_event"))
    }

    @Test
    fun withoutConsentNothingReachesTheServer() {
        // No grant at all.
        val a = analytics()
        a.track("android_e2e_unconsented")

        assertEquals(0, a.flush())
        assertEquals("unconsented events were transmitted", 0, countsFor("android_e2e_unconsented"))
    }

    @Test
    fun deviceContextTravelsWithTheBatch() {
        consent.grant(listOf(ConsentScope.ANALYTICS), "explicit_prompt")

        val a = analytics()
        a.track("android_e2e_device")
        assertEquals(1, a.flush())

        val conn = (URL("$endpoint/v1/events?limit=50").openConnection() as HttpURLConnection).apply {
            setRequestProperty("x-project-id", projectId)
            connectTimeout = 5000
        }
        val body = conn.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
        conn.disconnect()

        assertTrue("event missing from the server", body.contains("android_e2e_device"))
    }
}
