package com.susatest.signals

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * SPEC-174: the Android signer must reproduce the exact HMAC the server and the
 * web/iOS signers produce for one fixed vector, so the four implementations can
 * never silently diverge. The expected hex is asserted identically in the Python
 * server test (test_signed_ingest.test_signing_known_answer) and the iOS test.
 */
class SigningTest {

    @Test
    fun knownAnswerVector() {
        val secret = "0123456789abcdef0123456789abcdef".toByteArray(Charsets.UTF_8)
        val body = "{\"a\":1}".toByteArray(Charsets.UTF_8)
        val canonical = Signing.canonical("1700000000", "POST", "/v1/reports", body)
        assertEquals(
            "aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3",
            Signing.sign(secret, canonical),
        )
    }

    @Test
    fun headersHaveTimestampAndVersionedSignature() {
        val secret = "0123456789abcdef0123456789abcdef".toByteArray(Charsets.UTF_8)
        val h = Signing.headers(secret, "1700000000", "/v1/reports", "{\"a\":1}".toByteArray(Charsets.UTF_8))
        assertEquals("1700000000", h["x-susa-timestamp"])
        assertEquals(
            "v1=aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3",
            h["x-susa-signature"],
        )
    }
}
