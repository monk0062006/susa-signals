package com.susatest.signals

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * SPEC-174 request signing. Kept as a pure object so the crypto is unit-testable
 * on the JVM (no device, no sockets) and pinned against the same known-answer
 * vector as the server (signing.py) and the web/iOS signers — see SigningTest.
 *
 * Canonical string: v1\n<ts>\n<METHOD>\n<path>\n<hex sha256(body)>.
 */
internal object Signing {

    fun canonical(ts: String, method: String, path: String, body: ByteArray): String =
        "v1\n$ts\n$method\n$path\n${sha256Hex(body)}"

    fun sign(secret: ByteArray, canonical: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret, "HmacSHA256"))
        return hex(mac.doFinal(canonical.toByteArray(Charsets.UTF_8)))
    }

    /** The two headers to attach for a POST of [body] to [path]. */
    fun headers(secret: ByteArray, ts: String, path: String, body: ByteArray): Map<String, String> {
        val sig = sign(secret, canonical(ts, "POST", path, body))
        return mapOf("x-susa-timestamp" to ts, "x-susa-signature" to "v1=$sig")
    }

    fun sha256Hex(body: ByteArray): String =
        hex(MessageDigest.getInstance("SHA-256").digest(body))

    private fun hex(bytes: ByteArray): String {
        val digits = "0123456789abcdef"
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val i = b.toInt() and 0xff
            sb.append(digits[i shr 4]); sb.append(digits[i and 0x0f])
        }
        return sb.toString()
    }
}
