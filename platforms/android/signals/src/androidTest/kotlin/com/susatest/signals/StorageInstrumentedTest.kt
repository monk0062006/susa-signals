package com.susatest.signals

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The consent gate and outbox against real SharedPreferences.
 *
 * The JVM suite exercises this logic through InMemoryStore, which proves the
 * algorithm but not the persistence. On device it also proves that
 * `commit()` writes synchronously — the property the outbox depends on to
 * survive a process death that can happen milliseconds after a report is filed.
 */
@RunWith(AndroidJUnit4::class)
class StorageInstrumentedTest {

    private lateinit var storage: KeyValueStore

    @Before
    fun setUp() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        storage = SharedPrefsStore(context)

        // Each run starts clean; prefs survive between test runs on a device.
        for (key in storage.keys("susa.signals.")) storage.remove(key)
    }

    @Test
    fun writesSurviveAFreshStoreOverTheSamePreferences() {
        storage.set("susa.signals.test.key", "value-1")

        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        // Simulates process death: a brand-new store over the same prefs file.
        val revived = SharedPrefsStore(context)

        assertEquals("value-1", revived.get("susa.signals.test.key"))
    }

    @Test
    fun keysCanBeEnumeratedByPrefix() {
        storage.set("susa.signals.outbox.001.a", "{}")
        storage.set("susa.signals.outbox.002.b", "{}")
        storage.set("susa.signals.other", "x")

        val keys = storage.keys("susa.signals.outbox.")
        assertEquals(2, keys.size)
        assertTrue(keys.all { it.startsWith("susa.signals.outbox.") })
    }

    @Test
    fun consentGateFailsClosedOnRealStorage() {
        val consent = ConsentManager(storage, policyVersion = "1")

        assertNull(consent.load())
        assertFalse(consent.has(ConsentScope.SESSION_REPLAY))

        consent.grant(listOf(ConsentScope.SCREENSHOT), "host_app")
        assertTrue(consent.has(ConsentScope.SCREENSHOT))
        // Granting one scope must never imply another.
        assertFalse(consent.has(ConsentScope.SESSION_REPLAY))

        consent.revoke()
        assertNull(consent.load())
    }

    @Test
    fun consentSurvivesProcessDeathButNotAPolicyChange() {
        ConsentManager(storage, policyVersion = "1")
            .grant(listOf(ConsentScope.SESSION_REPLAY), "explicit_prompt")

        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val revived = SharedPrefsStore(context)

        assertTrue(ConsentManager(revived, policyVersion = "1").has(ConsentScope.SESSION_REPLAY))
        // Consent copy changed: the old agreement was to different terms.
        assertFalse(ConsentManager(revived, policyVersion = "2").has(ConsentScope.SESSION_REPLAY))
    }

    @Test
    fun outboxPersistsAcrossInstancesOnDevice() {
        val failing = object : SubmissionTransport {
            override fun submit(submissionJson: String, idempotencyKey: String) {
                throw IngestException("offline", null, retryable = true)
            }
        }

        var clock = 1_000L
        SubmissionQueue(storage, failing) { clock }.enqueue("id-1", """{"id":"id-1"}""")

        // New instance over the same real preferences.
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val revived = SubmissionQueue(SharedPrefsStore(context), failing) { clock }

        assertEquals(1, revived.size())
    }
}
