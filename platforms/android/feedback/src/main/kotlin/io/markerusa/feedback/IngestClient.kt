package io.markerusa.feedback

import java.io.BufferedOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Distinguishes "retry later" from "never retry", exactly as the web client does. */
class IngestException(
    message: String,
    val status: Int?,
    val retryable: Boolean
) : Exception(message)

/**
 * The queue's dependency on the network, narrowed to one method.
 *
 * An interface rather than the concrete client so the outbox's failure handling —
 * the logic most worth testing — is testable on the JVM with no device, no server,
 * and no sockets.
 */
interface SubmissionTransport {
    fun submit(submissionJson: String, idempotencyKey: String)
}

/**
 * HTTP transport. Uses HttpURLConnection to keep the library dependency-free —
 * see the note in build.gradle.kts about SDKs and version conflicts.
 *
 * Every method here blocks. Callers are responsible for threading; the SDK never
 * assumes a coroutine scope or an executor belonging to the host app.
 */
class IngestClient(
    endpoint: String,
    private val projectId: String,
    private val timeoutMs: Int = 15_000
) : SubmissionTransport {
    private val endpoint = endpoint.trimEnd('/')

    override fun submit(submissionJson: String, idempotencyKey: String) {
        post("/v1/reports", submissionJson, mapOf("idempotency-key" to idempotencyKey))
    }

    fun sendReplayChunk(chunkJson: String) {
        post("/v1/replay/chunks", chunkJson, emptyMap())
    }

    private fun post(path: String, body: String, extraHeaders: Map<String, String>) {
        var connection: HttpURLConnection? = null
        try {
            connection = (URL("$endpoint$path").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("content-type", "application/json")
                setRequestProperty("x-project-id", projectId)
                extraHeaders.forEach { (k, v) -> setRequestProperty(k, v) }
            }

            BufferedOutputStream(connection.outputStream).use { out ->
                out.write(body.toByteArray(Charsets.UTF_8))
                out.flush()
            }

            val status = connection.responseCode
            if (status !in 200..299) {
                // 408/429 are client-status but genuinely transient.
                val retryable = status >= 500 || status == 408 || status == 429
                // Drain the error stream so the connection can be pooled rather
                // than torn down — otherwise every failure leaks a socket.
                connection.errorStream?.use { it.readBytes() }
                throw IngestException("Ingest failed with $status", status, retryable)
            }

            connection.inputStream.use { it.readBytes() }
        } catch (e: IngestException) {
            throw e
        } catch (e: Exception) {
            // No response reached us, so a retry is worth it.
            throw IngestException(e.message ?: "Network error", null, true)
        } finally {
            connection?.disconnect()
        }
    }
}
