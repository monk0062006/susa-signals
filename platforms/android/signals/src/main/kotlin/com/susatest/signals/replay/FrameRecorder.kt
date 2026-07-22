package com.susatest.signals.replay

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.PixelCopy
import android.view.View
import com.susatest.signals.ConsentManager
import com.susatest.signals.ConsentScope
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Session replay for Android.
 *
 * rrweb records DOM mutations, which is why web replay is small and sharp. There
 * is no DOM here, so this captures frames instead — the approach UXCam and
 * Smartlook take. That difference drives every constraint below: frames are
 * expensive in CPU, battery and bandwidth in a way mutation records are not, so
 * the defaults are deliberately conservative.
 *
 * A researcher watching back at 1fps loses nothing that matters; a user whose
 * battery drains loses trust immediately.
 */
class FrameRecorder(
    private val consent: ConsentManager,
    private val uploader: FrameUploader,
    private val options: Options = Options(),
    private val log: (String) -> Unit = {},
) {
    data class Options(
        /** Frames per second. One is enough to follow intent; more is video. */
        val fps: Int = 1,
        /** Longest edge, in pixels. Downscaled from whatever the device is. */
        val maxEdge: Int = 480,
        /** JPEG quality. Frames are UI, not photographs. */
        val quality: Int = 55,
        /** Hard ceiling per session, so a forgotten tab cannot stream forever. */
        val maxFrames: Int = 900,
        /** Frames per uploaded chunk. */
        val chunkSize: Int = 15,
    )

    /** One captured frame, already masked and encoded. */
    data class Frame(val id: String, val timestampMs: Long, val jpeg: ByteArray, val width: Int, val height: Int)

    private val running = AtomicBoolean(false)
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var sessionId: String? = null
    private var frameCount = 0
    private var seq = 0
    private val pending = mutableListOf<Frame>()

    /** Weak-ish reference: cleared on stop so a finished Activity is not retained. */
    private var activity: Activity? = null

    fun getSessionId(): String? = sessionId

    /**
     * Starts recording, or does nothing if consent is absent.
     *
     * Returns the session id on success and null otherwise, so callers can
     * distinguish "recording" from "silently not recording" — a distinction that
     * matters when a researcher is waiting on data that will never arrive.
     */
    fun start(activity: Activity): String? {
        if (running.get()) return sessionId

        // The gate. Never record without an explicit, current grant.
        if (!consent.has(ConsentScope.SESSION_REPLAY)) {
            log("replay not started: no session_replay consent")
            return null
        }

        this.activity = activity
        sessionId = UUID.randomUUID().toString()
        frameCount = 0
        seq = 0
        running.set(true)

        // Dedicated thread: encoding a frame off the main thread is the whole
        // point, and reusing a shared executor would make jank depend on
        // whatever else the host app queued.
        val handlerThread = HandlerThread("susa-signals-replay").apply { start() }
        thread = handlerThread
        handler = Handler(handlerThread.looper)

        scheduleNext()
        log("replay started (session $sessionId)")
        return sessionId
    }

    /** Stops recording and flushes remaining frames as the final chunk. */
    fun stop() {
        if (!running.getAndSet(false)) return

        val h = handler
        val t = thread
        h?.removeCallbacksAndMessages(null)

        // Flush the final chunk on the replay thread, NOT the caller's thread.
        // stopRecording() is normally called from Activity.onPause() on the main
        // thread, and the chunk upload is network I/O — running it inline throws
        // NetworkOnMainThreadException, silently dropping the final chunk (and on
        // most sessions that is the ONLY chunk). Post it, then tear the thread
        // down once the flush has run.
        h?.post {
            flush(final = true)
            t?.quitSafely()
        }

        thread = null
        handler = null
        activity = null
        log("replay stopped")
    }

    /**
     * Stops and discards anything not yet uploaded. Called when consent is
     * withdrawn, at which point buffered frames must not be transmitted.
     */
    fun abandon() {
        running.set(false)
        handler?.removeCallbacksAndMessages(null)

        synchronized(pending) { pending.clear() }

        thread?.quitSafely()
        thread = null
        handler = null
        activity = null
        log("replay abandoned; buffered frames discarded")
    }

    // --- capture loop ---------------------------------------------------------

    private fun scheduleNext() {
        val intervalMs = (1000L / options.fps.coerceIn(1, 4))
        handler?.postDelayed({ captureFrame() }, intervalMs)
    }

    private fun captureFrame() {
        if (!running.get()) return

        if (frameCount >= options.maxFrames) {
            log("replay hit frame cap; stopping")
            stop()
            return
        }

        val target = activity ?: return
        // A finishing Activity has no valid surface; skip rather than crash.
        if (target.isFinishing || target.isDestroyed) return

        val decor = target.window?.decorView ?: return
        if (decor.width == 0 || decor.height == 0) {
            scheduleNext()
            return
        }

        // Sensitive regions must be read on the UI thread — view geometry is not
        // safe to touch from here — then applied during encoding off-thread.
        val regionsLatch = java.util.concurrent.CountDownLatch(1)
        var regions: List<Rect> = emptyList()
        target.runOnUiThread {
            regions = try {
                FrameMasker.sensitiveRegions(decor)
            } catch (e: Exception) {
                // Fail closed: if the hierarchy cannot be inspected we cannot
                // know what is sensitive, so the frame is dropped entirely.
                null
            } ?: emptyList<Rect>().also { running.set(false) }
            regionsLatch.countDown()
        }

        if (!regionsLatch.await(1, java.util.concurrent.TimeUnit.SECONDS)) {
            scheduleNext()
            return
        }
        if (!running.get()) {
            log("replay stopped: could not determine sensitive regions")
            return
        }

        val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PixelCopy.request(
                    target.window,
                    Rect(0, 0, decor.width, decor.height),
                    bitmap,
                    { result ->
                        if (result == PixelCopy.SUCCESS) {
                            encodeAndBuffer(bitmap, regions)
                        }
                        scheduleNext()
                    },
                    handler ?: Handler(Looper.getMainLooper()),
                )
                return
            } catch (e: IllegalArgumentException) {
                // Window not attached to a surface yet.
            }
        }

        drawFallback(decor, bitmap)
        encodeAndBuffer(bitmap, regions)
        scheduleNext()
    }

    private fun drawFallback(decor: View, bitmap: Bitmap) {
        try {
            // Software draw loses hardware-accelerated content, which is
            // acceptable for a recording but never for a redaction — masking is
            // applied after this, on top.
            decor.draw(Canvas(bitmap))
        } catch (e: Exception) {
            // Leave the frame blank rather than crash the host app.
        }
    }

    /** Masks, downscales and encodes. Runs on the recorder thread. */
    private fun encodeAndBuffer(source: Bitmap, regions: List<Rect>) {
        try {
            val scale = scaleFor(source.width, source.height)
            val width = (source.width * scale).toInt().coerceAtLeast(1)
            val height = (source.height * scale).toInt().coerceAtLeast(1)

            val scaled = Bitmap.createScaledBitmap(source, width, height, true)
            val canvas = Canvas(scaled)

            // Masking after downscale, using the same scale factor, so a region
            // cannot end up covering the wrong pixels.
            FrameMasker.apply(canvas, regions, scale)

            val out = ByteArrayOutputStream()
            // JPEG, not PNG: frames are photographic-ish and numerous, and PNG
            // would multiply the bandwidth for detail nobody watches.
            scaled.compress(Bitmap.CompressFormat.JPEG, options.quality, out)

            val frame = Frame(
                id = UUID.randomUUID().toString(),
                timestampMs = System.currentTimeMillis(),
                jpeg = out.toByteArray(),
                width = width,
                height = height,
            )

            source.recycle()
            if (scaled != source) scaled.recycle()

            frameCount++

            val ready: List<Frame>?
            synchronized(pending) {
                pending.add(frame)
                ready = if (pending.size >= options.chunkSize) pending.toList().also { pending.clear() } else null
            }
            ready?.let { upload(it, final = false) }
        } catch (e: OutOfMemoryError) {
            // A recorder must never be the reason a host app dies.
            log("replay frame dropped: out of memory")
            stop()
        } catch (e: Exception) {
            log("replay frame dropped: ${e.message}")
        }
    }

    private fun scaleFor(width: Int, height: Int): Float {
        val longest = maxOf(width, height)
        if (longest <= options.maxEdge) return 1f
        return options.maxEdge.toFloat() / longest
    }

    private fun flush(final: Boolean) {
        val ready: List<Frame>
        synchronized(pending) {
            ready = pending.toList()
            pending.clear()
        }
        if (ready.isNotEmpty() || final) upload(ready, final)
    }

    private fun upload(frames: List<Frame>, final: Boolean) {
        val session = sessionId ?: return
        val index = seq++

        try {
            uploader.upload(session, index, frames, final)
        } catch (e: Exception) {
            // Replay is explicitly best-effort: dropped rather than retried.
            // Persisting it would compete with the report outbox for storage,
            // and a gap in a recording is far cheaper than losing a report the
            // user actually wrote.
            log("replay chunk $index dropped: ${e.message}")
        }
    }
}
