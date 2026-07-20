package io.markerusa.feedback

import java.io.BufferedOutputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * Hand-rolled multipart/form-data upload.
 *
 * The ingest API takes multipart because browsers send FormData; matching that on
 * native keeps one endpoint rather than two. Without an HTTP library this means
 * writing the envelope by hand — tedious but self-contained, and it keeps the
 * dependency count at zero.
 */
internal class MultipartUploader(
    endpoint: String,
    private val projectId: String,
    private val timeoutMs: Int = 30_000
) {
    private val endpoint = endpoint.trimEnd('/')

    /** Returns the server-assigned attachment id. */
    fun upload(bytes: ByteArray, filename: String): String {
        val boundary = "----markerio${System.nanoTime()}"
        var connection: HttpURLConnection? = null

        try {
            connection = (URL("$endpoint/v1/uploads").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                doOutput = true
                setRequestProperty("content-type", "multipart/form-data; boundary=$boundary")
                setRequestProperty("x-project-id", projectId)
                // Screenshots can be megabytes; streaming avoids buffering the whole
                // request in memory on a device that may be low on it.
                setChunkedStreamingMode(16 * 1024)
            }

            BufferedOutputStream(connection.outputStream).use { out ->
                out.write(
                    ("--$boundary\r\n" +
                        "Content-Disposition: form-data; name=\"file\"; filename=\"$filename\"\r\n" +
                        "Content-Type: image/png\r\n\r\n").toByteArray(Charsets.UTF_8)
                )
                out.write(bytes)
                out.write(
                    ("\r\n--$boundary\r\n" +
                        "Content-Disposition: form-data; name=\"kind\"\r\n\r\n" +
                        "screenshot\r\n" +
                        "--$boundary--\r\n").toByteArray(Charsets.UTF_8)
                )
                out.flush()
            }

            val status = connection.responseCode
            if (status !in 200..299) {
                connection.errorStream?.use { it.readBytes() }
                throw IngestException("Upload failed with $status", status, status >= 500)
            }

            val body = connection.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
            return extractId(body)
                ?: throw IngestException("Upload response missing id", status, false)
        } catch (e: IngestException) {
            throw e
        } catch (e: Exception) {
            throw IngestException(e.message ?: "Upload error", null, true)
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * Pulls `id` out of `{"id":"..."}` without a JSON parser.
     *
     * Narrow by design: this reads one known field from our own server's response,
     * not arbitrary JSON. Anything more complex belongs in a real parser.
     */
    private fun extractId(body: String): String? {
        val marker = "\"id\""
        val keyIndex = body.indexOf(marker)
        if (keyIndex < 0) return null

        val colon = body.indexOf(':', keyIndex + marker.length)
        if (colon < 0) return null

        val open = body.indexOf('"', colon)
        if (open < 0) return null

        val close = body.indexOf('"', open + 1)
        if (close < 0) return null

        return body.substring(open + 1, close).ifEmpty { null }
    }
}
