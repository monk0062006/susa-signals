package com.susatest.signals

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.ServerSocket
import kotlin.concurrent.thread

/**
 * SPEC-174 integration: proves the Android `IngestClient` actually attaches a
 * correct signature to a real request over HttpURLConnection (not just that the
 * `Signing` helper is right).
 *
 * A local ServerSocket captures the raw request headers. Posting `{"a":1}` to
 * /v1/reports at ts 1700000000 is exactly the cross-language known-answer vector,
 * so the captured `x-susa-signature` must equal the value the server + web + iOS
 * tests also assert.
 */
class IngestClientSigningTest {

    /** Accepts one connection, returns the request headers, responds 201. */
    private fun captureOneRequest(server: ServerSocket): StringBuilder {
        val headers = StringBuilder()
        val t = thread {
            server.accept().use { sock ->
                val input = sock.getInputStream()
                while (true) {
                    val b = input.read()
                    if (b == -1) break
                    headers.append(b.toChar())
                    if (headers.length >= 4 && headers.substring(headers.length - 4) == "\r\n\r\n") break
                    if (headers.length > 8192) break
                }
                val body = "{\"id\":\"att\"}"
                sock.getOutputStream().apply {
                    write("HTTP/1.1 201 Created\r\nContent-Length: ${body.length}\r\n\r\n$body"
                        .toByteArray(Charsets.UTF_8))
                    flush()
                }
            }
        }
        // Return the builder now; the caller joins the thread after the client call.
        _serverThread = t
        return headers
    }

    private var _serverThread: Thread? = null

    @Test
    fun clientAttachesCorrectSignatureToRealRequest() {
        val server = ServerSocket(0)
        val headers = captureOneRequest(server)

        val secret = "0123456789abcdef0123456789abcdef".toByteArray(Charsets.UTF_8)
        IngestClient(
            "http://127.0.0.1:${server.localPort}", "proj-x",
            signingSecret = secret, nowSeconds = { 1700000000L },
        ).submit("{\"a\":1}", "idem-1")

        _serverThread?.join(5000)
        server.close()

        val req = headers.toString()
        assertTrue("x-project-id: $req", req.contains("x-project-id: proj-x", ignoreCase = true))
        assertTrue("x-susa-timestamp: $req", req.contains("x-susa-timestamp: 1700000000", ignoreCase = true))
        assertTrue(
            "known-answer signature: $req",
            req.contains(
                "x-susa-signature: v1=aeff4ef503c24cbd3d5a6f3554cf22905dea5f44b9d850e7322edd76d21c62d3",
                ignoreCase = true,
            ),
        )
    }

    @Test
    fun noSecretMeansNoSignatureHeader() {
        val server = ServerSocket(0)
        val headers = captureOneRequest(server)

        IngestClient("http://127.0.0.1:${server.localPort}", "proj-x").submit("{}", "k")

        _serverThread?.join(5000)
        server.close()

        assertFalse(headers.toString().contains("x-susa-signature", ignoreCase = true))
    }
}
