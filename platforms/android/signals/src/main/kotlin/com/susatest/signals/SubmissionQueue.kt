package com.susatest.signals

/**
 * Durable outbox, mirroring `ReportQueue` in core.
 *
 * Stores the *already-serialized* submission and replays that exact string. This
 * is why the library needs no JSON parser: a queued submission is opaque bytes to
 * be re-POSTed, not an object to be reconstructed. It also means a schema change
 * can never strand queued items behind a deserialization failure.
 *
 * Retries are scheduled per item with exponential backoff rather than counted per
 * flush. Without that, filing several reports during one outage burns every
 * queued item's attempt budget within seconds — the queue would discard reports
 * minutes into an outage it was built to survive for days.
 */
class SubmissionQueue(
    private val storage: KeyValueStore,
    private val client: SubmissionTransport,
    private val now: () -> Long = System::currentTimeMillis
) {
    private companion object {
        const val PREFIX = "susa.signals.outbox."
        const val ATTEMPTS_PREFIX = "susa.signals.attempts."
        const val NEXT_ATTEMPT_PREFIX = "susa.signals.nextAttempt."
        const val MAX_QUEUED = 20
        const val MAX_ATTEMPTS = 8
        const val BASE_BACKOFF_MS = 30_000L
        /** Ceiling so a long-queued item still retries a few times a day. */
        const val MAX_BACKOFF_MS = 6 * 60 * 60 * 1000L
        /** Wide enough for millisecond epochs well past the year 5000. */
        const val STAMP_WIDTH = 13
    }

    data class FlushResult(val sent: Int, val remaining: Int)

    /** Persist first, deliver second. Never throws on network failure. */
    fun enqueue(id: String, submissionJson: String): FlushResult {
        // Key embeds a zero-padded timestamp so lexicographic order IS chronological
        // order. Keying by UUID alone would make "evict oldest" evict at random.
        val key = "$PREFIX${now().toString().padStart(STAMP_WIDTH, '0')}.$id"
        storage.set(key, submissionJson)
        storage.set("$ATTEMPTS_PREFIX$id", "0")
        storage.set("$NEXT_ATTEMPT_PREFIX$id", "0") // due immediately
        evictOverflow()
        return flush()
    }

    fun flush(): FlushResult {
        // Oldest first, so a persistent failure at the head cannot starve the tail
        // of its retry budget.
        val keys = storage.keys(PREFIX).sorted()
        val currentTime = now()
        var sent = 0

        for (key in keys) {
            val id = idFromKey(key) ?: continue

            // Not yet due. Skipping is what stops rapid flushes from consuming the
            // retry budget of items that have not had a fair chance to succeed.
            val dueAt = storage.get("$NEXT_ATTEMPT_PREFIX$id")?.toLongOrNull() ?: 0L
            if (currentTime < dueAt) continue

            val body = storage.get(key) ?: continue
            val attempts = storage.get("$ATTEMPTS_PREFIX$id")?.toIntOrNull() ?: 0

            try {
                client.submit(body, id)
                drop(key, id)
                sent++
            } catch (e: IngestException) {
                val next = attempts + 1
                // Drop permanently-rejected items and ones we have given up on, so
                // a single poison submission cannot block everything behind it.
                if (!e.retryable || next >= MAX_ATTEMPTS) {
                    drop(key, id)
                } else {
                    storage.set("$ATTEMPTS_PREFIX$id", next.toString())
                    storage.set("$NEXT_ATTEMPT_PREFIX$id", (currentTime + backoffFor(next)).toString())
                }
            }
        }

        return FlushResult(sent, storage.keys(PREFIX).size)
    }

    fun size(): Int = storage.keys(PREFIX).size

    /** 30s, 1m, 2m, 4m … capped at 6h. */
    private fun backoffFor(attempts: Int): Long {
        // Shift rather than pow, and clamp the exponent so it cannot overflow.
        val exponent = (attempts - 1).coerceIn(0, 20)
        val delay = BASE_BACKOFF_MS shl exponent
        return if (delay <= 0 || delay > MAX_BACKOFF_MS) MAX_BACKOFF_MS else delay
    }

    /** Key layout: `susa.signals.outbox.<13-digit stamp>.<uuid>` */
    private fun idFromKey(key: String): String? =
        key.removePrefix(PREFIX).substringAfter('.', "").ifEmpty { null }

    private fun drop(key: String, id: String) {
        storage.remove(key)
        storage.remove("$ATTEMPTS_PREFIX$id")
        storage.remove("$NEXT_ATTEMPT_PREFIX$id")
    }

    /**
     * Drops oldest-first on overflow. A stale report is worth less than the fresh
     * one the user just took the trouble to write.
     */
    private fun evictOverflow() {
        val keys = storage.keys(PREFIX).sorted()
        if (keys.size <= MAX_QUEUED) return
        keys.take(keys.size - MAX_QUEUED).forEach { key ->
            idFromKey(key)?.let { drop(key, it) }
        }
    }
}
