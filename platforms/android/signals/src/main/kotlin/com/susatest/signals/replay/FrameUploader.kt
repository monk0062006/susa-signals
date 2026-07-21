package com.susatest.signals.replay

import com.susatest.signals.IngestClient
import com.susatest.signals.JsonWriter
import com.susatest.signals.MultipartUploader

/** Seam so the recorder can be tested without a network. */
interface FrameUploader {
    fun upload(sessionId: String, seq: Int, frames: List<FrameRecorder.Frame>, final: Boolean)
}

/**
 * Ships frames to the ingest service.
 *
 * Each frame goes to the existing attachments endpoint as a JPEG, and the
 * replay chunk carries only references and timestamps. Embedding the images in
 * the chunk JSON would mean base64, inflating every frame by a third for no
 * benefit, and would push chunks past any sane request size.
 *
 * Reusing `/v1/uploads` also means native frames inherit the same storage,
 * retention and erasure paths as screenshots rather than needing their own.
 */
internal class HttpFrameUploader(
    private val endpoint: String,
    private val projectId: String,
    private val client: IngestClient,
) : FrameUploader {

    override fun upload(
        sessionId: String,
        seq: Int,
        frames: List<FrameRecorder.Frame>,
        final: Boolean,
    ) {
        val uploader = MultipartUploader(endpoint, projectId)

        // Upload images first: a chunk referencing an attachment that failed to
        // store would point at nothing, which is worse than a missing frame.
        val stored = mutableListOf<Pair<FrameRecorder.Frame, String>>()
        for (frame in frames) {
            try {
                val id = uploader.upload(frame.jpeg, "frame-${frame.id}.jpg", "image/jpeg")
                stored.add(frame to id)
            } catch (e: Exception) {
                // Skip this frame; the recording keeps its shape with a gap.
            }
        }

        if (stored.isEmpty() && !final) return

        val startedAt = frames.firstOrNull()?.timestampMs ?: System.currentTimeMillis()
        val endedAt = frames.lastOrNull()?.timestampMs ?: startedAt

        val json = JsonWriter().obj {
            str("sessionId", sessionId)
            str("projectId", projectId)
            num("seq", seq)
            array("events", stored) { (frame, attachmentId) ->
                // `type` mirrors the web recorder's event envelope so the
                // dashboard can branch on one field rather than sniffing shape.
                str("type", "frame")
                num("timestamp", frame.timestampMs)
                str("attachmentId", attachmentId)
                num("width", frame.width)
                num("height", frame.height)
            }
            num("startedAt", startedAt)
            num("endedAt", endedAt)
            bool("final", final)
        }.toString()

        client.sendReplayChunk(json)
    }
}
