package com.susatest.signals

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The consent gate is the highest-stakes logic in the SDK: every failure mode
 * here is a privacy incident rather than a bug. These assert it fails closed.
 */
class ConsentTest {

    private fun manager(store: KeyValueStore = InMemoryStore(), version: String = "1") =
        ConsentManager(store, version)

    @Test
    fun `no grant means no consent`() {
        val consent = manager()
        assertNull(consent.load())
        assertFalse(consent.has(ConsentScope.SESSION_REPLAY))
        assertFalse(consent.has(ConsentScope.SCREENSHOT))
    }

    @Test
    fun `granted scope is reported and others are not`() {
        val consent = manager()
        consent.grant(listOf(ConsentScope.SCREENSHOT), "host_app")

        assertTrue(consent.has(ConsentScope.SCREENSHOT))
        // Granting one scope must never imply another.
        assertFalse(consent.has(ConsentScope.SESSION_REPLAY))
    }

    @Test
    fun `granting a new scope preserves earlier ones`() {
        val consent = manager()
        consent.grant(listOf(ConsentScope.SCREENSHOT, ConsentScope.DIAGNOSTICS), "host_app")
        consent.grant(listOf(ConsentScope.SESSION_REPLAY), "explicit_prompt")

        assertTrue(consent.has(ConsentScope.SCREENSHOT))
        assertTrue(consent.has(ConsentScope.DIAGNOSTICS))
        assertTrue(consent.has(ConsentScope.SESSION_REPLAY))
    }

    @Test
    fun `revoke clears everything immediately`() {
        val consent = manager()
        consent.grant(ConsentScope.entries.toList(), "explicit_prompt")
        consent.revoke()

        assertNull(consent.load())
        ConsentScope.entries.forEach { assertFalse(consent.has(it)) }
    }

    @Test
    fun `a grant against a superseded policy version does not count`() {
        val store = InMemoryStore()
        manager(store, version = "1").grant(listOf(ConsentScope.SESSION_REPLAY), "explicit_prompt")

        // Consent copy changed; the old agreement was to different terms.
        val afterPolicyChange = manager(store, version = "2")
        assertNull(afterPolicyChange.load())
        assertFalse(afterPolicyChange.has(ConsentScope.SESSION_REPLAY))
    }

    @Test
    fun `corrupt stored scopes fail closed`() {
        val store = InMemoryStore()
        store.set("susa.signals.consent.version", "1")
        store.set("susa.signals.consent.scopes", "not_a_real_scope,,,garbage")

        val consent = manager(store)
        // Unrecognized scopes must not resolve to "some consent".
        assertNull(consent.load())
        assertFalse(consent.has(ConsentScope.SESSION_REPLAY))
    }

    @Test
    fun `grant records source and timestamp for audit`() {
        val consent = manager()
        val record = consent.grant(listOf(ConsentScope.SCREENSHOT), "explicit_prompt")

        assertEquals("explicit_prompt", record.source)
        assertTrue(record.grantedAt > 0)
    }
}
